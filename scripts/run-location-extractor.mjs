import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { ExtractionStore } from '../src/extraction-bot-state.mjs';
import { ExtractionEngine } from '../src/extraction-bot-engine.mjs';
import { SalesnavExtractionBrowser } from '../src/salesnav-extraction-browser.mjs';
import { LocationAgents } from '../src/location-agents.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store=new ExtractionStore(root,path.join(path.dirname(path.resolve(process.env.DATABASE_PATH||path.join(root,'data/hcrhub.sqlite'))),'extraction-bot'));
const release=store.lock();
const endpoint=process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Use a local Brave debugging endpoint');
let state=store.initialize();
state.pid=process.pid; state.status='waiting_for_browser'; state.error=''; store.save(state);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;store.command('pause');});
process.on('SIGINT',()=>{stopping=true;store.command('pause');});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  while(true) {
    state=store.load(); store.applyCommand(state);
    if(stopping || state.control.pauseAfterBatch) {state.status='paused';store.save(state);break;}
    try {
      const res=await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(2500)});
      if(!res.ok) throw new Error('Debugging connection unavailable');
    } catch {
      state.status='waiting_for_browser';state.error='Waiting for Brave debugging on 127.0.0.1:9222. The bot never restarts Brave or interrupts the current extraction.';store.save(state);
      await sleep(10000);continue;
    }
    const browser=await chromium.connectOverCDP(endpoint);
    const adapter=new SalesnavExtractionBrowser(browser,{root});
    await adapter.initialize();
    store.event(store.load(),'Optimized extraction worker connected',{pollSeconds:5,finalPageStableSeconds:60,overlapMatching:true});
    const agents=new LocationAgents({root,database:path.resolve(process.env.DATABASE_PATH||path.join(root,'data/hcrhub.sqlite')),allowConcurrentMatching:true});
    const matchExport=async(filename,batch)=>{
      const previous=agents.list().find(j=>j.filenames.includes(path.basename(filename)));
      if(previous) {
        // A crash can occur after launching matching but before saving its job ID.
        while(['matching','stopping'].includes(agents.get(previous.id).status) && agents.get(previous.id).phase==='matching') await sleep(2000);
        if(!['ready','verifying'].includes(agents.get(previous.id).status)) throw new Error('Previous comparison failed; inspect it before resuming');
        return previous.id;
      }
      while(agents.list().some(j=>['matching','stopping'].includes(j.status) && j.phase==='matching')) await sleep(5000);
      const job=agents.create({name:batch.listName,realData:true,files:[{filename:path.basename(filename),fileBase64:fs.readFileSync(filename).toString('base64')}]});
      const child=agents.children.get(job.id);if(child) await once(child,'close');
      if(agents.get(job.id).status!=='ready') throw new Error('Register matching failed; export retained for review');
      return job.id;
    };
    const engine=new ExtractionEngine({store,browser:adapter,matchExport,overlapMatching:true});
    await engine.run();
    // Deliberately never call browser.close(): this is the user's real Brave.
    break;
  }
} catch(error) {
  state=store.load();state.status='paused_for_review';state.error=error.message;store.event(state,'Worker paused',{error:error.message});
  console.error(error.stack);process.exitCode=1;
} finally {release();}
// Close only this Node connection/process; keep Brave and extension extraction alive.
process.exit(process.exitCode||0);
