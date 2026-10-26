import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
test('room migration preserves membership, is repeatable, and rolls back conflicts without changing the source',()=>{
 const dir=mkdtempSync(join(tmpdir(),'chess-import-')),source=join(dir,'store.sqlite'),dest=join(dir,'rooms.sqlite');
 const old=new DatabaseSync(source);old.exec('CREATE TABLE chess_rooms(id TEXT PRIMARY KEY,white TEXT,black TEXT,created INTEGER NOT NULL);');
 old.prepare('INSERT INTO chess_rooms VALUES(?,?,?,?)').run('a'.repeat(24),'1'.repeat(64),'2'.repeat(64),1234);
 const run=()=>execFileSync(process.execPath,['tools/import-store-rooms.mjs',source,dest],{encoding:'utf8'});
 try{
  assert.match(run(),/Imported 1/);assert.match(run(),/Imported 0/);
  const db=new DatabaseSync(dest);const original=old.prepare('SELECT * FROM chess_rooms').get();assert.deepEqual({...db.prepare('SELECT * FROM chess_rooms').get()},{...original});
  db.prepare('UPDATE chess_rooms SET black=?').run('3'.repeat(64));db.close();
  assert.notEqual(spawnSync(process.execPath,['tools/import-store-rooms.mjs',source,dest]).status,0);
  assert.deepEqual({...old.prepare('SELECT * FROM chess_rooms').get()},{...original});
 }finally{old.close();rmSync(dir,{recursive:true,force:true});}
});
