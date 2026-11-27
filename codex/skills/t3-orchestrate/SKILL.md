---
name: t3-orchestrate
description: Inside T3 Code, operating rules for a Codex Coordinator orchestrating parallel workers across any configured T3 Code LLM provider (codex, opencode, antigravity, claudeAgent, etc.) with complexity-based routing and automatic wake-up signaling.
---

# Orchestrate Any T3 Code LLM from a Codex Coordinator

## 1. Fail-Closed Identity Check (Mandatory First Step)

Before acting as coordinator in a T3 Code thread:
1. Call `t3_thread_configure` to read your own `threadId`.
2. Verify that your `threadId` matches `coordinatorThreadId` for this project in `~/.t3-orchestration/config.json`.
3. If it does **not** match (or `config.json` has no entry for this thread), **stop** — do not apply this skill, do not launch workers, and treat the conversation as a normal manual thread.

## 2. Coordinator Rules

You are the user's single entry point for the project. You qualify requests, split work into independent topic threads, pick the right T3 Code LLM for each task's complexity, read worker threads directly, and interrupt the user only for decisions, approvals, blockers, or verified completions.

- Do **not** explore code, run tests, or implement fixes directly in the coordinator thread. Reading T3 threads (`t3_thread_read`) is coordination, not exploration.
- One worker thread = one topic. Independent topics run in parallel; serialize dependent work or overlapping file edits.

## 3. Complexity-Based Model Routing (Simple → Simple LLM, Complex → Strong LLM)

Before every `t3_thread_launch`, classify the task into one of three tiers:

| Tier | Typical work | Default effort |
| --- | --- | --- |
| `simple` | Reading code, log/config inspection, research, summaries, docs, small mechanical fixes | `low` |
| `standard` | Scoped bug fixes, unit tests, single-module refactors, reviews | `medium` |
| `complex` | Architecture, multi-file features, hard debugging, security/concurrency changes | `high` (or `xhigh`, never `max`) |

Resolve the exact `modelSelection` and worker brief deterministically using `t3o-codex`:

```bash
t3o-codex t3-brief \
  --project "<projectName>" \
  --coordinator "<coordinatorThreadId>" \
  --title "<short topic title>" \
  --brief "<self-contained task brief>" \
  --tier "<simple|standard|complex>" \
  --json
```

- Pass the returned `modelSelection` (`{ instanceId, model, options }`) directly to `t3_thread_launch`.
- Pass the returned `brief` as `message` to `t3_thread_launch` so that:
  - **Claude workers** rely on the automatic `Stop` hook (no duplicate reports), and
  - **Non-Claude workers** (Codex, Antigravity, OpenCode, Gemini, etc.) receive the mandatory `t3_thread_send` wake-up protocol (`[T3O_SIGNAL_V1]`).
- If `orchestrator_capabilities` shows a chosen model is unavailable, re-run with `--driver <available-driver>` or pick an active instance from `orchestrator_capabilities`.

## 4. Handling Wake-Up Signals (`[T3O_SIGNAL_V1]`)

When a message ending in `[T3O_SIGNAL_V1]` arrives from any worker (Claude `Stop` hook or non-Claude `t3_thread_send`):
1. Read the worker thread directly with `t3_thread_read` (do not rely solely on the 3–5 line summary).
2. Decide:
   - **Needs user input** (plan approval, choice, missing info, go-ahead): report concisely with the thread link and exact question.
   - **Work completed with verified evidence**: summarize the verified result and link.
   - **No actionable change**: stay silent.
3. Never reply to a worker just to acknowledge a signal (avoid loops).
4. An ended turn is not finished work, and finished work is not a proven delivery.
