#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "../src/config.mjs";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Generates a single-use out-of-band pairing ticket stored at `<stateRoot>/pairing.json` (0600).
 * Returns the plaintext pairing code once for operator entry into `project_setup`.
 */
export function createPairingTicket({
  stateRoot = path.dirname(defaultConfigPath()),
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof stateRoot !== "string" || stateRoot.trim().length === 0) {
    throw new Error("stateRoot must be a non-empty path.");
  }
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive number.");
  }

  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);

  const pairingCode = randomBytes(24).toString("base64url");
  const codeHash = createHash("sha256").update(pairingCode, "utf8").digest("hex");
  const createdAt = now();
  const expiresAt = createdAt + ttlMs;
  const pairingPath = path.join(stateRoot, "pairing.json");
  const tmpPath = path.join(stateRoot, `.pairing.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);

  const payload = `${JSON.stringify({
    version: 1,
    codeHash,
    createdAt,
    expiresAt,
    consumed: false,
  }, null, 2)}\n`;

  let fd;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, pairingPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore missing temp file during cleanup.
    }
    throw err;
  }

  return {
    pairingCode,
    pairingPath,
    createdAt,
    expiresAt,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  let stateRoot = path.dirname(defaultConfigPath(os.homedir()));
  let ttlMs = DEFAULT_TTL_MS;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--state-root" && args[i + 1]) {
      stateRoot = path.resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === "--ttl-ms" && args[i + 1]) {
      ttlMs = Number(args[i + 1]);
      i += 1;
    }
  }

  const ticket = createPairingTicket({ stateRoot, ttlMs });
  process.stdout.write(`${JSON.stringify({
    pairingCode: ticket.pairingCode,
    pairingPath: ticket.pairingPath,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    nextStep: "Set T3O_CODEX_HOST_SESSION_ID for the coordinator MCP session and invoke project_setup with this single-use pairingCode.",
  }, null, 2)}\n`);
}
