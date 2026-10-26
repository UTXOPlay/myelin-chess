// Build a self-contained browser package for each configured game. Source paths
// stay intact because native Myelin profiles commit to several source files.
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const config=JSON.parse(readFileSync('game-host.json','utf8'));
for(const game of config.games) {
 const build=`tools/build-${game.id}.mjs`;
 if(existsSync(build))await import(path.resolve(build));
}
function rewrite(dir,id) {
 for(const entry of readdirSync(dir,{withFileTypes:true})) {
  const file=path.join(dir,entry.name);
  if(entry.isDirectory()){rewrite(file,id);continue;}
  if(!/\.(?:js|mjs|css|html|json|webmanifest)$/.test(file))continue;
  let text=readFileSync(file,'utf8');
  // Service-local assets work both standalone and through any compatible gateway.
  text=text.replaceAll('/arcade/',`/games/${id}/_arcade/`).replaceAll('/atelier/',`/games/${id}/_atelier/`);
  for(const prefix of ['/assets/','/brand/','/game-shell.','/game-loader.','/game-overlay.','/widescreen.','/fonts.','/brand.','/favicon','/apple-touch-icon.','/site.webmanifest'])
   text=text.replaceAll(prefix,(match,offset,source)=>offset===0||/["'`(=\s]/.test(source[offset-1])?`/games/${id}/_shared${prefix}`:match);
  text=text.replaceAll("'/api/me'",`'/games/${id}/api/me'`).replaceAll('"/api/me"',`"/games/${id}/api/me"`)
   .replaceAll("'/api/guest'",`'/games/${id}/api/guest'`).replaceAll('"/api/guest"',`"/games/${id}/api/guest"`);
  writeFileSync(file,text);
 }
}
rmSync('dist',{recursive:true,force:true});
for(const game of config.games) {
 const dest=game.webRoot;mkdirSync(dest,{recursive:true});
 cpSync(`games/${game.id}/web`,dest,{recursive:true,filter:p=>!p.endsWith('.br')&&(!p.endsWith('.gz')||p.endsWith('.tar.gz'))});
 cpSync('public',path.join(dest,'_shared'),{recursive:true});
 for(const family of ['arcade','atelier'])if(existsSync(`games/${family}/web`))cpSync(`games/${family}/web`,path.join(dest,'_'+family),{recursive:true});
 rewrite(dest,game.id);
}
console.log(`Built ${config.games.map(g=>g.id).join(', ')} without a store checkout.`);
