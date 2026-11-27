#!/usr/bin/env python3
import json,sys
count=0
for line in sys.stdin:
    msg=json.loads(line); method=msg['method']; p=msg.get('params',{})
    if 'id' not in msg: continue
    r={}
    if method=='account/read': r={'account':{'type':'chatgpt','email':'secret@example.invalid'}}
    elif method=='account/rateLimits/read': r={'rateLimits':{'primary':{'usedPercent':1}}}
    elif method=='thread/start': r={'thread':{'id':'synthetic-thread','modelProvider':'openai'}}
    elif method=='turn/start':
        count+=1; tid=f'turn-{count}'; r={'turn':{'id':tid}}
        print(json.dumps({'method':'turn/completed','params':{'threadId':'synthetic-thread','turn':{'id':tid,'status':'completed'}}}),flush=True)
    elif method=='thread/turns/list': r={'nextCursor':None if 'cursor' in p else 'next','data':[{}]}
    print(json.dumps({'id':msg['id'],'result':r}),flush=True)
