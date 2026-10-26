import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createGameHost} from './server.mjs';

const token='test-runtime-token-'.repeat(3),origin='http://game.example';
async function fixture(t){
 const dir=mkdtempSync(path.join(tmpdir(),'game-host-test-'));
 writeFileSync(path.join(dir,'index.html'),'<h1>Independent game</h1>');
 const calls=[];
 const service=createGameHost({config:{name:'fixture',games:[{id:'example',webRoot:dir,runtimePath:'/native'}]},origin,runtimeUrl:'http://native.invalid',runtimeToken:token,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({account:options.headers['X-UTXOPlay-Account']});}});
 const server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{service.close();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 return {service,calls,url,async request(p,body,cookie='',extra={}){return fetch(url+p,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});}};
}
const cookie=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
test('standalone guests persist and cannot inject another player identity',async t=>{
 const f=await fixture(t),a=await f.request('/games/example/'),b=await f.request('/games/example/');
 assert.equal(a.status,200);assert.match(await a.text(),/Independent/);
 const ac=cookie(a),bc=cookie(b);assert.notEqual(ac,bc);
 const state=await f.request('/games/example/api/state',undefined,ac,{'X-UTXOPlay-Account':'b'.repeat(64)});assert.equal(state.status,200);
 const id=(await state.json()).account;assert.notEqual(id,'b'.repeat(64));assert.match(id,/^[a-f0-9]{64}$/);
 assert.equal((await(await f.request('/games/example/api/state',undefined,ac)).json()).account,id);
 assert.notEqual((await(await f.request('/games/example/api/state',undefined,bc)).json()).account,id);
 assert.equal((await f.request('/games/example/api/state')).status,401);
 assert.equal((await f.request('/games/example/api/state',undefined,ac+'tampered')).status,401);
 assert.equal((await f.request('/games/example/api/action',{},ac,{Origin:'https://evil.example'})).status,403);
 assert.equal(f.calls[0].url,'http://native.invalid/native/api/state');
});
test('trusted gateways bind the exact account; invalid credentials never fall back to cookies',async t=>{
 const f=await fixture(t),r=await f.request('/games/example/'),jar=cookie(r),headers={'X-Runtime-Token':token,'X-UTXOPlay-Account':'c'.repeat(64),Origin:'http://store.example'};
 const response=await f.request('/games/example/api/action',{type:'move'},'',headers);assert.equal(response.status,200);assert.equal((await response.json()).account,'c'.repeat(64));
 assert.equal((await f.request('/games/example/api/state',undefined,jar,{'X-Runtime-Token':'invalid','X-UTXOPlay-Account':'d'.repeat(64)})).status,401);
 assert.equal((await f.request('/games/example/api/state',undefined,jar,{'X-Runtime-Token':token,'X-UTXOPlay-Account':'invalid'})).status,401);
 assert.equal((await f.request('/games/example/api/unknown',undefined,jar)).status,404);
 const guest=await f.request('/games/example/api/guest',{},'',headers);assert.equal((await guest.json()).user.id,'c'.repeat(64));assert.equal(guest.headers.getSetCookie().length,0);
});
