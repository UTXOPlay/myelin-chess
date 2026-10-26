// Run with both services stopped, against a SQLite backup of the old store.
// This copies membership only. Keep the original native account/room data paths.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
const [source,destination]=process.argv.slice(2);
if(!source||!destination)throw Error('Usage: node tools/import-store-rooms.mjs STORE_BACKUP.sqlite ROOMS.sqlite');
if(path.resolve(source)===path.resolve(destination))throw Error('Source and destination must differ');
const old=new DatabaseSync(source,{readOnly:true});
mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
const db=new DatabaseSync(destination);
db.exec('CREATE TABLE IF NOT EXISTS chess_rooms(id TEXT PRIMARY KEY,white TEXT,black TEXT,created INTEGER NOT NULL);');
const insert=db.prepare('INSERT INTO chess_rooms VALUES(?,?,?,?)');
const lookup=db.prepare('SELECT * FROM chess_rooms WHERE id=?');
let count=0;
try{
 db.exec('BEGIN IMMEDIATE');
 for(const room of old.prepare('SELECT id,white,black,created FROM chess_rooms').all()){
  const existing=lookup.get(room.id);
  if(existing){if(JSON.stringify(existing)!==JSON.stringify(room))throw Error('Conflicting room '+room.id);continue;}
  insert.run(room.id,room.white,room.black,room.created);count++;
 }
 db.exec('COMMIT');console.log(`Imported ${count} rooms; existing matching rooms retained.`);
}catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();old.close();}
