import fs from 'node:fs';
import path from 'node:path';
import { atomicCheckpoint } from './extraction-bot-state.mjs';

/** Summaries are small; do not repeatedly parse all full comparison reports. */
export function schoolQueueSnapshot(agents) {
  const jobs=fs.readdirSync(agents.storage).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>{
    const job=agents.get(f.slice(0,-5));let summary={};
    try {summary=JSON.parse(fs.readFileSync(path.join(agents.directory(job.id),'summary.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    return {...job,summary};
  }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const counts={pending:0,checked:0,confirmed:0,databaseUpdated:0};
  for(const job of jobs) {
    const v=job.summary.verificationCounts||{};
    counts.pending+=v.pending_school_check||0;counts.confirmed+=v.confirmed||0;
    counts.checked+=Object.entries(v).filter(([k])=>!['pending_school_check','not_queued'].includes(k)).reduce((n,[,v])=>n+v,0);
    counts.databaseUpdated+=job.summary.databaseCounts?.candidate_updated||0;
  }
  return {jobs,counts,next:jobs.find(j=>['ready','stopped'].includes(j.status) && j.summary.verificationCounts?.pending_school_check>0)};
}

export class SchoolBot {
  constructor({agents,directory,batchSize=10,delayMs=8000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
    Object.assign(this,{agents,directory,batchSize,delayMs,sleep});
    fs.mkdirSync(directory,{recursive:true});
    this.state={version:1,pid:process.pid,status:'starting',startedAt:new Date().toISOString(),activeJobId:null,error:'',minimumDelaySeconds:delayMs/1000};
  }
  publish(snapshot=schoolQueueSnapshot(this.agents)) {
    this.state.counts=snapshot.counts;this.state.updatedAt=new Date().toISOString();
    atomicCheckpoint(path.join(this.directory,'state.json'),JSON.stringify(this.state,null,2));
  }
  stopping(){return fs.existsSync(path.join(this.directory,'pause'));}
  async run() {
    try {
      while(!this.stopping()) {
        const snapshot=schoolQueueSnapshot(this.agents);this.publish(snapshot);
        if(snapshot.jobs.some(j=>['verifying','stopping'].includes(j.status)&&j.phase==='verifying')) {
          this.state.status='waiting_for_verifier';this.publish(snapshot);await this.sleep(5000);continue;
        }
        const job=snapshot.next;
        if(!job){this.state.status='waiting_for_matches';this.publish(snapshot);await this.sleep(5000);continue;}
        const report=this.agents.report(job.id);
        if(report?.dataKind!=='real_search_export')throw new Error('Only real comparison reports can enter the school queue');
        // No rechecking completed/unavailable results unless explicitly requested separately.
        if(!report.profiles.some(p=>p.verificationStatus==='pending_school_check'&&!p.verification))
          throw new Error(`Pending summary differs from saved evidence for ${job.name}; inspect before continuing`);
        this.state.status='verifying';this.state.activeJobId=job.id;this.state.activeRunName=job.name;this.publish(snapshot);
        this.agents.startVerification(job.id,{limit:this.batchSize,delayMs:this.delayMs});
        const child=this.agents.children.get(job.id);
        const completed=new Promise(resolve=>child.once('close',()=>resolve()));
        let done=false;completed.then(()=>{done=true;});
        while(!done){
          if(this.stopping() && this.agents.get(job.id).status==='verifying')this.agents.stop(job.id);
          this.publish();await Promise.race([completed,this.sleep(5000)]);
        }
        const result=this.agents.get(job.id);
        this.state.activeJobId=null;delete this.state.activeRunName;this.publish();
        if(!['ready','stopped'].includes(result.status))throw new Error(result.error||'School verification paused for review');
        if(result.status==='stopped')fs.writeFileSync(path.join(this.directory,'pause'),'Stopped from the matching dashboard');
      }
      this.state.status='paused';this.publish();
    } catch(error){this.state.status='paused_for_review';this.state.error=error.message;this.publish();throw error;}
  }
}
