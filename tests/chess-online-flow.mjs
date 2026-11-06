// Real native Myelin runtime, two browser identities, Host/native restart and offline verification.
import assert from 'node:assert/strict';
import {CommandClient,RoomClient,commandRequest} from '../games/chess/web/commands.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createGameHost} from '../host/server.mjs';
import {createChessPlugin} from '../host/chess.mjs';
const binary=process.env.CHESS_BINARY||'/tmp/utxoplay-chess-native',dir=mkdtempSync('/tmp/chess-online-flow-');
process.env.RUNTIME_TOKEN=randomBytes(32).toString('hex');process.env.CHESS_URL='http://127.0.0.1:18197';
const origin='http://127.0.0.1:19127';let native,service,server,loseNextReply=false,loseNextStatus=false,loseBrowserStatus=false,blockNextProjection=false,indexBlocker;
const runtimeCalls=[];
const indexFault={scope:'SQLite room-discovery writes unavailable; canonical native stores remain online',http:[]};
async function runtimeFetch(url,options){
 runtimeCalls.push({url,headers:options.headers,body:options.body});const response=await fetch(url,options);
 if(blockNextProjection&&url.endsWith('/action')&&response.ok){
  blockNextProjection=false;indexFault.committed=await response.clone().json();
  indexBlocker=new DatabaseSync(dir+'/rooms/rooms.sqlite');indexBlocker.exec('BEGIN IMMEDIATE');
  indexFault.started_ms=performance.now();indexFault.started_at=new Date().toISOString();
 }
 if(loseNextReply&&(url.endsWith('/action')||url.endsWith('/new'))&&response.ok){loseNextReply=false;await response.arrayBuffer();throw Error('drop response after real native commit');}
 if(loseNextStatus&&url.includes('/commands/')&&response.ok){loseNextStatus=false;await response.arrayBuffer();throw Error('drop command status response');}return response;
}
function releaseIndex(){if(indexBlocker){indexBlocker.exec('ROLLBACK');indexBlocker.close();indexBlocker=null;}}
async function start(){
 native=spawn(binary,[],{env:{...process.env,DATA_DIR:dir+'/native',PORT:'18197',BIND:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{native.stdout.once('data',resolve);native.once('exit',code=>reject(Error('Native exited '+code)));});
 service=createGameHost({config:{name:'chess-online-test',games:[{id:'chess',webRoot:'dist/chess',runtimePath:''}]},origin,runtimeUrl:process.env.CHESS_URL,runtimeToken:process.env.RUNTIME_TOKEN,fetchImpl:runtimeFetch,install:createChessPlugin(dir+'/rooms')});server=service.app.listen(19127,'127.0.0.1');await new Promise(r=>server.once('listening',r));
}
async function stop(){service?.close();if(server)await new Promise(r=>server.close(r));if(native){const done=new Promise(r=>native.once('exit',r));native.kill('SIGKILL');await done;}}
async function req(path,body,cookie='',headers={}){
 const started=performance.now();
 const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 if(indexBlocker)indexFault.http.push({path,status:r.status,elapsed_ms:performance.now()-started});
 return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
}
function savedRequests() {
 const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
}
function roomClient(user,storage) {
 return new RoomClient(async(path,body)=>{
  if(loseBrowserStatus&&path.includes('/commands/')){loseBrowserStatus=false;throw Error('browser disconnected before reconciliation');}
  const r=await req(path,body,user.cookie);if(r.status<200||r.status>=300)throw Error(r.data.error);return r.data;
 },storage,()=>user.data.user.id+'/rooms');
}
try{
 await start();const a=await req('/games/chess/api/guest',{}),b=await req('/games/chess/api/guest',{}),c=await req('/games/chess/api/guest',{});
 const rooms='/games/chess/api/rooms',aStorage=savedRequests(),bStorage=savedRequests();
 const aRooms=roomClient(a,aStorage),bRooms=roomClient(b,bStorage);
 assert.equal((await req(rooms,{color:'white'})).status,401);
 assert.equal((await req(rooms,{color:'white'},a.cookie,{Origin:'https://invalid.test'})).status,403);
 assert.equal((await req(rooms,{color:'white'},a.cookie)).status,400);
 // A separate real SQLite writer blocks projection after native commit. The
 // client retains its original command; no transport error substitutes for it.
 blockNextProjection=true;loseBrowserStatus=true;
 await assert.rejects(aRooms.create('white'));assert.equal(aStorage.values.size,1);
 assert.ok(indexBlocker);assert.equal(indexFault.http.at(-1).status,503);
 indexFault.failure_response_ms=performance.now()-indexFault.started_ms;
 const createOriginal=JSON.parse([...aStorage.values.values()][0]);
 const id=createOriginal.action.room_id,route=rooms+'/'+id;
 assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM chess_rooms').get().n,1);
 assert.equal(service.db.prepare('SELECT white FROM chess_rooms WHERE id=?').get(id).white,null);
 assert.throws(()=>service.db.prepare('UPDATE chess_rooms SET white=white WHERE id=?').run(id),e=>{
  indexFault.sqlite_error={code:e.code,errcode:e.errcode,message:e.message};return e.errcode===5;
 });
 assert.equal((await req(route+'/admission',undefined,a.cookie)).status,503);
 let independent=(await req('/games/chess/api/state',undefined,c.cookie)).data;
 indexFault.independent={before:independent.session,commands:[]};
 for(const uci of ['f2f3','e7e5','g2g4','d8h4']){
  const original=commandRequest(independent,{type:'move',uci}),started=performance.now();
  const result=await req('/games/chess/api/action',original,c.cookie);assert.equal(result.status,200);
  independent=result.data;assert.ok(independent.command.entry.status.Committed.outcome.Succeeded);
  indexFault.independent.commands.push({original,receipt:independent.command,elapsed_ms:performance.now()-started});
 }
 assert.match(independent.game.result,/BlackCheckmates/);indexFault.independent.after=independent.session;
 const independentExport=(await req('/games/chess/api/export',undefined,c.cookie)).data;
 writeFileSync(dir+'/independent.json',JSON.stringify(independentExport));
 indexFault.independent.replay=JSON.parse(execFileSync(binary,['verify',dir+'/independent.json'],{encoding:'utf8'}));
 assert.equal(indexFault.independent.replay.verified,true);assert.equal(indexFault.independent.replay.frames,4);
 assert.equal(indexFault.independent.replay.state_root,independent.session.state_root);
 indexFault.independent.archive=independentExport;
 indexFault.lock_held_ms=performance.now()-indexFault.started_ms;releaseIndex();
 const recoveryStarted=performance.now();
 await stop();await start();
 const created=await roomClient(a,aStorage).recover(null);
 indexFault.restart_and_reconciliation_ms=performance.now()-recoveryStarted;
 assert.deepEqual(created.command,indexFault.committed.command);assert.deepEqual(created.session,indexFault.committed.session);
 assert.equal(service.db.prepare('SELECT white FROM chess_rooms WHERE id=?').get(id).white,a.data.user.id);
 indexFault.original=createOriginal;indexFault.recovered=created;indexFault.projection_repaired=true;
 assert.deepEqual((await req('/games/chess/api/state',undefined,c.cookie)).data.session,independent.session);
 for(const item of indexFault.independent.commands){
  assert.deepEqual((await req('/games/chess/api/commands/'+item.original.session_id+'/'+item.original.command_id,undefined,c.cookie)).data,item.receipt);
 }
 assert.equal(aStorage.values.size,0);assert.equal(created.room.id,id);assert.equal(created.room.color,'white');
 assert.equal(created.session.actions,1);assert.deepEqual(created.admission.seats,[a.data.user.id,null]);
 assert.deepEqual((await req(rooms,createOriginal,a.cookie)).data.command,created.command);
 assert.equal((await req(rooms,{...createOriginal,action:{...createOriginal.action,color:'black'}},a.cookie)).status,403);
 assert.equal((await req(rooms+'/prepare/'+createOriginal.command_id+'/black',{},a.cookie)).status,409);
 assert.equal((await req(route+'/state',undefined,c.cookie)).status,403);
 assert.equal((await req(route+'/export',undefined,c.cookie)).status,403);
 assert.equal((await req(route+'/action',commandRequest(created,{type:'move',uci:'e2e4'}),a.cookie)).status,409);
 const cOffer=(await req(route+'/admission',undefined,c.cookie)).data;
 assert.equal(cOffer.game,undefined);assert.equal(cOffer.proposal.color,'black');
 const competing=commandRequest(cOffer,{type:'join_room',room_id:id,color:'black'});
 // The second seat's commit also survives a lost reply, absent host projection
 // and process restart. Another actor cannot reuse it or win the same old head.
 loseNextReply=true;loseBrowserStatus=true;
 await assert.rejects(bRooms.join(id));assert.equal(bStorage.values.size,1);
 const joinOriginal=JSON.parse([...bStorage.values.values()][0]);
 assert.equal(service.db.prepare('SELECT black FROM chess_rooms WHERE id=?').get(id).black,null);
 await stop();await start();
 let state=await roomClient(b,bStorage).recover(null);
 assert.equal(bStorage.values.size,0);assert.equal(state.room.color,'black');assert.equal(state.room.ready,true);
 assert.equal(state.session.actions,2);assert.deepEqual(state.admission.seats,[a.data.user.id,b.data.user.id]);
 assert.equal((await req(route+'/join',competing,c.cookie)).status,409);
 assert.equal((await req(route+'/join',joinOriginal,c.cookie)).status,409);
 assert.deepEqual((await req(route+'/join',joinOriginal,b.cookie)).data.command,state.command);
 assert.equal((await req(route+'/join',{},b.cookie)).status,400);
 assert.equal((await aRooms.join(id)).room.color,'white');
 await assert.rejects(roomClient(c,savedRequests()).join(id),/Both seats/);
 assert.equal((await req(rooms,undefined,b.cookie)).data.rooms[0].id,id);
 assert.equal((await req(route+'/action',commandRequest(state,{type:'move',uci:'e7e5'}),b.cookie)).status,403);
 // Illegal chess is a durable business rejection, not a lost transport request.
 const invalid=(await req(route+'/action',commandRequest(state,{type:'move',uci:'e2e5'}),a.cookie)).data;
 assert.ok(invalid.command.entry.status.Committed.outcome.Rejected);assert.equal(invalid.game.moves.length,0);state=invalid;
 // Even a gateway-signed fresh command cannot replace a replayed seat actor.
 // Bypass host membership checks to exercise the native application boundary.
 const wrongActor=await fetch(process.env.CHESS_URL+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Runtime-Token':process.env.RUNTIME_TOKEN,'X-UTXOPlay-Account':createHash('sha256').update('utxoplay:chess:room:'+id).digest('hex'),'X-Game-Actor':c.data.user.id,'X-Game-Seat':'white'},body:JSON.stringify(commandRequest(state,{type:'move',uci:'e2e4'}))});
 assert.equal(wrongActor.status,200);
 const wrongResult=await wrongActor.json();assert.ok(wrongResult.command.entry.status.Committed.outcome.Rejected);assert.equal(wrongResult.game.moves.length,0);
 state=(await req(route+'/admission',undefined,a.cookie)).data;
 assert.deepEqual(state.admission.seats,[a.data.user.id,b.data.user.id]);

 const original=structuredClone(state);
 for(const [i,move] of ['f2f3','e7e5'].entries()){
  const r=await req(route+'/action',commandRequest(state,{type:'move',uci:move}),i%2?b.cookie:a.cookie,{'X-Game-Actor':c.data.user.id,'X-Game-Seat':'black'});assert.equal(r.status,200,JSON.stringify(r));state=r.data;
 }
 assert.equal((await req(route+'/action',commandRequest(original,{type:'move',uci:'g2g4'}),a.cookie)).status,409);
 const lost=commandRequest(state,{type:'move',uci:'g2g4'});
 loseNextReply=true;
 assert.equal((await req(route+'/action',lost,a.cookie)).status,503);
 const observed=await req(route+`/commands/${lost.session_id}/${lost.command_id}`,undefined,a.cookie);
 assert.ok(observed.data.entry.status.Committed);
 const retried=await req(route+'/action',lost,a.cookie);assert.equal(retried.status,200);state=retried.data;
 assert.equal(state.game.moves.length,3);
 assert.deepEqual((await req(route+'/action',lost,a.cookie)).data.command,state.command);
 assert.equal((await req(route+'/action',lost,b.cookie)).status,409);
 const recoveredCommand=structuredClone(state.command);
 const head=state.session.block_hash;
 await stop();await start();
 state=(await req(route+'/state',undefined,b.cookie)).data;assert.equal(state.session.block_hash,head);assert.equal(state.room.color,'black');assert.equal(state.game.moves.length,3);
 assert.deepEqual((await req(route+'/action',lost,a.cookie)).data.command,recoveredCommand);
 for(const move of ['d8h4']){
  const r=await req(route+'/action',commandRequest(state,{type:'move',uci:move}),b.cookie);assert.equal(r.status,200,JSON.stringify(r));state=r.data;
 }
 assert.match(state.game.result,/BlackCheckmates/);
 const replay=(await req(route+'/replay',{},a.cookie)).data;assert.equal(replay.verified,true);assert.equal(replay.positions.length,5);
 const exported=(await req(route+'/export',undefined,b.cookie)).data;writeFileSync(dir+'/evidence.json',JSON.stringify(exported));
 const verified=JSON.parse(execFileSync(binary,['verify',dir+'/evidence.json'],{encoding:'utf8'}));assert.equal(verified.verified,true);assert.equal(verified.frames,8);
 assert.equal(verified.state_root,state.session.state_root);
 indexFault.room_archive=exported;indexFault.room_replay=verified;
 // Late lifecycle retries recover their original receipts after game moves.
 assert.deepEqual((await req(rooms,createOriginal,a.cookie)).data.command,created.command);
 assert.deepEqual((await req(route+'/join',joinOriginal,b.cookie)).data.command,(await req(route+'/commands/'+joinOriginal.session_id+'/'+joinOriginal.command_id,undefined,b.cookie)).data);
 assert.deepEqual((await req(route+'/state',undefined,a.cookie)).data.admission.seats,[a.data.user.id,b.data.user.id]);
 const forwarded=runtimeCalls.filter(c=>c.url.endsWith('/action')&&JSON.parse(c.body).action.type==='move').at(-1).headers;
 assert.equal(forwarded['X-Game-Actor'],b.data.user.id);assert.equal(forwarded['X-Game-Seat'],'black');
 assert.notEqual(forwarded['X-UTXOPlay-Account'],a.data.user.id);assert.notEqual(forwarded['X-UTXOPlay-Account'],b.data.user.id);
 // Black-first creation is an admission event independent of whose move it is.
 // Existing SSE/cache coverage now runs against this real runtime too.
 const blackFirst=await roomClient(c,savedRequests()).create('black');assert.equal(blackFirst.room.color,'black');
 const beforeCalls=runtimeCalls.length,controller=new AbortController();
 const events=await fetch(origin+rooms+'/'+blackFirst.room.id+'/events',{headers:{Cookie:c.cookie},signal:controller.signal});
 assert.equal(events.status,200);assert.match(events.headers.get('content-type'),/text\/event-stream/);
 const reader=events.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);
 assert.match(first,/event: position/);assert.match(first,/"color":"black"/);assert.equal(runtimeCalls.length,beforeCalls);
 controller.abort();await reader.cancel().catch(()=>{});

 let solo=(await req('/games/chess/api/state',undefined,a.cookie)).data;
 assert.equal(solo.game.moves.length,0);
 const saved=new Map(),storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
 const transport=async(name,body)=>{const r=await req('/games/chess/api/'+name,body,a.cookie);if(r.status!==200)throw Error(r.data.error);return r.data;};
 const client=new CommandClient(transport,storage,()=>a.data.user.id+"/solo");
 const rival=commandRequest(solo,{type:'move',uci:'d2d4'});
 loseNextReply=true;loseNextStatus=true;
 await assert.rejects(client.submit(solo,{type:'move',uci:'e2e4'}));assert.equal(saved.size,1);
 solo=await new CommandClient(transport,storage,()=>a.data.user.id+"/solo").recover(solo);
 assert.equal(solo.game.moves.length,1);assert.equal(saved.size,0);
 assert.equal((await req('/games/chess/api/action',rival,a.cookie)).status,400);
 assert.equal((await req('/games/chess/api/state',undefined,b.cookie)).data.game.moves.length,0);
 assert.equal((await req('/games/chess/api/commands/'+solo.session.id+'/'+solo.command.command_id,undefined,b.cookie)).status,400);
 assert.equal((await req(route+'/commands/'+state.session.id+'/'+lost.command_id,undefined,c.cookie)).status,403);
 // A lost new-game reply changes the active session. Pending storage is scoped
 // to the account/channel, so reload still finds the exact historical intent.
 const previous=structuredClone(solo),oldCommand=structuredClone(solo.command);
 loseNextReply=true;loseNextStatus=true;
 await assert.rejects(client.submit(solo,{type:'new_game'}));assert.equal(saved.size,1);
 const originalNew=JSON.parse([...saved.values()][0]);
 await stop();await start();
 solo=(await req('/games/chess/api/state',undefined,a.cookie)).data;
 assert.notEqual(solo.session.id,previous.session.id);assert.equal(solo.game.moves.length,0);
 solo=await new CommandClient(transport,storage,()=>a.data.user.id+"/solo").recover(solo);
 assert.equal(saved.size,0);const firstNew=structuredClone(solo);
 assert.deepEqual((await req('/games/chess/api/new',originalNew,a.cookie)).data,solo);
 assert.deepEqual((await req('/games/chess/api/commands/'+oldCommand.session_id+'/'+oldCommand.command_id,undefined,a.cookie)).data,oldCommand);
 assert.equal((await req('/games/chess/api/new',{...originalNew,command_id:'cd'.repeat(32)},a.cookie)).status,400);
 assert.equal((await req('/games/chess/api/new',originalNew,b.cookie)).status,400);
 assert.equal((await req('/games/chess/api/new',{},a.cookie)).status,400);
 // A much later retry returns the first receipt and the current view, never
 // switches active history back to the first new session.
 solo=await client.submit(solo,{type:'move',uci:'d2d4'});
 solo=await client.submit(solo,{type:'new_game'});
 const late=(await req('/games/chess/api/new',originalNew,a.cookie)).data;
 assert.equal(late.session.id,solo.session.id);assert.notEqual(late.session.id,firstNew.session.id);
 assert.deepEqual(late.command,firstNew.command);

 console.log(JSON.stringify({onlinePlies:4,result:state.game.result,hostAndNativeRestart:'preserved seats and head',offlineReplay:verified.verified,personalGame:'isolated',lostAck:'recovered original command and receipt',competingTab:'stale rejected',roomActor:'explicit create/join events replayed; competing seat rejected',roomCreation:'canonical receipt recovered after real SQLite write outage',platformIndex:indexFault,roomAdmission:'lost commit response recovered before index update',sse:'authenticated native snapshot without extra polling',clientReload:'retained original request recovered after response and status loss',newGame:'original receipt recovered across session change and restart; late retry never rewinds'}));
}finally{releaseIndex();await stop();rmSync(dir,{recursive:true,force:true});}
