import {createHash} from 'node:crypto';

// This table is a routing/discovery index. Myelin commands own room membership,
// game rules, exact-head admission and original receipts.
export function installChessRooms({app,db,account,needUser,limited,runtimeFetch,runtimeUrl,runtimeToken,playerName=()=>null}) {
  db.exec(`CREATE TABLE IF NOT EXISTS chess_rooms(
    id TEXT PRIMARY KEY,creator TEXT NOT NULL,create_id TEXT NOT NULL,color TEXT NOT NULL,
    created INTEGER NOT NULL,white TEXT,black TEXT,UNIQUE(creator,create_id));
    CREATE INDEX IF NOT EXISTS chess_room_white ON chess_rooms(white);
    CREATE INDEX IF NOT EXISTS chess_room_black ON chess_rooms(black);`);
  if(db.prepare('PRAGMA table_info(chess_rooms)').all().map(c=>c.name).join(',')!=='id,creator,create_id,color,created,white,black')throw Error('Unsupported room index schema; use the current release namespace.');
  const streams=new Set(),locks=new Map(),cache=new Map();
  const base='/games/chess/api/rooms',identity=/^[a-f0-9]{64}$/;
  const error=(status,message)=>Object.assign(new Error(message),{status});
  const roomId=(actor,command)=>createHash('sha256').update('chess-room-create-v1:'+actor+':'+command).digest('hex').slice(0,24);
  const seat=(state,user)=>state.admission.seats[0]===user?'white':state.admission.seats[1]===user?'black':null;
  function roomFor(id) {
    if(!/^[a-f0-9]{24}$/.test(id||''))throw error(404,'Table not found. Check your invitation.');
    const room=db.prepare('SELECT * FROM chess_rooms WHERE id=?').get(id);
    if(!room)throw error(404,'Table not found. Check your invitation.');
    return room;
  }
  async function locked(id,fn) {
    if(locks.has(id))throw error(409,'This table is updating. Retry the original request.');
    locks.set(id,true);
    try{return await fn();}finally{locks.delete(id);}
  }
  async function runtime(id,endpoint,body,actor) {
    const runtimeAccount=createHash('sha256').update('utxoplay:chess:room:'+id).digest('hex');
    const response=await runtimeFetch(runtimeUrl+'/api/'+endpoint,{
      method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Runtime-Token':runtimeToken,'X-UTXOPlay-Account':runtimeAccount,...(actor?{'X-Game-Actor':actor.account,'X-Game-Seat':actor.seat}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    if(!response.ok)throw error(response.status===400?409:503,result.error||'The table could not be updated. Reconnect to recover its saved position.');
    return result;
  }
  function remember(room,value) {
    if(value.admission.room_id!==null) {
      if(value.admission.room_id!==room.id||value.admission.seats[Number(room.color==='black')]!==room.creator)throw error(503,'Room index differs from replayed admission.');
      for(const [i,color] of ['white','black'].entries())if(room[color]&&room[color]!==value.admission.seats[i])throw error(503,'Room membership index differs from replayed admission.');
      // Membership never transfers. A delayed earlier response cannot erase an
      // already projected seat. These columns are never authorization evidence.
      db.prepare('UPDATE chess_rooms SET white=COALESCE(white,?),black=COALESCE(black,?) WHERE id=?').run(...value.admission.seats,room.id);
    }
    const existing=cache.get(room.id)?.state;
    if(existing?.session.id===value.session.id&&existing.session.actions>value.session.actions)return existing;
    cache.delete(room.id);cache.set(room.id,{state:value,at:Date.now()});
    if(cache.size>64)cache.delete(cache.keys().next().value);
    return value;
  }
  async function state(room,fresh=false) {
    const hit=cache.get(room.id);
    if(!fresh&&hit&&Date.now()-hit.at<30000)return hit.state;
    return remember(room,await runtime(room.id,'state'));
  }
  function view(room,user,value) {
    const color=seat(value,user),players={};
    for(const [i,side] of ['white','black'].entries())players[side]=value.admission.seats[i]?{name:playerName(value.admission.seats[i])||(side==='white'?'Ivory player':'Jade player')}:null;
    return {...value,room:{id:room.id,color,ready:value.admission.seats.every(Boolean),players,created:room.created}};
  }
  async function member(room,user,fresh=false) {
    const value=await state(room,fresh);
    if(!seat(value,user))throw error(403,'Join this table using its invitation first.');
    return value;
  }
  function proposal(room,user,value) {
    if(seat(value,user))return view(room,user,value);
    if(value.admission.room_id===null&&room.creator!==user)throw error(409,'This invitation is not ready yet.');
    return {session:value.session,proposal:{id:room.id,color:room.creator===user?room.color:!value.admission.seats[0]?'white':!value.admission.seats[1]?'black':null}};
  }
  function validate(body,types) {
    if(!body||Object.keys(body).sort().join(',')!=='action,command_id,expected_block,expected_cursor,profile,session_id'
      ||!identity.test(body.command_id)||!identity.test(body.session_id)||!identity.test(body.profile)||!identity.test(body.expected_block)
      ||!Number.isSafeInteger(body.expected_cursor)||body.expected_cursor<0||!types.includes(body.action?.type))throw error(400,'Unsupported chess command.');
  }
  function originalActor(report) {
    if(!report.entry)return null;
    return JSON.parse(Buffer.from(report.entry.original.canonical_command).toString('utf8')).actor;
  }
  async function admit(room,user,body) {
    validate(body,['create_room','join_room']);
    if(!['white','black'].includes(body.action.color)||Object.keys(body.action).sort().join(',')!=='color,room_id,type'||body.action.room_id!==room.id)throw error(400,'Invalid room admission intent.');
    const known=await runtime(room.id,`commands/${body.session_id}/${body.command_id}`);
    if(!known.entry) {
      const before=await state(room,true);
      if(body.session_id!==before.session.id||body.profile!==before.session.profile||body.expected_block!==before.session.block_hash||body.expected_cursor!==before.session.actions)throw error(409,'The table changed before admission. Review it before creating another command.');
      if(body.action.type==='create_room') {
        if(before.session.actions!==0||before.admission.room_id!==null)throw error(409,'Recover the original room creation.');
      } else if(before.admission.room_id!==room.id||before.admission.seats[Number(body.action.color==='black')]||seat(before,user))throw error(409,'Seat is already occupied. Recover the original admission.');
    }
    try {
      const next=remember(room,await runtime(room.id,'action',body,{account:user,seat:body.action.color}));
      broadcast(room,next);
      // A rejected business command is still returned with its original receipt.
      return view(room,user,next);
    }catch(e){cache.delete(room.id);throw e;}
  }
  function send(stream,room,value) {
    if(account(stream.req)?.id!==stream.user){stream.res.end();streams.delete(stream);return;}
    if(!stream.res.write('event: position\ndata: '+JSON.stringify(view(room,stream.user,value))+'\n\n'))stream.res.end();
  }
  function broadcast(room,value) {
    for(const stream of streams)if(stream.room===room.id)send(stream,room,value);
  }
  const route=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!res.headersSent)res.status(e.status||503).json({error:e.status?e.message:'The table is reconnecting. Your saved moves are safe.'});else res.end();}};
  app.get(base,needUser,route(async(req,res)=>{
    const rows=db.prepare('SELECT * FROM chess_rooms WHERE white=? OR black=? ORDER BY created DESC LIMIT 20').all(req.account.id,req.account.id);
    res.json({rooms:rows.map(room=>({id:room.id,color:room.white===req.account.id?'white':'black',ready:!!(room.white&&room.black),created:room.created}))});
  }));
  // Preparation reserves only a routing identity. The browser then persists the
  // full exact-head/profile envelope before POST; no command is committed here.
  app.post(base+'/prepare/:command/:color',needUser,route(async(req,res)=>{
    const {command,color}=req.params;
    if(!req.body||Object.keys(req.body).length)throw error(400,'Preparation requires an empty body.');
    if(!identity.test(command)||!['white','black'].includes(color))throw error(400,'Invalid room creation identity or color.');
    const id=roomId(req.account.id,command);
    let room=db.prepare('SELECT * FROM chess_rooms WHERE id=?').get(id);
    if(!room) {
      if(limited(req.account.id+':chess-room-create',12,86400000))throw error(429,'Daily table limit reached. Rejoin one of your existing tables.');
      db.prepare('INSERT INTO chess_rooms(id,creator,create_id,color,created) VALUES(?,?,?,?,?)').run(id,req.account.id,command,color,Date.now());
      room=roomFor(id);
    }
    if(room.creator!==req.account.id||room.create_id!==command||room.color!==color)throw error(409,'Room creation identity already has another intent.');
    res.json({...proposal(room,req.account.id,await state(room,true)),proposal:{id,color}});
  }));
  app.post(base,needUser,route(async(req,res)=>{
    validate(req.body,['create_room']);
    const room=roomFor(req.body.action.room_id);
    if(room.creator!==req.account.id||room.create_id!==req.body.command_id||room.color!==req.body.action.color)throw error(403,'Room creation belongs to another original request.');
    await locked(room.id,async()=>res.status(201).json(await admit(room,req.account.id,req.body)));
  }));
  app.get(base+'/:id/admission',needUser,route(async(req,res)=>{
    const room=roomFor(req.params.id);
    res.json(proposal(room,req.account.id,await state(room,true)));
  }));
  app.post(base+'/:id/join',needUser,route(async(req,res)=>{
    validate(req.body,['join_room']);
    if(limited(req.account.id+':chess-room-join',30,60000))throw error(429,'Please wait before joining another table.');
    const room=roomFor(req.params.id);
    await locked(room.id,async()=>res.json(await admit(room,req.account.id,req.body)));
  }));
  app.get(base+'/:id/state',needUser,route(async(req,res)=>{
    const room=roomFor(req.params.id);res.json(view(room,req.account.id,await member(room,req.account.id)));
  }));
  app.get(base+'/:id/commands/:session/:command',needUser,route(async(req,res)=>{
    const room=roomFor(req.params.id);
    if(!identity.test(req.params.session)||!identity.test(req.params.command))throw error(400,'Invalid command identity.');
    const value=await state(room,true),report=await runtime(room.id,`commands/${req.params.session}/${req.params.command}`);
    // A prospective member may resolve their own admission, or prove its ID is
    // still absent. They cannot read another actor's journal entry.
    if(!seat(value,req.account.id)&&report.entry&&originalActor(report)?.account!==req.account.id)throw error(403,'Command belongs to another table member.');
    res.json(report);
  }));
  app.post(base+'/:id/action',needUser,route(async(req,res)=>{
    if(limited(req.account.id+':chess-room-action',90,60000))throw error(429,'Please slow down.');
    await locked(req.params.id,async()=>{
      const room=roomFor(req.params.id),before=await member(room,req.account.id,true),body=req.body;
      if(!before.admission.seats.every(Boolean))throw error(409,'Waiting for your friend to join.');
      validate(body,['move','resign','claim_draw']);
      const known=await runtime(room.id,`commands/${body.session_id}/${body.command_id}`);
      if(!known.entry) {
        if(seat(before,req.account.id)!==before.game.turn)throw error(403,'It is your opponent’s turn.');
        if(body.session_id!==before.session.id||body.profile!==before.session.profile||body.expected_block!==before.session.block_hash||body.expected_cursor!==before.session.actions)throw error(409,'The board has changed. Reconnect to the latest position.');
      }
      try {
        const next=remember(room,await runtime(room.id,'action',body,{account:req.account.id,seat:seat(before,req.account.id)}));
        res.set('X-Game-Players',next.admission.seats.join(','));broadcast(room,next);res.json(view(room,req.account.id,next));
      }catch(e){cache.delete(room.id);throw e;}
    });
  }));
  for(const endpoint of ['replay','export'])app[endpoint==='export'?'get':'post'](base+'/:id/'+endpoint,needUser,route(async(req,res)=>{
    const room=roomFor(req.params.id);await member(room,req.account.id);
    if(limited(req.account.id+':chess-room-evidence',10,60000))throw error(429,'Please wait before requesting another replay.');
    if(endpoint==='export')res.set('Content-Disposition','attachment; filename="quiet-board-'+room.id+'.json"');
    res.json(await runtime(room.id,endpoint,endpoint==='replay'?{}:undefined));
  }));
  app.get(base+'/:id/events',needUser,route(async(req,res)=>{
    const room=roomFor(req.params.id),current=await member(room,req.account.id);
    if(streams.size>=200||[...streams].filter(s=>s.user===req.account.id).length>=3)throw error(429,'Too many open tables. Close another game tab.');
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const stream={res,req,user:req.account.id,room:room.id};streams.add(stream);
    res.write('retry: 2000\n\n');send(stream,room,current);req.on('close',()=>streams.delete(stream));
  }));
  const heartbeat=setInterval(()=>{for(const s of streams){if(account(s.req)?.id!==s.user){s.res.end();streams.delete(s);}else if(!s.res.write(': heartbeat\n\n'))s.res.end();}},15000);heartbeat.unref();
  return {close(){clearInterval(heartbeat);for(const s of streams)s.res.end();streams.clear();cache.clear();}};
}
