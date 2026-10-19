import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocationAgents } from '../src/location-agents.mjs';
import { SchoolBot } from '../src/school-bot.mjs';
import { extractionAlive } from '../src/extraction-bot-state.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const database=path.resolve(process.env.DATABASE_PATH||path.join(root,'data/hcrhub.sqlite'));
const directory=path.join(path.dirname(database),'school-bot');fs.mkdirSync(directory,{recursive:true});
const stateFile=path.join(directory,'state.json'),lockFile=path.join(directory,'worker.lock'),pauseFile=path.join(directory,'pause');
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
if(process.argv.includes('--status')){
  const state=read(stateFile)||{status:'not_started'};
  console.log(JSON.stringify({...state,workerAlive:extractionAlive(state.pid)},null,2));
} else if(process.argv.includes('--stop')){
  fs.writeFileSync(pauseFile,'pause after the current profile');console.log('Pause requested; current profile will finish and save.');
} else if(process.argv.includes('--start')){
  const lock=read(lockFile);if(lock&&extractionAlive(lock.pid)){console.log(`School bot is already running (${lock.pid}).`);}
  else {
    fs.rmSync(pauseFile,{force:true});
    const log=fs.openSync(path.join(directory,'worker.log'),'a');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log]});
    fs.closeSync(log);child.unref();console.log(`Independent school bot started (${child.pid}).`);
  }
} else {
  const old=read(lockFile);
  if(old&&extractionAlive(old.pid))throw new Error('Another school supervisor is already running');
  if(old)fs.rmSync(lockFile);
  fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid}),{flag:'wx'});
  const stop=()=>fs.writeFileSync(pauseFile,'pause after the current profile');
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    const agents=new LocationAgents({root,database,allowConcurrentMatching:true});
    const previous=read(stateFile);
    if(previous?.activeJobId) {
      const job=agents.get(previous.activeJobId);
      if(job.status==='interrupted' && job.phase==='verifying' && !extractionAlive(job.pid)) {
        const verifierLock=path.join(agents.directory(job.id),'verifier.lock');
        const owner=read(verifierLock);
        if(owner && (owner.pid!==job.pid || extractionAlive(owner.pid)))throw new Error('Previous verifier lock ownership needs review');
        if(owner)fs.rmSync(verifierLock);
        job.status='ready';job.error='';agents.save(job);
      }
    }
    await new SchoolBot({agents,directory}).run();
  } catch(error){console.error(error.stack);process.exitCode=1;}
  finally {fs.rmSync(lockFile,{force:true});}
}
