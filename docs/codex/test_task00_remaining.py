import unittest
from pathlib import Path
import tempfile
import json
import subprocess
import sys
import task00_remaining as p

class TestProbe(unittest.TestCase):
    def test_hook_scope_and_redaction(self):
        root = '/tmp/test-only'
        event = {'cwd': root, 'hook_event_name':'UserPromptSubmit', 'session_id':'secret-id', 'turn_id':'turn-secret', 'prompt':'private'}
        record, output = p.hook_record(event, root, 'salt')
        self.assertEqual(record['event'], 'UserPromptSubmit')
        self.assertNotIn('secret-id', json.dumps(record))
        self.assertNotIn('private', json.dumps(record))
        self.assertIn('additionalContext', output['hookSpecificOutput'])
        self.assertEqual(p.hook_record(dict(event, cwd='/tmp/unrelated'), root, 'salt'), (None, {}))
    def test_echo_never_authenticates_claim(self):
        result, record = p.echo_record({'session_id':'secret', 'origin':'hook'}, {'caller':'private'}, 'salt')
        self.assertFalse(result['authenticated'])
        self.assertEqual(record['meta_keys'], ['caller'])
        self.assertNotIn('private', json.dumps(record))
        self.assertNotIn('secret', json.dumps(record))
    def test_prepare_creates_isolated_plugin(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/'workspace'
            p.prepare(root)
            manifest = json.loads((root/'plugins/t3o-task00-probe/plugin.json').read_text())
            self.assertEqual(manifest['name'], 't3o-task00-probe')
            self.assertTrue((root/'.agents/plugins/marketplace.json').is_file())
            with self.assertRaises(FileExistsError): p.prepare(root)
    def test_mcp_protocol(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/'workspace'; p.prepare(root)
            requests = [{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26'}}, {'jsonrpc':'2.0','id':2,'method':'tools/list'}, {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'echo_probe','arguments':{'session_id':'fake'}}}]
            run = subprocess.run([sys.executable,str(Path(p.__file__).resolve()),'mcp',str(root)],input='\n'.join(map(json.dumps, requests))+'\n',text=True,capture_output=True,check=True)
            replies = list(map(json.loads,run.stdout.splitlines()))
            self.assertEqual(replies[0]['result']['protocolVersion'],'2025-03-26')
            self.assertEqual(replies[1]['result']['tools'][0]['name'],'echo_probe')
            self.assertFalse(replies[2]['result']['structuredContent']['authenticated'])

    def test_direct_mode_has_no_plugin_dependency(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/'workspace'
            p.prepare(root, mode='direct')
            self.assertFalse((root/'.agents/plugins/marketplace.json').exists())
            self.assertFalse((root/'plugins').exists())
            self.assertTrue((root/'.codex/probe.py').is_file())
            config = (root/'.codex/config.toml').read_text()
            self.assertIn('[mcp_servers.t3o_probe]', config)
            self.assertNotIn('[plugins.', config)
            hooks = json.loads((root/'.codex/hooks.json').read_text())['hooks']
            self.assertEqual(hooks['Interrupt'][0]['hooks'][0]['timeout'], 3)
            self.assertEqual(hooks['Stop'][0]['hooks'][1]['server'], 't3o_probe')
    def test_plugin_interrupt_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/'workspace'
            p.prepare(root)
            hooks = json.loads((root/'plugins/t3o-task00-probe/hooks/hooks.json').read_text())['hooks']
            self.assertEqual(hooks['Interrupt'][0]['hooks'][0]['timeout'], 3)

if __name__=='__main__': unittest.main()
