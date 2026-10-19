import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ExtractionStore, extractionAlive, extractionSummary } from './extraction-bot-state.mjs';

export class ExtractionBotControl {
  constructor({root,directory}) { this.root=root; this.store=new ExtractionStore(root,directory); }
  status() { return extractionSummary(this.store.initialize()); }
  start() {
    const state=this.store.initialize();
    const lock=path.join(this.store.directory,'worker.lock');
    if(extractionAlive(state.pid) || (fs.existsSync(lock)&&extractionAlive(JSON.parse(fs.readFileSync(lock,'utf8')).pid))) {
      this.store.command('resume'); return this.status();
    }
    state.control.pauseAfterBatch=false; state.status='starting'; state.error=''; this.store.save(state);
    const log=fs.openSync(path.join(this.store.directory,'worker.log'),'a');
    let child;
    try { child=spawn(process.execPath,[path.join(this.root,'scripts/run-location-extractor.mjs')],{cwd:this.root,detached:true,windowsHide:true,stdio:['ignore',log,log]}); }
    finally { fs.closeSync(log); }
    child.on('error',error=>{const current=this.store.load();current.status='paused_for_review';current.error=error.message;this.store.save(current);});
    state.pid=child.pid; this.store.save(state); child.unref(); return this.status();
  }
  pause() {
    const s=this.store.initialize();
    if(extractionAlive(s.pid)) this.store.command('pause');
    else {s.control.pauseAfterBatch=true;s.status='paused';this.store.save(s);}
    return this.status();
  }
}
