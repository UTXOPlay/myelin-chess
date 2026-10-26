import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createGameHost} from './server.mjs';
const config=JSON.parse(readFileSync(new URL('../game-host.json',import.meta.url)));
const port=Number(process.env.WEB_PORT||config.port),runtimePort=Number(process.env.RUNTIME_PORT||config.runtimePort);
const origin=process.env.GAME_ORIGIN||`http://127.0.0.1:${port}`;
const runtimeUrl=process.env.RUNTIME_URL||`http://127.0.0.1:${runtimePort}`;
const runtimeToken=process.env.RUNTIME_TOKEN;
if(!runtimeToken||runtimeToken.length<32)throw Error('Set a stable RUNTIME_TOKEN of at least 32 characters.');
let child,service,server,stopping=false;
const install=config.plugin?(await import(new URL(config.plugin,import.meta.url))).install:undefined;
service=createGameHost({config,origin,runtimeUrl,runtimeToken,sessionSecret:process.env.SESSION_SECRET||runtimeToken,install});
server=service.app.listen(port,process.env.BIND||'127.0.0.1',()=>console.log(`${config.name}: ${origin}`));
service.attachSockets(server);
if(!process.env.RUNTIME_URL){
 const [command,...args]=config.runtimeCommand;
 child=spawn(process.env.RUNTIME_BINARY||command,args,{stdio:'inherit',env:{...process.env,PORT:String(runtimePort),BIND:'127.0.0.1'}});
 child.on('error',error=>{console.error(error);stop(1);});
 child.on('exit',code=>{if(!stopping)stop(code||1);});
}
server.on('error',error=>{console.error(error);stop(1);});
function stop(code=0){if(stopping)return;stopping=true;child?.kill('SIGTERM');service?.close();server?.close(()=>process.exit(code));setTimeout(()=>{child?.kill('SIGKILL');process.exit(code);},3000).unref();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
