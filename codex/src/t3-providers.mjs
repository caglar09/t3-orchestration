import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALLOWED_TIERS = Object.freeze(["simple", "standard", "complex"]);
export const ALLOWED_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
export const DEFAULT_EFFORT_BY_TIER = Object.freeze({
  simple: "low",
  standard: "medium",
  complex: "high",
});

const SIMPLE_MODEL_RE = /(?:^|[-_.])(flash|mini|haiku|nano|lite|small|fast|low)(?:$|[-_.])/i;
const COMPLEX_MODEL_RE = /(?:^|[-_.])(opus|pro|carbon|sol|astra|fable|xhigh|high)(?:$|[-_.])/i;

export function defaultT3SettingsPath() {
  return path.join(os.homedir(), ".t3", "userdata", "settings.json");
}

export function defaultT3ManifestPath() {
  return path.join(os.homedir(), ".t3", "userdata", "model-manifest.json");
}

export function classifyModelTier(modelSlug) {
  const slug = String(modelSlug ?? "").trim();
  if (!slug) return "standard";
  if (SIMPLE_MODEL_RE.test(slug)) return "simple";
  if (COMPLEX_MODEL_RE.test(slug)) return "complex";
  return "standard";
}

function readJsonSafe(filePath, { required = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`T3 settings file not found: ${filePath}`);
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (required) {
      throw new Error(`Malformed JSON in ${filePath}: ${err.message}`);
    }
    return null;
  }
}

function modelsForDriver(manifestRoot, driver) {
  const manifest = manifestRoot?.manifest ?? manifestRoot;
  if (!manifest || typeof manifest !== "object") return [];

  const providerEntry = manifest.providers?.[driver];
  const rawModels = Array.isArray(providerEntry?.models)
    ? providerEntry.models
    : Array.isArray(providerEntry)
      ? providerEntry
      : [];

  const bySlug = new Map();
  for (const item of rawModels) {
    if (!item || typeof item !== "object" || typeof item.slug !== "string" || !item.slug.trim()) {
      continue;
    }
    bySlug.set(item.slug, {
      slug: item.slug,
      name: typeof item.name === "string" && item.name.trim() ? item.name : item.slug,
      status: typeof item.status === "string" ? item.status : "unknown",
      tier: classifyModelTier(item.slug),
    });
  }

  const currentSlugs = Array.isArray(manifest.currentModels?.[driver])
    ? manifest.currentModels[driver].filter((s) => typeof s === "string" && s.trim())
    : [];

  const ordered = [];
  const seen = new Set();
  for (const slug of currentSlugs) {
    seen.add(slug);
    ordered.push(
      bySlug.get(slug) ?? {
        slug,
        name: slug,
        status: "current",
        tier: classifyModelTier(slug),
      },
    );
  }
  for (const [slug, meta] of bySlug.entries()) {
    if (!seen.has(slug)) {
      ordered.push(meta);
    }
  }
  return ordered;
}

export function readT3Providers({
  settingsPath = defaultT3SettingsPath(),
  manifestPath = defaultT3ManifestPath(),
} = {}) {
  const settings = readJsonSafe(settingsPath, { required: true });
  const manifest = readJsonSafe(manifestPath, { required: false });
  const instances = settings?.providerInstances;
  if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
    return { providers: [] };
  }

  const providers = [];
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") continue;
    if (instance.enabled === false) continue;
    const driver = typeof instance.driver === "string" && instance.driver.trim()
      ? instance.driver.trim()
      : instanceId;
    const label = typeof instance.displayName === "string" && instance.displayName.trim()
      ? instance.displayName.trim()
      : instanceId;
    providers.push({
      instanceId,
      driver,
      label,
      enabled: true,
      models: modelsForDriver(manifest, driver),
    });
  }

  return { providers };
}

function buildSelection(instanceId, model, effort) {
  return {
    instanceId,
    ...(model ? { model } : {}),
    options: [{ id: "effort", value: effort }],
  };
}

export function selectModelForTask({
  providers,
  tier = "standard",
  preferredDriver = null,
  routingPolicy = null,
} = {}) {
  if (!ALLOWED_TIERS.includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Expected one of: ${ALLOWED_TIERS.join(", ")}.`);
  }
  const enabledProviders = (Array.isArray(providers) ? providers : []).filter(
    (p) => p && p.enabled !== false && typeof p.instanceId === "string" && p.instanceId.trim(),
  );
  if (enabledProviders.length === 0) {
    throw new Error("No enabled T3 provider instances available.");
  }

  const defaultEffort = DEFAULT_EFFORT_BY_TIER[tier];

  // 1. Explicit project routing policy takes precedence if instance is still enabled.
  const policyEntry = routingPolicy?.tiers?.[tier];
  if (policyEntry && typeof policyEntry.instanceId === "string") {
    const matched = enabledProviders.find((p) => p.instanceId === policyEntry.instanceId);
    if (matched) {
      const effort = ALLOWED_EFFORTS.includes(policyEntry.effort) ? policyEntry.effort : defaultEffort;
      return {
        tier,
        source: "policy",
        reason: `Configured project policy for "${tier}" tier.`,
        provider: { instanceId: matched.instanceId, driver: matched.driver, label: matched.label },
        modelSelection: buildSelection(matched.instanceId, policyEntry.model || null, effort),
      };
    }
  }

  // Order providers so preferredDriver (if given) is checked first.
  const orderedProviders = preferredDriver
    ? [
        ...enabledProviders.filter((p) => p.driver === preferredDriver || p.instanceId === preferredDriver),
        ...enabledProviders.filter((p) => p.driver !== preferredDriver && p.instanceId !== preferredDriver),
      ]
    : enabledProviders;

  // 2. Exact tier heuristic match across enabled provider models.
  for (const provider of orderedProviders) {
    const match = (provider.models ?? []).find(
      (m) => (m.tier ?? classifyModelTier(m.slug)) === tier,
    );
    if (match) {
      return {
        tier,
        source: "heuristic",
        reason: `Matched "${match.slug}" (${provider.label}) for "${tier}" tier.`,
        provider: { instanceId: provider.instanceId, driver: provider.driver, label: provider.label },
        modelSelection: buildSelection(provider.instanceId, match.slug, defaultEffort),
      };
    }
  }

  // 3. Fallback: first enabled provider with any model, or provider default.
  const withModel = orderedProviders.find((p) => Array.isArray(p.models) && p.models.length > 0);
  const chosen = withModel ?? orderedProviders[0];
  const fallbackModel = withModel ? withModel.models[0].slug : null;
  return {
    tier,
    source: "fallback",
    reason: fallbackModel
      ? `No exact "${tier}" model found; falling back to "${fallbackModel}" (${chosen.label}).`
      : `Provider "${chosen.label}" has no manifest models; using its default model with effort="${defaultEffort}".`,
    provider: { instanceId: chosen.instanceId, driver: chosen.driver, label: chosen.label },
    modelSelection: buildSelection(chosen.instanceId, fallbackModel, defaultEffort),
  };
}

function slugifyTopic(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "task";
}

export function buildWorkerBrief({
  projectName,
  coordinatorThreadId,
  taskTitle,
  brief,
  isClaudeWorker = false,
  routing = null,
  projectRules = "",
} = {}) {
  if (!projectName || !String(projectName).trim()) {
    throw new Error("projectName is required to build a worker brief.");
  }
  if (!coordinatorThreadId || !String(coordinatorThreadId).trim()) {
    throw new Error("coordinatorThreadId is required to build a worker brief.");
  }
  if (!brief || !String(brief).trim()) {
    throw new Error("brief is required to build a worker brief.");
  }

  const title = String(taskTitle ?? "Worker task").trim();
  const topicSlug = slugifyTopic(title);
  const selectionNote = routing?.modelSelection
    ? `Selected route: tier=${routing.tier ?? "standard"}, instanceId=${routing.modelSelection.instanceId}, model=${routing.modelSelection.model ?? "default"}, effort=${routing.modelSelection.options?.[0]?.value ?? "medium"}.`
    : null;

  const lines = [
    `[T3O_WORKER_V1] You are a worker thread for project "${projectName}" created by coordinator ${coordinatorThreadId}.`,
    ...(selectionNote ? [selectionNote] : []),
    "",
    `## Task: ${title}`,
    String(brief).trim(),
    "",
    "## Working Rules",
    "- Stay strictly within this brief; report findings, options, and evidence clearly.",
    "- End every final answer with: real state, concrete evidence, and exact next step or question for the user.",
    "- Never claim a delivery or verification you did not actually run.",
  ];

  if (isClaudeWorker) {
    lines.push(
      "- Automatic notification: the T3 Claude Stop hook notifies the coordinator when your turn ends. Do NOT send a duplicate t3_thread_send report.",
    );
  } else {
    lines.push(
      "",
      "## Mandatory Wake-Up Report (Non-Claude Worker)",
      "When you finish, hit a blocker, or need user approval, wake up the coordinator by calling `t3_thread_send` ONCE per phase:",
      "```json",
      JSON.stringify(
        {
          threadId: coordinatorThreadId,
          mode: "queue",
          clientRequestId: `t3o-report:${topicSlug}:done`,
          message: `✅ "${title}" finished a turn — <3-5 line concise status & evidence> [T3O_SIGNAL_V1]`,
        },
        null,
        2,
      ),
      "```",
      "- Use a distinct phase suffix in `clientRequestId` (`:blocked`, `:needs-approval`, `:done`) so retries remain idempotent.",
      "- Keep the message to 3-5 lines ending with `[T3O_SIGNAL_V1]`; detailed output stays in this thread.",
    );
  }

  if (projectRules && String(projectRules).trim()) {
    lines.push("", "## Project Rules", String(projectRules).trim());
  }

  return lines.join("\n");
}
