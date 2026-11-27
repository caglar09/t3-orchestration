import unittest
from pathlib import Path
import tempfile
import probe_lifecycle as p

class Fake:
    def __init__(self, results): self.results=iter(results); self.calls=[]
    def request(self, method, params): self.calls.append((method,params)); return next(self.results)

class Tests(unittest.TestCase):
    def test_read_only_control_and_denial(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fake([{'exitCode':0},{'exitCode':1}]); p.sandbox_check(f,Path(d))
            self.assertEqual(len(f.calls),2)
            self.assertTrue(all(args['sandboxPolicy']['type']=='readOnly' for _,args in f.calls))
            with self.assertRaises(RuntimeError): p.sandbox_check(Fake([{'exitCode':0},{'exitCode':0}]),Path(d))
    def test_matching_terminal_and_early_completion(self):
        class Events:
            events={('a','x'):'interrupted',('b','y'):'completed'}
        e=Events(); self.assertEqual(p.terminal(e,'a','x'),'interrupted')
        self.assertEqual(p.terminal(e,'b','y'),'completed')

if __name__=='__main__': unittest.main()
