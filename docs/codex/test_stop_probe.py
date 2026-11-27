import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import task00_remaining as probe


class StopProbeTests(unittest.TestCase):
    def test_stop_hook_has_a_distinct_schema_compatible_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'workspace'
            probe.prepare(root, mode='direct')
            hooks = json.loads((root / '.codex/hooks.json').read_text())['hooks']
            handler = hooks['Stop'][0]['hooks'][1]
            self.assertEqual(handler['tool'], 'stop_probe')
            args = {'origin': 'hook', 'session_id': 'fake', 'turn_id': 'fake-turn'}
            requests = [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'stop_probe', 'arguments': args}},
                {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'echo_probe', 'arguments': args}},
            ]
            proc = subprocess.run([sys.executable, str(root / '.codex/probe.py'), 'mcp', str(root)],
                                  input='\n'.join(map(json.dumps, requests))+'\n', text=True, capture_output=True, check=True)
            replies = list(map(json.loads, proc.stdout.splitlines()))
            self.assertEqual({t['name'] for t in replies[1]['result']['tools']}, {'echo_probe', 'stop_probe'})
            stop = replies[2]['result']
            self.assertEqual(stop['structuredContent'], {'continue': True})
            self.assertEqual(json.loads(stop['content'][0]['text']), {'continue': True})
            self.assertEqual(replies[3]['result']['structuredContent'], {'marker': 'TASK00_MCP_OK', 'authenticated': False})
            calls = [r for r in map(json.loads, (root / 'events.jsonl').read_text().splitlines()) if r['kind'] == 'mcp_call']
            self.assertEqual([r['tool'] for r in calls], ['stop_probe', 'echo_probe'])
            self.assertEqual([r['claimed_origin'] for r in calls], ['hook', 'hook'])


if __name__ == '__main__':
    unittest.main()
