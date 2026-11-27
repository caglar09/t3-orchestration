"""Disposable TASK-00 diagnostic: no production authorization or global config edits."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
import tempfile
import time

NAME = 't3o-task00-probe'
EVENTS = ('SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'Interrupt')
IDS = ('session_id', 'thread_id', 'turn_id', 'agent_id')


def digest(value, salt):
    return hmac.new(salt.encode(), value.encode(), hashlib.sha256).hexdigest()[:16] if isinstance(value, str) and value else None


def hook_record(event, root, salt):
    name = event.get('hook_event_name')
    if name not in EVENTS or os.path.realpath(event.get('cwd') or '/') != os.path.realpath(root):
        return None, {}
    record = {'kind': 'command_hook', 'event': name, 'keys': sorted(event),
              'ids': {key: digest(event.get(key), salt) for key in IDS}}
    output = {'hookSpecificOutput': {'hookEventName': name, 'additionalContext': 'TASK00_HOOK_CONTEXT_OK'}} if name == 'UserPromptSubmit' else {}
    return record, output


def echo_record(args, meta, salt):
    record = {'kind': 'mcp_call', 'argument_keys': sorted(args), 'meta_keys': sorted(meta),
              'claimed_ids': {key: digest(args.get(key), salt) for key in IDS},
              'host_ids': {'session_id': digest(meta.get('sessionId'), salt),
                           'thread_id': digest(meta.get('threadId'), salt)},
              'claimed_origin': args.get('origin') if args.get('origin') in ('hook', 'direct') else 'other'}
    return {'marker': 'TASK00_MCP_OK', 'authenticated': False}, record


def append(root, record):
    record = dict(record, pid=os.getpid(), ts=int(time.time()))
    fd = os.open(root/'events.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(json.dumps(record, separators=(',', ':'))+'\n')


def prepare(root, mode='plugin'):
    if mode not in ('plugin', 'direct', 'legacy'):
        raise ValueError('unknown diagnostic mode')
    root = root.resolve()
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    (root/'.codex').mkdir()
    name = 't3o-task00-compat' if mode == 'legacy' else NAME
    marketplace = 't3o-task00-compat-local' if mode == 'legacy' else 't3o-task00-local'
    plugin = root/'plugins'/name if mode != 'direct' else root/'.codex'
    if mode != 'direct':
        (plugin/'hooks').mkdir(parents=True)
        (root/'.agents/plugins').mkdir(parents=True)
    (root/'salt').write_text(secrets.token_hex(32)); (root/'salt').chmod(0o600)
    shutil.copyfile(__file__, plugin/'probe.py')
    def write(path, data): path.write_text(json.dumps(data, indent=2)+'\n')
    if mode != 'direct':
        write(root/'.agents/plugins/marketplace.json', {'name':marketplace,'plugins':[{'name':name,'source':{'source':'local','path':'./plugins/'+name},'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'},'category':'Productivity'}]})
        (root/'.codex/config.toml').write_text('[plugins."'+name+'@'+marketplace+'"]\nenabled = true\n')
        if mode == 'legacy':
            # v0.171.0 skips portable AgentPlugin hooks and rejects absolute
            # stdio executables in portable mcp.json. Use the native format.
            (plugin/'.codex-plugin').mkdir()
            write(plugin/'.codex-plugin/plugin.json', {'name':name,'version':'0.1.1','description':'Disposable Codex native diagnostic','mcpServers':'./.mcp.json','hooks':'./hooks/hooks.json','interface':{'displayName':'T3O TASK-00 Compatibility Probe','shortDescription':'Local diagnostic only'}})
            write(plugin/'.mcp.json', {'mcpServers':{'t3o_probe':{'command':sys.executable,'args':[str(plugin/'probe.py'),'mcp',str(root)]}}})
        else:
            write(plugin/'plugin.json', {'$schema':'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json','name':NAME,'version':'0.1.0','description':'Disposable read-only diagnostic','extensions':{'com.openai':{'hooks':'./hooks/hooks.json','interface':{'displayName':'T3O TASK-00 Probe','shortDescription':'Local diagnostic only'}}}})
            # Absolute paths refer only to the isolated workspace, not the installed cache.
            write(plugin/'mcp.json', {'$schema':'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json','mcpServers':{'t3o_probe':{'type':'stdio','command':sys.executable,'args':[str(plugin/'probe.py'),'mcp',str(root)]}}})
    else:
        # JSON string quoting is compatible with TOML basic strings for these paths.
        config = '[mcp_servers.t3o_probe]\ncommand = ' + json.dumps(sys.executable, ensure_ascii=False) + '\n'
        config += 'args = ' + json.dumps([str(plugin/'probe.py'), 'mcp', str(root)], ensure_ascii=False) + '\n'
        config += 'cwd = ' + json.dumps(str(root), ensure_ascii=False) + '\n'
        (root/'.codex/config.toml').write_text(config)
    import shlex
    command = shlex.join([sys.executable,str(plugin/'probe.py'),'hook',str(root)])
    hooks = {name:[{'hooks':[{'type':'command','command':command,'timeout':3 if name == 'Interrupt' else 5}]}] for name in EVENTS}
    hooks['Stop'][0]['hooks'].append({'type':'mcp_tool','server':'t3o_probe','tool':'stop_probe','input':{'origin':'hook','session_id':'${session_id}','turn_id':'${turn_id}'},'timeout':5})
    write(plugin/('hooks/hooks.json' if mode != 'direct' else 'hooks.json'), {'hooks':hooks})
    print('Disposable project created:',root)
    print('Diagnostic mode:', mode)


def mcp(root):
    salt = (root/'salt').read_text()
    append(root, {'kind':'mcp_start'})
    for line in sys.stdin:
        try:
            msg = json.loads(line); method = msg.get('method'); params = msg.get('params') or {}
            if 'id' not in msg: continue
            error = None
            if method == 'initialize':
                version = params.get('protocolVersion')
                result = {'protocolVersion':version if version in ('2024-11-05','2025-03-26','2025-06-18','2025-11-25') else '2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'t3o_probe','version':'0.1.0'}}
            elif method == 'tools/list':
                schema = {'type':'object','properties':{key:{'type':'string'} for key in (*IDS,'origin')},'additionalProperties':False}
                result = {'tools':[{'name':name,'description':description,'inputSchema':schema,'annotations':{'readOnlyHint':True}} for name, description in (('echo_probe','Diagnostic echo; claimed IDs are never authenticated'),('stop_probe','Diagnostic Stop hook; returns a non-blocking hook decision'))]}
            elif method == 'tools/call' and params.get('name') in ('echo_probe', 'stop_probe'):
                args = params.get('arguments') or {}; meta = params.get('_meta') or {}
                if not isinstance(args, dict) or not isinstance(meta, dict): raise ValueError('invalid args')
                result, record = echo_record(args, meta, salt)
                record['tool'] = params['name']; append(root, record)
                if params['name'] == 'stop_probe': result = {'continue': True}
                result = {'content':[{'type':'text','text':json.dumps(result)}],'structuredContent':result}
            elif method == 'ping': result = {}
            else: error = {'code':-32601,'message':'Method not supported'}
            print(json.dumps(dict(jsonrpc='2.0', id=msg['id'], **({'error':error} if error else {'result':result}))),flush=True)
        except (ValueError, TypeError, AttributeError, KeyError):
            print(json.dumps({'jsonrpc':'2.0','id':None,'error':{'code':-32602,'message':'Invalid diagnostic request'}}),flush=True)
    append(root, {'kind':'mcp_end'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','hook','mcp','report'])
    parser.add_argument('root',nargs='?',type=Path)
    parser.add_argument('--mode', choices=['plugin','direct','legacy'], default='legacy', help='prepare only: isolate project-scoped MCP/hooks from plugin packaging')
    args = parser.parse_args()
    if args.action == 'prepare':
        root = args.root or Path(tempfile.mkdtemp(prefix='t3o-task00-'))/'workspace'
        prepare(root, mode=args.mode); return
    if not args.root: parser.error('root required')
    root = args.root.resolve()
    if args.action == 'mcp': mcp(root)
    elif args.action == 'hook':
        try:
            event = json.load(sys.stdin)
            record, output = hook_record(event,str(root),(root/'salt').read_text())
            if record: append(root, record)
            print(json.dumps(output))
        except (ValueError, OSError, TypeError, AttributeError): print('{}')
    elif args.action == 'report':
        path = root/'events.jsonl'
        print(path.read_text() if path.exists() else 'No diagnostic events recorded.')


if __name__ == '__main__': main()
