import express from 'express';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {optimizedStatic} from './static.mjs';
import {gameSockets} from './socket-proxy.mjs';

export function createGameHost({config,origin,runtimeUrl,runtimeToken,sessionSecret=runtimeToken,fetchImpl=fetch,install=()=>({close(){}})}) {
 if(!runtimeToken||runtimeToken.length<32||!sessionSecret||sessionSecret.length<32)throw Error('Set stable server-only secrets of at least 32 characters');
 if(!['http:','https:'].includes(new URL(runtimeUrl).protocol))throw Error('Invalid runtime URL');
 const app=express();app.disable('x-powered-by');
 const quotas=new Map();
 function limited(key,max,ms){const now=Date.now();let q=quotas.get(key);if(!q||q.until<now){q={count:0,until:now+ms};quotas.set(key,q);}return ++q.count>max;}
 const cleanup=setInterval(()=>{for(const [k,v] of quotas)if(v.until<Date.now())quotas.delete(k);},60000);cleanup.unref();
 const cookieName='game_'+config.name.replaceAll('-','_');
 const sign=value=>createHmac('sha256',sessionSecret).update('standalone:'+config.name+':'+value).digest('base64url');
 const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 function account(req){
  const token=req.headers['x-runtime-token'];
  if(token!==undefined)return equal(token,runtimeToken)&&/^[a-f0-9]{64}$/.test(req.headers['x-utxoplay-account']||'')?{id:req.headers['x-utxoplay-account'],service:true}:null;
  try{
   const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
   if(!value)return null;
   const [payload,mac]=value.split('.');if(!equal(mac,sign(payload)))return null;
   const user=JSON.parse(Buffer.from(payload,'base64url'));
   return /^[a-f0-9]{64}$/.test(user.id)&&user.expires>Date.now()?{id:user.id,guest:true}:null;
  }catch{return null;}
 }
 function guest(req,res){
  const existing=account(req);if(existing)return existing;
  if(req.headers['x-runtime-token']!==undefined)return null;
  if(limited('guest:'+req.ip,40,86400000)||quotas.size>20000)return null;
  const user={id:randomBytes(32).toString('hex'),expires:Date.now()+7*86400000};
  const payload=Buffer.from(JSON.stringify(user)).toString('base64url');
  res.cookie(cookieName,payload+'.'+sign(payload),{httpOnly:true,secure:origin.startsWith('https:'),sameSite:'lax',path:'/',maxAge:7*86400000});
  return {id:user.id,guest:true};
 }
 const needUser=(req,res,next)=>{req.account=account(req);if(!req.account)return res.status(401).json({error:'Open the game to start a session.'});next();};
 app.use((req,res,next)=>{
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"});
  if(quotas.size>20000||limited('request:'+req.ip,3000,60000))return res.status(429).json({error:'Please slow down.'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!account(req)?.service&&req.headers.origin!==origin)return res.status(403).json({error:'Game origin rejected'});
  if(req.path.includes('/api/'))res.set('Cache-Control','no-store');
  next();
 });
 app.use(express.json({limit:'64kb'}));
 app.get('/api/me',(req,res)=>res.json({user:account(req)}));
 app.post('/api/guest',(req,res)=>{const user=guest(req,res);res.status(user?200:429).json(user?{user}:{error:'Session unavailable'});});
 app.get('/health',(_req,res)=>res.json({ok:true,service:config.name}));
 app.get('/',(_req,res)=>res.redirect(302,'/games/'+config.games[0].id+'/'));
 for(const game of config.games){
  const base='/games/'+game.id;
  app.get(base,(req,res,next)=>req.path.endsWith('/')?next():res.redirect(308,base+'/'));
  app.get(base+'/api/me',(req,res)=>res.json({user:account(req)}));
  app.post(base+'/api/guest',(req,res)=>{const user=guest(req,res);res.status(user?200:429).json(user?{user}:{error:'Session unavailable'});});
 }
 const plugin=install({app,account,needUser,limited,runtimeFetch:fetchImpl,runtimeUrl,runtimeToken});
 for(const game of config.games){
  const base='/games/'+game.id;
  app.use(base+'/api',needUser,async(req,res)=>{
   const endpoint=req.path;
   if(!((req.method==='GET'&&['/state','/export'].includes(endpoint))||(req.method==='POST'&&['/new','/action','/replay'].includes(endpoint))))return res.status(404).json({error:'Unknown game endpoint'});
   if(req.method==='POST'&&limited(req.account.id+':'+game.id+':'+endpoint,endpoint==='/new'?10:1200,60000))return res.status(429).json({error:'Please wait before trying again.'});
   if(req.body?.type==='create'&&limited(req.account.id+':'+game.id+':rooms',20,3600000))return res.status(429).json({error:'Room limit reached.'});
   try{
    const result=await fetchImpl(runtimeUrl+game.runtimePath+'/api'+endpoint,{method:req.method,headers:{'Content-Type':'application/json','X-Runtime-Token':runtimeToken,'X-UTXOPlay-Account':req.account.id},body:req.method==='POST'?JSON.stringify(req.body||{}):undefined,signal:AbortSignal.timeout(20000)});
    if(endpoint==='/export')res.set('Content-Disposition',`attachment; filename="${game.id}-session.json"`);
    res.status(result.status).type('json').send(await result.text());
   }catch{res.status(503).json({error:'The game runtime is unavailable. Your saved progress is safe.'});}
  });
  app.use(base,(req,res,next)=>{if(req.path==='/'||req.path==='/index.html')guest(req,res);next();},optimizedStatic(game.webRoot));
 }
 app.use((_req,res)=>res.status(404).json({error:'Not found'}));
 app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.status===413?'Request too large':'Unable to complete request'}));
 const routes=new Map(config.games.filter(g=>g.socket).map(g=>['/games/'+g.id+'/api/socket',{url:runtimeUrl+g.runtimePath+'/api/socket',token:runtimeToken}]));
 const sockets=gameSockets({account,origin,limited,routes});
 return {app,account,db:plugin.db,attachSockets:sockets.attach,close(){plugin.close();sockets.close();clearInterval(cleanup);}};
}
