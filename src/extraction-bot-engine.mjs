import { newExtractionBatch } from './extraction-bot-state.mjs';

export class ExtractionPaused extends Error {}

/** UI adapter is injected so crash recovery, capping, and progress decisions can be tested. */
export class ExtractionEngine {
  constructor({ store, browser, sleep = ms => new Promise(r=>setTimeout(r,ms)), now = Date.now, pollMs = 5000, stallMs = 12*60*1000, lastPageStallMs = 60*1000, matchExport = null, overlapMatching = false }) {
    Object.assign(this, { store, browser, sleep, now, pollMs, stallMs, lastPageStallMs, matchExport, overlapMatching });
    this.matchTasks = new Map();
  }
  async run() {
    this.state = this.store.initialize(); const s = this.state;
    s.pid = process.pid; s.status = 'running'; s.error = ''; this.store.save(s);
    try {
      if(this.overlapMatching) for(const batch of s.batches.filter(b=>b.phase==='matching')) {
        if(s.activeBatchId===batch.id) s.activeBatchId=null;
        this.startMatching(batch);
      }
      while (true) {
        if(this.matchError) throw this.matchError;
        this.store.applyCommand(s);
        let b = s.batches.find(b=>b.id === s.activeBatchId);
        if (!b && s.control.pauseAfterBatch) { await this.drainMatching(); break; }
        if (!b && !s.locations.some(l=>l.status==='pending')) { await this.drainMatching(); s.status=s.locations.some(l=>['needs_split','tag_unavailable','searched_short_export','too_small_for_extractor'].includes(l.status))?'queue_finished_with_review':'queue_finished'; this.store.save(s); return; }
        if (!b) { b = newExtractionBatch(s); this.store.save(s); }
        if (b.phase === 'building') await this.build(b);
        if (!b.locationIds.length) { s.activeBatchId=null; this.store.save(s); continue; }
        if (b.phase === 'planned') {
          await this.browser.restoreSearch(b, s);
          b.phase='creating_list'; this.store.save(s);
        }
        if (b.phase === 'creating_list') {
          // Idempotent: find the exact existing name before any create action.
          b.listUrl = await this.browser.ensureList(b.listName, s.folder);
          b.phase='list_ready'; this.store.event(s,'Location list ready',{ batchId:b.id, listName:b.listName });
        }
        if (b.phase === 'list_ready') {
          await this.browser.restoreSearch(b,s);
          const liveSize=await this.browser.searchSize();
          if(liveSize.pages>s.maxPages || liveSize.capped || liveSize.pages<2) throw new ExtractionPaused('Search page count changed outside the 2–99 page range; no extraction started.');
          b.pages=liveSize.pages;b.expectedTotal=liveSize.total;b.resultLabel=liveSize.label;this.store.save(s);
          await this.browser.selectList(b.listName);
          b.phase='starting'; this.store.save(s); // A crash after click must never repeat the click blindly.
          await this.browser.startExtraction();
          b.phase='extracting'; b.startedAt=new Date(this.now()).toISOString(); b.lastProgressAt=this.now(); this.store.save(s);
          if(this.browser.proof) await this.browser.proof(this.store.directory,b);
        }
        if (['adopt','starting','extracting'].includes(b.phase)) await this.monitor(b);
        if (b.phase === 'exporting') {
          b.exportPath = await this.browser.exportList(b, this.store.directory);
          b.phase='matching'; this.store.save(s);
        }
        if (b.phase === 'matching') {
          if(this.overlapMatching) {
            s.activeBatchId=null;
            this.store.save(s);
            this.startMatching(b);
          } else await this.finishMatching(b);
        }
        if (b.phase === 'needs_review') throw new ExtractionPaused(b.error || 'Current batch needs review');
      }
      s.status='paused'; this.store.save(s);
    } catch(error) {
      // Allow already-started local comparisons to checkpoint before the worker exits.
      await Promise.all(this.matchTasks.values());
      s.status='paused_for_review'; s.error=error.message; this.store.event(s,'Bot paused',{ error:error.message }); throw error;
    }
  }
  startMatching(b) {
    if(this.matchTasks.has(b.id)) return;
    const task=this.finishMatching(b).catch(error=>{
      b.matchError=error.message;
      this.matchError=error;
      this.store.event(this.state,'Register comparison needs review',{batchId:b.id,error:error.message});
    }).finally(()=>this.matchTasks.delete(b.id));
    this.matchTasks.set(b.id,task);
  }
  async drainMatching() {
    await Promise.all(this.matchTasks.values());
    if(this.matchError) throw this.matchError;
  }
  async finishMatching(b) {
    const s=this.state;
    if (this.matchExport && b.exportPath && s.automaticMatching) b.matchJobId = await this.matchExport(b.exportPath, b);
    delete b.matchError;
    b.phase='done'; b.finishedAt=new Date(this.now()).toISOString();
    for (const id of b.locationIds) { const l=s.locations.find(x=>x.id===id); if(l) l.status=b.coverage==='short_export'?'searched_short_export':'searched'; }
    // Only broad searches with reconciled totals can supersede locality searches.
    for (const id of b.locationIds) {
      const parent=s.locations.find(x=>x.id===id);
      if(parent?.kind==='state' && b.coverage==='count_reconciled') for(const l of s.locations) if(l.state===parent.state && l.status==='pending') l.status='searched_by_state';
    }
    if(s.activeBatchId===b.id) s.activeBatchId=null;
    this.store.event(s,'Batch saved and compared',{ batchId:b.id, savedContacts:b.savedContacts, coverage:b.coverage });
  }
  async build(b) {
    const s=this.state;
    if(b.probeId) { const l=s.locations.find(l=>l.id===b.probeId); if(l?.status==='probing') l.status='pending'; b.probeId=null; }
    await this.browser.restoreSearch(b,s);
    for(const l of s.locations.filter(l=>l.status==='pending')) {
      if(this.matchError) throw this.matchError;
      if(l.status!=='pending') continue; // A background state comparison may have reconciled its coverage.
      this.store.applyCommand(s);
      if(s.control.pauseAfterBatch && !b.locationIds.length) { s.activeBatchId=null; this.store.save(s); return; }
      // Do not combine states: makes names, coverage accounting and later catch-ups clear.
      const first=s.locations.find(x=>x.id===b.locationIds[0]); if(first && first.state!==l.state) break;
      l.status='probing'; b.probeId=l.id; this.store.save(s);
      const added=await this.browser.addLocation(l);
      if(!added) { l.status='tag_unavailable'; b.probeId=null; this.store.save(s); continue; }
      const size=await this.browser.searchSize({alreadySettled:true});
      if(size.pages>s.maxPages || size.capped) {
        await this.browser.removeLocation(l);
        l.status=b.locationIds.length?'pending':'needs_split'; b.probeId=null; this.store.save(s);
        if(b.locationIds.length) break; continue;
      }
      if(size.total===0) { await this.browser.removeLocation(l); l.status='no_results'; b.probeId=null; this.store.save(s); continue; }
      if(size.pages<2 && !b.locationIds.length) { /* small tags can combine with subsequent tags */ }
      b.locationIds.push(l.id); l.status='batched'; b.probeId=null; b.pages=size.pages; b.expectedTotal=size.total; b.resultLabel=size.label;
      b.searchUrl=await this.browser.searchUrl(); this.store.save(s);
      if(l.kind==='state' || size.pages>=s.maxPages) break;
    }
    if(b.locationIds.length && b.pages<2) {
      for(const id of b.locationIds) s.locations.find(l=>l.id===id).status='too_small_for_extractor';
      b.phase='needs_review'; b.error='Only one page; extractor requires at least two pages'; this.store.save(s); throw new ExtractionPaused(b.error);
    }
    b.phase='planned'; this.store.save(s);
  }
  async monitor(b) {
    const s=this.state;
    await this.browser.adopt(b,s); // validates search geography + exact selected list
    let inactive=0;
    while(true) {
      if(this.matchError) throw this.matchError;
      this.store.applyCommand(s);
      const p=await this.browser.progress(b);
      const signature=JSON.stringify([p.page,p.extracting,p.saved]);
      if(signature!==b.progressSignature) { b.progressSignature=signature; b.lastProgressAt=this.now(); }
      b.lastProgressAt ||= this.now();
      b.lastProgress=p; b.maxExtracted=Math.max(b.maxExtracted||0,p.extracting||0); b.savedContacts=p.saved;
      // state.json is several MB in a synced folder; progress counters are re-read on adopt,
      // so checkpoint them every 30s rather than on every poll.
      if(!(this.now()-this.lastProgressSave<30000)) { this.store.save(s); this.lastProgressSave=this.now(); }
      if(p.active) {
        inactive=0;
        if(p.atLastPage && this.browser.stopExtraction && this.now()-b.lastProgressAt>this.lastPageStallMs) {
          await this.browser.stopExtraction(b);
          this.store.event(s,'Final page stopped changing; finishing saved export',{batchId:b.id});
        }
        if(this.now()-b.lastProgressAt>this.stallMs) throw new ExtractionPaused('Extraction stalled for 12 minutes. Existing browser job was left intact; inspect it before resuming.');
      } else {
        inactive++;
        // Never equate a hidden extractor to completion. Verify it is inactive twice,
        // and cross-check the actual list count and last search page.
        if(inactive>=2) {
          const final=await this.browser.finalCounts(b);
          b.savedContacts=final.saved; b.emailsFound=final.emails;
          const minimum=b.expectedTotal ?? Math.max(0,(b.pages-1)*25+1);
          b.coverage=final.saved>=minimum?'count_reconciled':'short_export';
          if(!final.saved || (p.page < b.pages && !p.atLastPage)) throw new ExtractionPaused('Extraction stopped before the last page; batch needs review, not automatic restart.');
          b.phase='exporting'; this.store.event(s,'Extraction stopped; saved count reconciled',{batchId:b.id,savedContacts:final.saved,coverage:b.coverage}); return;
        }
      }
      await this.sleep(this.pollMs);
    }
  }
}
