"""TASK-00: permission, discovery, parallel turns and cancellation on owned threads."""
import argparse
from pathlib import Path
import queue
import tempfile
import time
import uuid


def terminal(probe, thread, turn):
    key = (thread, turn)
    deadline = time.monotonic()+120
    while key not in probe.events:
        probe.next(deadline)
    return probe.events.pop(key)


def sandbox_check(probe, root):
    policy = {'cwd':str(root),'sandboxPolicy':{'type':'readOnly'},'timeoutMs':5000}
    control = probe.request('command/exec', dict(policy, command=['/bin/echo','TASK00_CONTROL']))
    if control.get('exitCode') != 0: raise RuntimeError('read-only control command failed')
    marker = root/'write-must-fail'
    attempt = probe.request('command/exec', dict(policy, command=['/usr/bin/touch',str(marker)]))
    if not isinstance(attempt.get('exitCode'),int) or attempt['exitCode'] == 0 or marker.exists():
        raise RuntimeError('read-only write denial not established')
    print('PASS read-only control and write denial in disposable directory')


def run(executable, live):
    from probe_app_server import Probe
    from probe_coordinator_wakeup import server, create_thread
    with tempfile.TemporaryDirectory(prefix='t3o-life-') as cwd:
        with server(Probe,executable,cwd) as p:
            sandbox_check(p,Path(cwd))
            if not live:
                print('No inference. Use --live for worker lifecycle.'); return 0
            a,b = create_thread(p,cwd),create_thread(p,cwd)
            if a == b: raise RuntimeError('worker IDs collided')
            def start(thread, text):
                return p.request('turn/start',{'threadId':thread,'input':[{'type':'text','text':text}], 'approvalPolicy':'never','sandboxPolicy':{'type':'readOnly'}})['turn']['id']
            nonce=uuid.uuid4().hex[:8]
            prompt=f'Reply TASK00_PARALLEL_{nonce}. No tools or file changes.'
            ta,tb=start(a,prompt),start(b,prompt)
            if (a,ta) in p.events: print('INCONCLUSIVE actual overlap: A finished before B reply')
            else: print('PASS B started before A terminal event was observed')
            for thread,tid in ((a,ta),(b,tb)):
                if terminal(p,thread,tid) != 'completed': raise RuntimeError('worker did not complete')
            print('PASS two independent workers completed')
            # Bounded discovery; never print unrelated thread metadata.
            found=set(); cursor=None
            for _ in range(20):
                params={'sourceKinds':['appServer'],'limit':100}
                if cursor: params['cursor']=cursor
                page=p.request('thread/list',params)
                found.update(t.get('id') for t in page['data'] if t.get('id') in (a,b))
                cursor=page.get('nextCursor')
                if found=={a,b} or not cursor: break
            print('PASS owned workers discovered' if found=={a,b} else 'INCONCLUSIVE discovery')
            cancel=start(a,'Write a long fictional paragraph in plain text. Do not use tools or modify files.')
            if (a,cancel) in p.events:
                print('INCONCLUSIVE interrupt: turn already ended')
            else:
                try: p.request('turn/interrupt',{'threadId':a,'turnId':cancel})
                except RuntimeError:
                    if (a,cancel) not in p.events: raise
                status=terminal(p,a,cancel)
                print('PASS interrupt' if status=='interrupted' else 'INCONCLUSIVE interrupt: '+str(status))
            print('Failed terminal events, busy coordinator queue and exclusive desktop ownership remain separate gates.')
    return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex',default='codex')
    parser.add_argument('--live',action='store_true',help='Create two synthetic threads; use existing quota/credits.')
    args=parser.parse_args()
    try: return run(args.codex,args.live)
    except (OSError,RuntimeError,queue.Empty,KeyError,TypeError) as e:
        print('BLOCKED:',str(e) if isinstance(e,RuntimeError) else type(e).__name__); return 1

if __name__=='__main__': raise SystemExit(main())
