"""TASK-00 disposable probe. No inference unless --live is supplied."""
import argparse
import json
import os
import queue
import subprocess
import tempfile
import threading
import time


class Probe:
    def __init__(self, executable, cwd):
        env = dict(os.environ)
        env.pop("OPENAI_API_KEY", None)
        self.proc = subprocess.Popen(
            [executable, "app-server"], cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self.messages = queue.Queue()
        self.events = {}
        self.seq = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            for line in self.proc.stdout:
                self.messages.put(json.loads(line))
        except (ValueError, OSError):
            self.messages.put(None)
        finally:
            self.messages.put(None)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def next(self, deadline):
        message = self.messages.get(timeout=max(0, deadline - time.monotonic()))
        if message is None:
            raise RuntimeError("server closed or malformed JSON")
        if "method" in message and "id" in message:
            # No approval or other server-initiated request is accepted.
            self.send({"id": message["id"], "error": {"code": -32601, "message": "Probe does not accept server requests"}})
            raise RuntimeError("unexpected server request; probe stopped")
        if message.get("method") == "turn/completed":
            params = message.get("params", {})
            turn = params.get("turn", {})
            self.events[(params.get("threadId"), turn.get("id"))] = turn.get("status")
        return message

    def request(self, method, params=None):
        self.seq += 1
        ident = self.seq
        self.send({"id": ident, "method": method, "params": params or {}})
        deadline = time.monotonic() + 30
        while True:
            message = self.next(deadline)
            if message.get("id") == ident:
                if "error" in message:
                    raise RuntimeError(f"{method}: RPC rejected (code {message['error'].get('code')})")
                print(f"PASS RPC {method}", flush=True)
                return message["result"]

    def completed(self, thread_id, turn_id):
        key = (thread_id, turn_id)
        deadline = time.monotonic() + 120
        while key not in self.events:
            self.next(deadline)
        status = self.events.pop(key)
        print(f"terminal status: {status}", flush=True)
        if status != "completed":
            raise RuntimeError("test turn did not complete")

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdin.close()
        self.proc.stdout.close()


def run(args):
    with tempfile.TemporaryDirectory(prefix="t3o-probe-") as cwd:
        probe = Probe(args.codex, cwd)
        try:
            probe.request("initialize", {"clientInfo": {"name": "t3o_contract_probe", "version": "0.1.0"}})
            probe.send({"method": "initialized", "params": {}})
            account = probe.request("account/read").get("account") or {}
            if account.get("type") != "chatgpt":
                raise RuntimeError("ChatGPT-managed login not confirmed; no inference attempted")
            limits = probe.request("account/rateLimits/read")
            print("rate-limit response present:", bool(limits.get("rateLimits")), flush=True)
            if not args.live:
                print("Account-only probe; no threads created.")
                return
            thread = probe.request("thread/start", {"cwd": cwd, "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": False})["thread"]
            thread_id = thread["id"]
            print("Local synthetic thread ID (redact before sharing):", thread_id, flush=True)
            if thread.get("modelProvider") != "openai":
                raise RuntimeError("OpenAI model provider not confirmed; no inference attempted")
            policy = {"threadId": thread_id, "approvalPolicy": "never", "sandboxPolicy": {"type": "readOnly"}}
            result = probe.request("turn/start", dict(policy, input=[{"type": "text", "text": "Reply with TASK00_PROBE_OK only. Do not call any tools."}]))
            probe.completed(thread_id, result["turn"]["id"])
            result = probe.request("turn/start", dict(policy, input=[], toolOutput={"name": "task00_worker_probe", "output": "Synthetic worker completed. No tools or action needed."}))
            probe.completed(thread_id, result["turn"]["id"])
            probe.request("thread/read", {"threadId": thread_id})
            page = probe.request("thread/turns/list", {"threadId": thread_id, "limit": 1, "itemsView": "notLoaded"})
            cursor = page.get("nextCursor")
            if not cursor:
                raise RuntimeError("two-turn pagination cursor absent")
            probe.request("thread/turns/list", {"threadId": thread_id, "limit": 1, "cursor": cursor, "itemsView": "notLoaded"})
            probe.request("thread/resume", {"threadId": thread_id, "excludeTurns": True})
            print("Owned-server probe finished. Desktop visibility, identity, idle cross-client wake and restart are still manual gates.")
        finally:
            probe.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--live", action="store_true", help="Create a persistent synthetic thread and run two turns; may consume plan quota/credits.")
    args = parser.parse_args()
    try:
        run(args)
    except (OSError, RuntimeError, queue.Empty, KeyError) as error:
        # Never print server payloads or raw account information.
        print("BLOCKED:", str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
