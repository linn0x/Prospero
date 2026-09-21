#!/usr/bin/env python3
"""Protocol fixture: interprets upstream SSE and performs the one test tool call.
It never talks outside the controlled loopback gateway or executes tools itself.
"""
import json, os, sys, urllib.request, urllib.parse

def emit(value):
    print(json.dumps(value), flush=True)
def post(url, body, headers=None):
    assert urllib.parse.urlparse(url).hostname == '127.0.0.1'
    req=urllib.request.Request(url,json.dumps(body).encode(),{'Content-Type':'application/json',**(headers or {})})
    with urllib.request.urlopen(req, timeout=10) as response: return response.read().decode()
def rpc(url,method,params=None):
    return json.loads(post(url,{'jsonrpc':'2.0','id':1,'method':method,'params':params or {}}))['result']
def events(raw):
    return [json.loads(line[5:].strip()) for line in raw.splitlines() if line.startswith('data:') and line[5:].strip() != '[DONE]']
def argument(name): return sys.argv[sys.argv.index(name)+1]

if sys.argv[1:] == ['--version']:
    print('1.2.3-fake'); sys.exit(0)
if sys.argv[1:2] == ['app-server']:
    init=json.loads(input()); emit({'id':init['id'],'result':{}})
    initialized=json.loads(input()); assert initialized['method']=='initialized'
    start=json.loads(input()); params=start['params']; tool=params['dynamicTools'][0]
    emit({'id':start['id'],'result':{'model':params['model'],'thread':{'id':'probe-thread'}}})
    turn=json.loads(input()); emit({'id':turn['id'],'result':{}})
    config={}
    for i,arg in enumerate(sys.argv):
        if arg=='-c':
            key,value=sys.argv[i+1].split('=',1);config[key]=json.loads(value)
    base=config['model_providers.prospero_probe.base_url']; headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY']}
    body={'model':params['model'],'stream':True,'tools':[{'type':'function','name':tool['name'],'parameters':tool['inputSchema']}],'input':[]}
    frames=events(post(base+'/responses',body,headers))
    call=next(e['item'] for e in frames if e.get('item',{}).get('type')=='function_call' and e['item'].get('arguments'))
    emit({'id':99,'method':'item/tool/call','params':{'tool':call['name'],'arguments':json.loads(call['arguments'])}})
    receipt=json.loads(input())['result']['contentItems'][0]['text']
    body['input']=[{'type':'function_call_output','call_id':'call-1','output':receipt}]
    frames=events(post(base+'/responses',body,headers)); text=''.join(e.get('delta','') for e in frames if e.get('type')=='response.output_text.delta')
    emit({'method':'item/agentMessage/delta','params':{'delta':text}})
    emit({'method':'turn/completed','params':{'turn':{'status':'completed'}}});sys.exit(0)

claude='--strict-mcp-config' in sys.argv
if claude:
    config=json.load(open(argument('--mcp-config')));mcp=config['mcpServers']['prospero_probe']['url']
    base=os.environ['ANTHROPIC_BASE_URL'];model=os.environ['ANTHROPIC_MODEL'];headers={'x-api-key':os.environ['ANTHROPIC_API_KEY']}
else:
    config=json.load(open(os.environ['OPENCODE_CONFIG']));mcp=config['mcp']['prospero_probe']['url'];model=config['model'].split('/',1)[1]
    base=config['provider']['prospero_probe']['options']['baseURL'];headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY']}
rpc(mcp,'initialize'); tool=rpc(mcp,'tools/list')['tools'][0]
name=('mcp__prospero_probe__' if claude else 'prospero_probe_')+tool['name']
if claude:
    emit({'type':'system','subtype':'init','cwd':os.getcwd(),'model':model,'tools':[name],'plugins':[],'skills':[]})
    body={'model':model,'stream':True,'tools':[{'name':name,'input_schema':tool['inputSchema']}],'messages':[]}
    frames=events(post(base+'/v1/messages',body,headers));call=next(e['content_block'] for e in frames if e.get('content_block',{}).get('type')=='tool_use')
    name=call['name'];args=''.join(e.get('delta',{}).get('partial_json','') for e in frames)
else:
    body={'model':model,'stream':True,'tools':[{'type':'function','function':{'name':name,'parameters':tool['inputSchema']}}],'messages':[]}
    frames=events(post(base+'/chat/completions',body,headers));calls=[c for e in frames for ch in e.get('choices',[]) for c in ch.get('delta',{}).get('tool_calls',[])]
    name=''.join(c['function'].get('name','') for c in calls);args=''.join(c['function'].get('arguments','') for c in calls)
assert name == ('mcp__prospero_probe__' if claude else 'prospero_probe_')+tool['name']
receipt=rpc(mcp,'tools/call',{'name':tool['name'],'arguments':json.loads(args)})['content'][0]['text']
if claude:
    body['messages']=[{'role':'user','content':[{'type':'tool_result','tool_use_id':'tool-1','content':receipt}]}]
    frames=events(post(base+'/v1/messages',body,headers));text=''.join(e.get('delta',{}).get('text','') for e in frames)
    emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':text}}})
    emit({'type':'result','subtype':'success','is_error':False})
else:
    body['messages']=[{'role':'tool','tool_call_id':'call-1','content':receipt}]
    frames=events(post(base+'/chat/completions',body,headers));text=''.join(ch.get('delta',{}).get('content','') for e in frames for ch in e.get('choices',[]))
    emit({'type':'text','part':{'text':text}})
