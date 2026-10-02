import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getReanimeDetail, getReanimeStream} from '../src/lib/reanime-api.ts';

const token='test-only-token-00000000000000000000000000000000';
const env={REANIME_WORKER_TOKEN:token};
const streamPath='/api/flix/178789/14';
const payload={servers:[{serverName:'HD-1',dataType:'sub',dataLink:'https://flixcloud.cc/e/huud4iw09tf6?v=1'}]};
const request=(path=streamPath,key=token)=>new Request('https://relay.example/resolve',{
  method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({path}),
});
async function relay() {
  const source=await readFile(new URL('../workers/reanime-relay/worker.mjs',import.meta.url),'utf8').catch(()=>null);
  assert.ok(source,'The authenticated metadata Worker has not been implemented');
  return (await import('../workers/reanime-relay/worker.mjs')).handleRequest;
}
async function transport() {
  const source=await readFile(new URL('../src/lib/reanime-server-fetch.ts',import.meta.url),'utf8').catch(()=>null);
  assert.ok(source,'The server metadata transport has not been implemented');
  return (await import('../src/lib/reanime-server-fetch.ts')).fetchReanimeServer;
}
async function configured(run) {
  const oldUrl=process.env.REANIME_WORKER_URL, oldToken=process.env.REANIME_WORKER_TOKEN, oldFetch=globalThis.fetch;
  process.env.REANIME_WORKER_URL='https://relay.example';process.env.REANIME_WORKER_TOKEN=token;
  try {await run();} finally {
    globalThis.fetch=oldFetch;
    for(const [key,value] of [['REANIME_WORKER_URL',oldUrl],['REANIME_WORKER_TOKEN',oldToken]]) {
      if(value===undefined) delete process.env[key];else process.env[key]=value;
    }
  }
}

test('Worker requires its own token and never contacts upstream on missing or wrong credentials',async()=>{
  const handle=await relay();let calls=0;
  const fetcher=async()=>{calls++;return Response.json(payload);};
  assert.equal((await handle(request(),{},fetcher)).status,503);
  assert.equal((await handle(request(streamPath,'wrong'),env,fetcher)).status,401);
  assert.equal((await handle(new Request('https://relay.example/resolve'),env,fetcher)).status,405);
  assert.equal(calls,0);
});

test('Worker forwards only public Reanime metadata without client credentials or upstream cookies',async()=>{
  const handle=await relay();let call;
  const response=await handle(request(),env,async(url,init)=>{
    call={url,init};return Response.json(payload,{headers:{'Set-Cookie':'never-return=this'}});
  });
  assert.equal(response.status,200);assert.deepEqual(await response.json(),payload);
  assert.equal(call.url,'https://reanime.to/api/flix/178789/14');
  assert.equal(call.init.redirect,'manual');
  assert.equal(new Headers(call.init.headers).has('Authorization'),false);
  assert.equal(new Headers(call.init.headers).has('Cookie'),false);
  assert.equal(response.headers.has('Set-Cookie'),false);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('Worker denies arbitrary destinations, login paths, unexpected query keys and malformed episodes',async()=>{
  const handle=await relay();let calls=0;
  for(const path of ['https://evil.example','//evil.example/api/v1/home','/api/auth/session','/api/v1/home?url=https://evil.example',
    '/api/flix/178789/-1','/api/flix/178789/1.001','/api/v1/anime/../../auth','/api/v1/anime/%2e%2e','/api/v1/search?q='+ 'a'.repeat(121)]) {
    assert.equal((await handle(request(path),env,async()=>{calls++;return Response.json({});})).status,400,path);
  }
  assert.equal(calls,0);
});

test('Worker supports search, detail, episodes and legacy home metadata',async()=>{
  const handle=await relay();const calls=[];
  for(const path of ['/api/v1/home','/api/v1/search?q=%E7%84%A1%E8%81%B7','/api/v1/anime/work-3','/api/v1/anime/work-3/episodes',
    '/home/__data.json','/watch/work-3/__data.json?ep=1']) {
    assert.equal((await handle(request(path),env,async url=>{calls.push(url);return Response.json({data:[]});})).status,200);
  }
  assert.equal(calls.length,6);assert.equal(calls.every(u=>u.startsWith('https://reanime.to/')),true);
});

test('Worker preserves upstream failures and rejects challenge HTML or oversized responses',async()=>{
  const handle=await relay();
  for(const [response,status] of [[new Response('blocked',{status:403}),403],[new Response('<html>challenge</html>',{headers:{'Content-Type':'text/html'}}),502],
    [new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'99999999'}}),502]]) {
    const result=await handle(request(),env,async()=>response);
    assert.equal(result.status,status);assert.match((await result.json()).error,/Reanime|응답/);
  }
});

test('Worker uses an edge-supported redirect mode and rejects redirects without following or forwarding them',async()=>{
  const handle=await relay();
  for(const status of [301,302,303,307,308]) {
    let calls=0;
    const response=await handle(request(),env,async(url,init)=>{
      calls++;
      assert.equal(init.redirect,'manual');
      return new Response(null,{status,headers:{Location:'https://other.example/private'}});
    });
    assert.equal(calls,1);
    assert.equal(response.status,502);
    assert.equal(response.headers.has('Location'),false);
    assert.match((await response.json()).error,new RegExp(`HTTP ${status}`));
  }
});

test('configured server transport resolves streams and episode lists via the Worker without browser extensions',async()=>configured(async()=>{
  const fetchServer=await transport(),handle=await relay();const upstream=[];
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://relay.example/resolve');
    return handle(new Request(url,init),env,async target=>{
      upstream.push(target);
      return Response.json(target.endsWith('/episodes')?{data:[{episode_number:14}]}:
        target.includes('/api/flix/')?payload:{title:{english:'Work'},anilist_id:178789});
    });
  };
  const detail=await getReanimeDetail('https://reanime.to','re_work',undefined,fetchServer);
  const stream=await getReanimeStream('https://reanime.to',178789,14,undefined,'sub',fetchServer);
  assert.equal(detail.sub_episodes[0].number,14);
  assert.equal(stream.embed_url,'https://flixcloud.cc/e/huud4iw09tf6?v=1');
  assert.equal(upstream.length,3);
}));

test('server transport rejects incomplete config, foreign origins and redirects without leaking the token',async()=>configured(async()=>{
  const fetchServer=await transport();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  await assert.rejects(fetchServer('https://evil.example/api/v1/home'),/Reanime/);
  delete process.env.REANIME_WORKER_TOKEN;
  await assert.rejects(fetchServer('https://reanime.to/api/v1/home'),/설정/);
  process.env.REANIME_WORKER_TOKEN=token;process.env.REANIME_WORKER_URL='http://relay.example';
  await assert.rejects(fetchServer('https://reanime.to/api/v1/home'),/설정/);
  assert.equal(calls,0);
}));

test('unconfigured installations retain the direct server request and configured requests preserve cancellation',async()=>configured(async()=>{
  const fetchServer=await transport();const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({});};
  const controller=new AbortController();
  await fetchServer('https://reanime.to/api/v1/home',{signal:controller.signal});
  assert.equal(calls[0].init.signal,controller.signal);assert.equal(calls[0].init.redirect,'error');
  delete process.env.REANIME_WORKER_URL;delete process.env.REANIME_WORKER_TOKEN;
  await fetchServer('https://reanime.to/api/v1/home');
  assert.equal(calls[1].url,'https://reanime.to/api/v1/home');
  assert.equal(new Headers(calls[1].init?.headers).has('Authorization'),false);
}));
