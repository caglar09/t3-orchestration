"""TASK-00: external wake of a disposable coordinator across owned servers."""
import argparse
from contextlib import contextmanager
import queue
import tempfile
import uuid


def require_idle(thread, thread_id):
    if thread.get('id') != thread_id or (thread.get('status') or {}).get('type') not in ('idle', 'notLoaded'):
        raise RuntimeError('target identity or idle status not confirmed')


def turn(probe, thread_id, **payload):
    result = probe.request('turn/start', dict(threadId=thread_id,
        approvalPolicy='never', sandboxPolicy={'type': 'readOnly'}, **payload))
    turn_id = result['turn']['id']
    if not turn_id:
        raise RuntimeError('turn ID absent')
    probe.completed(thread_id, turn_id)
    return turn_id


def wake(probe, coordinator_id, worker_id, worker_turn_id):
    if not all((coordinator_id, worker_id, worker_turn_id)) or coordinator_id == worker_id:
        raise RuntimeError('distinct owned coordinator and worker required')
    return turn(probe, coordinator_id, input=[], toolOutput={
        'name': 'task00_worker_completed',
        'output': f'Synthetic worker {worker_id}, turn {worker_turn_id}: completed.'})


def verify_history(probe, thread_id, expected_ids, marker):
    page = probe.request('thread/turns/list', {'threadId': thread_id,
        'limit': len(expected_ids) + 1, 'sortDirection': 'desc', 'itemsView': 'full'})
    data = page['data']
    if page.get('nextCursor') or [t['id'] for t in data] != expected_ids or any(t['status'] != 'completed' for t in data):
        raise RuntimeError('unexpected history or incomplete turn')
    if not any(i.get('type') == 'agentMessage' and i.get('text', '').strip() == marker for i in data[0].get('items', [])):
        raise RuntimeError('expected response marker absent from newest turn')
    return data[0]


@contextmanager
def server(factory, executable, cwd):
    probe = factory(executable, cwd)
    try:
        probe.request('initialize', {'clientInfo': {'name': 't3o_wakeup_probe', 'version': '0.1.0'}})
        probe.send({'method': 'initialized', 'params': {}})
        if (probe.request('account/read').get('account') or {}).get('type') != 'chatgpt':
            raise RuntimeError('ChatGPT-managed login not confirmed')
        yield probe
    finally:
        probe.close()


def create_thread(probe, cwd):
    thread = probe.request('thread/start', {'cwd': cwd, 'sandbox': 'read-only',
        'approvalPolicy': 'never', 'ephemeral': False})['thread']
    if not thread.get('id') or thread.get('modelProvider') != 'openai':
        raise RuntimeError('owned OpenAI thread not confirmed')
    return thread['id']


def run(factory, executable, confirm=input):
    nonce = uuid.uuid4().hex[:8].upper()
    ready, work, reply = (f'TASK00_{label}_{nonce}' for label in ('COORD_READY', 'WORKER_OK', 'WAKE_OK'))
    with tempfile.TemporaryDirectory(prefix='t3o-wakeup-') as cwd:
        with server(factory, executable, cwd) as a:
            coordinator = create_thread(a, cwd)
            initial = turn(a, coordinator, input=[{'type': 'text', 'text':
                f'Reply exactly {ready} now. When later given tool output from task00_worker_completed, reply exactly {reply}. Do not call tools or modify files.'}])
            verify_history(a, coordinator, [initial], ready)
        print('PASS server A closed; coordinator persisted.', flush=True)
        print(f'Open the synthetic coordinator in Codex App by searching {ready}.', flush=True)
        print(f'Expected new reply: {reply}. Leave the chat idle; do not send messages or change settings.', flush=True)
        if confirm('Type WAKE only when the synthetic chat is open and idle (anything else aborts): ').strip() != 'WAKE':
            print('ABORTED before worker or wake turn.'); return 2
        with server(factory, executable, cwd) as b:
            require_idle(b.request('thread/read', {'threadId': coordinator})['thread'], coordinator)
            verify_history(b, coordinator, [initial], ready)
            print('PASS fresh server read persisted coordinator.', flush=True)
            worker = create_thread(b, cwd)
            if worker == coordinator:
                raise RuntimeError('worker ID collided with coordinator')
            worker_turn = turn(b, worker, input=[{'type': 'text', 'text': f'Reply exactly {work}. Do not call tools or modify files.'}])
            verify_history(b, worker, [worker_turn], work)
            print('PASS independent worker completed.', flush=True)
            resumed = b.request('thread/resume', {'threadId': coordinator, 'excludeTurns': True,
                'cwd': cwd, 'sandbox': 'read-only', 'approvalPolicy': 'never'})['thread']
            require_idle(resumed, coordinator)
            if resumed.get('modelProvider') != 'openai':
                raise RuntimeError('resumed OpenAI provider not confirmed')
            verify_history(b, coordinator, [initial], ready)
            print('Sending one toolOutput wake; watch the open desktop chat.', flush=True)
            wake_turn = wake(b, coordinator, worker, worker_turn)
            verify_history(b, coordinator, [wake_turn, initial], reply)
            print('PASS external wake: new completed turn with exact reply marker.', flush=True)
        with server(factory, executable, cwd) as c:
            verify_history(c, coordinator, [wake_turn, initial], reply)
            print('PASS fresh server sees exactly two completed coordinator turns.', flush=True)
        print('API probe complete. Report whether the reply appeared without refresh, only after refresh, or not at all.', flush=True)
        print('No shared desktop endpoint or simultaneous-write safety is established by this probe.', flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', default='codex')
    parser.add_argument('--live', action='store_true', help='Create two synthetic chats and run three turns using existing quota/credits.')
    args = parser.parse_args()
    if not args.live:
        print('Dry run: no server or turns started. Use --live for the interactive probe.')
        return 0
    from probe_app_server import Probe
    try:
        return run(Probe, args.codex)
    except (OSError, RuntimeError, queue.Empty, KeyError, TypeError, EOFError, KeyboardInterrupt) as error:
        print('BLOCKED:', str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        print('No automatic retry. Do not resend to the same coordinator after an uncertain result.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
