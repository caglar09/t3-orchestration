import unittest
from unittest.mock import patch
import probe_coordinator_wakeup as p


class Fake:
    def __init__(self, **kwargs):
        self.calls = []
        self.closed = False
        self.history = []

    def request(self, method, params=None):
        self.calls.append((method, params))
        if method == 'turn/start':
            return {'turn': {'id': 'new'}}
        if method == 'thread/turns/list':
            return {'data': self.history, 'nextCursor': None}
        return {}

    def completed(self, thread_id, turn_id):
        self.calls.append(('completed', (thread_id, turn_id)))


class WakeTests(unittest.TestCase):
    def test_signal_targets_coordinator_and_is_tool_only(self):
        f = Fake()
        result = p.wake(f, 'coord', 'worker', 'worker-turn')
        self.assertEqual(result, 'new')
        method, args = f.calls[0]
        self.assertEqual(method, 'turn/start')
        self.assertEqual(args['threadId'], 'coord')
        self.assertEqual(args['input'], [])
        self.assertEqual(args['approvalPolicy'], 'never')
        self.assertEqual(args['sandboxPolicy']['type'], 'readOnly')
        self.assertIn('worker-turn', args['toolOutput']['output'])
        self.assertEqual(f.calls[1], ('completed', ('coord', 'new')))

    def test_self_notification_rejected(self):
        f = Fake()
        with self.assertRaises(RuntimeError):
            p.wake(f, 'coord', 'coord', 'worker-turn')
        self.assertEqual(f.calls, [])

    def test_history_checks_exact_turn_and_marker(self):
        f = Fake()
        f.history = [{'id': 'new', 'status': 'completed', 'items': [
            {'type': 'agentMessage', 'text': 'WAKE_OK'}]},
            {'id': 'old', 'status': 'completed', 'items': []}]
        p.verify_history(f, 'coord', ['new', 'old'], 'WAKE_OK')
        with self.assertRaises(RuntimeError):
            p.verify_history(f, 'coord', ['new', 'old'], 'OTHER')
        with self.assertRaises(RuntimeError):
            p.verify_history(f, 'coord', ['old'], 'WAKE_OK')

    def test_active_or_unknown_thread_rejected(self):
        for status in ('active', 'systemError', None):
            with self.subTest(status=status), self.assertRaises(RuntimeError):
                p.require_idle({'id': 'coord', 'status': {'type': status}}, 'coord')
        p.require_idle({'id': 'coord', 'status': {'type': 'idle'}}, 'coord')
        p.require_idle({'id': 'coord', 'status': {'type': 'notLoaded'}}, 'coord')
        with self.assertRaises(RuntimeError):
            p.require_idle({'id': 'wrong', 'status': {'type': 'idle'}}, 'coord')


if __name__ == '__main__':
    unittest.main()
