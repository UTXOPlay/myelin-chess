import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {installChessRooms} from './chess-rooms.mjs';
export function createChessPlugin(dataDir){
 return options=>{
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(dataDir,'rooms.sqlite'));
  db.exec('PRAGMA journal_mode=WAL;');
  const rooms=installChessRooms({...options,db});
  return {db,close(){rooms.close();db.close();}};
 };
}
export function install(options){return createChessPlugin(process.env.ROOMS_DATA_DIR||path.join(process.env.DATA_DIR||'data','rooms'))(options);}
