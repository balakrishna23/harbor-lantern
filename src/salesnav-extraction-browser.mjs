import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocationFiles } from './location-sheet-match.mjs';
import { persistentBrowserDownload } from './persistent-browser-download.mjs';

const clean = s => String(s||'').replace(/\s+/g,' ').trim();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
export const selectedRegionIds = value => {
  try {
    const q=new URL(value).searchParams.get('query') || '';
    const region=q.split('type:REGION')[1]?.split('type:')[0] || '';
    return [...region.matchAll(/\(id:([^,]+),text:[^)]*?selectionType:(INCLUDED|EXCLUDED)\)/g)].map(m=>`${m[1]}:${m[2]}`).sort().join('|');
  } catch { return ''; }
};

export function geographyIncludePattern(location) {
  const requested=location.kind==='state'?`${location.state}, Australia`:location.query;
  const escaped=requested.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('^Include \u201c'+escaped+'(?: \\([\\d,.KM+]+\\))?\u201d in Region filter$');
}

export class SalesnavExtractionBrowser {
  constructor(browser, { root, folderUrl='https://apps.growmeorganic.com/dashboard/b2b/features/my-lists/6ad4ecc33f3cf5d6318b4931', wait=sleep }={}) {
    this.browser=browser; this.root=root; this.folderUrl=folderUrl;this.wait=wait;
  }
  async initialize() {
    const pages=this.browser.contexts().flatMap(c=>c.pages());
    const sales=pages.filter(p=>/^https:\/\/www\.linkedin\.com\/sales\/search\/people/.test(p.url()));
    if(sales.length>1) throw new Error('More than one Sales Navigator search tab is open. Keep one extraction tab to avoid controlling the wrong search.');
    this.sales=sales[0] || await this.browser.contexts()[0].newPage();
    this.sales.setDefaultTimeout(15000);this.sales.setDefaultNavigationTimeout(30000);
    if(!sales.length) await this.sales.goto('https://www.linkedin.com/sales/search/people',{waitUntil:'domcontentloaded'});
    this.organic=pages.find(p=>/^https:\/\/apps\.growmeorganic\.com\/dashboard\/b2b\/features\/my-lists/.test(p.url())) || await this.browser.contexts()[0].newPage();
    this.organic.setDefaultTimeout(15000);this.organic.setDefaultNavigationTimeout(30000);
    if(!this.organic.url().startsWith(this.folderUrl)) await this.organic.goto(this.folderUrl,{waitUntil:'domcontentloaded'});
    await this.guard(this.sales); await this.guard(this.organic);
  }
  async guard(page) {
    if(/\/login|\/checkpoint|\/challenge|\/authwall|sign-in/i.test(page.url())) throw new Error('Browser sign-in or verification is required. Complete it manually, then resume.');
    const text=await page.locator('body').innerText();
    if(/unusual activity|temporarily restricted|too many requests|weekly search limit|commercial use limit|complete.{0,25}captcha|verify you are human/i.test(text)) throw new Error('The website is showing an access restriction or verification. Bot paused.');
  }
  async body(page=this.sales) { await this.guard(page); return page.locator('body').innerText(); }
  async settled() {
    // Allow server-backed results to replace the previous search, then require a stable page count.
    await sleep(2000); let previous=''; let stable=0;
    for(let i=0;i<40;i++) {
      const text=await this.body();
      const pages=text.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
      const label=text.match(/([\d,.]+(?:K|M)?\+?)\s+results(?:\s+found)?/i)?.[1];
      const empty=/no results found|no leads found|no leads matched your search|\b0 results\b/i.test(text);
      const small=/^[\d,]+$/.test(label||'') && Number(label.replaceAll(',',''))<=25;
      const loading=await this.sales.locator('[aria-busy="true"]').count();
      const signature=JSON.stringify([pages?.[0],label,empty]);
      if(!loading && (pages || empty || small)) { stable=signature===previous?stable+1:0; if(stable>=2) return; }
      previous=signature; await sleep(600);
    }
    throw new Error('Search results did not reach a stable page count; no extraction started.');
  }
  async closeExtractor() {
    const start=this.sales.getByRole('button',{name:'Extract emails from this search',exact:true});
    const running=this.sales.getByRole('button',{name:'In progress / click to stop..',exact:true});
    if(await running.count()) throw new Error('An extraction is already running. Adopt that batch before changing search filters.');
    if(await start.count()) {
      const close=this.sales.locator('body').getByText('@ GrowMeOrganic - Emails Extractor',{exact:true});
      if(await close.count()) await close.click(); // Some versions use an x instead; search actions still work with panel open.
    }
  }
  async restoreSearch(batch,state) {
    await this.guard(this.sales);
    await this.openExtractor();
    const running=this.sales.getByRole('button',{name:'In progress / click to stop..',exact:true});
    if(await running.count()) throw new Error('A live extraction exists; search changes are paused to preserve it.');
    if(batch.searchUrl && selectedRegionIds(this.sales.url())===selectedRegionIds(batch.searchUrl)) {
      this.assertBatchSearch(batch);
      // Reset to page 1 before a NEW extraction; the extension starts from current page.
      const url=new URL(batch.searchUrl); url.searchParams.delete('page');
      if(this.sales.url()!==url.href) await this.sales.goto(url.href,{waitUntil:'domcontentloaded'});
      await this.settled(); return;
    }
    await this.sales.goto('https://www.linkedin.com/sales/search/people',{waitUntil:'domcontentloaded'});
    await this.sales.getByRole('button',{name:'Expand Current job title filter',exact:true}).click();
    // Use the input under the current title filter rather than the global keyword search.
    const job=this.sales.getByRole('combobox',{name:/Add current titles/i});
    if(await job.count()) await job.pressSequentially(state.title);
    else {
      const unlabelled=this.sales.getByRole('combobox',{name:'',exact:true});
      if(await unlabelled.count()!==1) throw new Error('Could not identify the current-title input');
      await unlabelled.pressSequentially(state.title);
    }
    await this.sales.getByRole('button',{name:'Include “Registered Nurse” in Current job title filter',exact:true}).click();
    await this.settled();
    for(const id of batch.locationIds) {
      const l=state.locations.find(l=>l.id===id); if(!l || !await this.addLocation(l)) throw new Error(`Previously selected location is unavailable: ${l?.query||id}`);
    }
    if(batch.locationIds.length) batch.searchUrl=this.sales.url();
  }
  async geographyInput() {
    const expand=this.sales.getByRole('button',{name:'Expand Geography filter',exact:true});
    if(await expand.count()) await expand.click();
    return this.sales.getByRole('combobox',{name:'Add locations',exact:true});
  }
  async addLocation(location) {
    const input=await this.geographyInput(); await input.fill(''); await input.pressSequentially(location.name,{delay:35});
    // Resolve by the semantic label, never by an option index: suggestions are
    // replaced asynchronously while cached counts are still on screen.
    const button=this.sales.getByRole('button',{name:geographyIncludePattern(location)});
    try { await button.waitFor({state:'visible',timeout:8000}); }
    catch(error) {
      if(error.name!=='TimeoutError')throw error;
      await this.guard(this.sales);await input.fill('');return false;
    }
    if(await button.count()!==1)throw new Error('Ambiguous duplicate geography suggestions');
    await button.click();await this.settled();return true;
  }
  async removeLocation(location) {
    const labels=[location.query,location.name,`${location.state}, Australia`];
    for(const label of labels) {
      const button=this.sales.getByRole('button',{name:`Remove Region filter: “${label}”`,exact:true});
      if(await button.count()===1) { await button.click(); await this.settled(); return; }
    }
    throw new Error(`Could not remove oversized location ${location.query}`);
  }
  async searchSize({alreadySettled=false}={}) {
    if(!alreadySettled) await this.settled(); const text=await this.body();
    if(/no results found|no leads matched your search|\b0 results\b/i.test(text)) return {pages:0,total:0,label:'0',capped:false};
    const label=text.match(/([\d,.]+(?:K|M)?\+?)\s+results(?:\s+found)?/i)?.[1] || '';
    const total=/^[\d,]+$/.test(label)?Number(label.replaceAll(',','')):null;
    const pages=Number(text.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] || (total>0&&total<=25?1:0));
    if(!pages) throw new Error('Missing page count');
    return { pages,total,label,capped:pages>=100 };
  }
  async searchUrl() { return this.sales.url(); }
  row(name) { return this.organic.getByRole('row').filter({has:this.organic.getByRole('textbox',{name,exact:true})}); }
  async listPage() {
    if(this.organic.url()===this.folderUrl) await this.organic.reload({waitUntil:'domcontentloaded'}); else await this.organic.goto(this.folderUrl,{waitUntil:'domcontentloaded'});
    await this.organic.getByRole('button',{name:' Create a new list',exact:true}).waitFor();
    await this.organic.getByText('Loading your lists',{exact:true}).waitFor({state:'hidden',timeout:30000});
    await this.guard(this.organic);
  }
  async ensureList(name,folder) {
    await this.listPage();
    if(await this.row(name).count()>1) throw new Error('Duplicate list names; manual review required');
    if(!await this.row(name).count()) {
      await this.organic.getByRole('button',{name:' Create a new list',exact:true}).click();
      await this.organic.getByRole('textbox',{name:'My list name',exact:true}).fill(name);
      // Folder preselection renders after the modal; do not treat that brief gap as a wrong folder.
      await this.organic.getByRole('combobox',{name:folder,exact:true}).waitFor({state:'visible',timeout:15000})
        .catch(()=>{throw new Error(`Select the ${folder} folder in GrowMeOrganic before resuming; no list created.`);});
      await this.organic.getByRole('button',{name:'Create this list',exact:true}).click();
      await this.row(name).waitFor({timeout:30000});
    }
    return this.row(name).getByRole('link',{name:'View the data as a table, filter it and create segments',exact:true}).getAttribute('href');
  }
  async openExtractor() {
    await this.guard(this.sales);
    if(await this.sales.getByRole('button',{name:/^Extract emails from this search$|^In progress \/ click to stop\.\.$/}).count()) return;
    await this.sales.getByText('@ GrowMeOrganic - Emails Extractor',{exact:true}).click();
    await this.sales.getByRole('button',{name:/^Extract emails from this search$|^In progress \/ click to stop\.\.$/}).waitFor({timeout:15000});
  }
  async selectList(name) {
    await this.openExtractor();
    await this.sales.getByText('Refresh my lists',{exact:true}).click(); await sleep(1200);
    const combo=this.sales.getByRole('combobox',{name:'',exact:true});
    await combo.click();
    await this.sales.getByRole('treeitem',{name:`${name} Press to select`,exact:true}).click();
    // Selected value lives in the item outside the dropdown, not all menu text.
    const text=await combo.innerText(); if(clean(text.split('\n')[0])!==name) throw new Error('Wrong GrowMeOrganic destination; extraction was not started.');
  }
  async startExtraction() {
    await this.sales.getByRole('button',{name:'Extract emails from this search',exact:true}).click();
    await this.sales.getByRole('button',{name:'In progress / click to stop..',exact:true}).waitFor({timeout:15000});
  }
  async stopExtraction(batch) {
    this.assertBatchSearch(batch);await this.assertDestination(batch);
    const p=await this.progress(batch);if(!p.atLastPage) throw new Error('Refusing to finish an extraction before its last page');
    const stop=this.sales.getByRole('button',{name:'In progress / click to stop..',exact:true});
    if(await stop.count()) await stop.click();
  }
  async adopt(batch,state) {
    await this.guard(this.sales);
    this.assertBatchSearch(batch);
    await this.openExtractor();
    await this.assertDestination(batch);
    if(batch.phase==='adopt') { batch.phase='extracting'; batch.lastProgressAt=Date.now(); }
  }
  assertBatchSearch(batch) {
    if(!batch.searchUrl || !selectedRegionIds(batch.searchUrl)) throw new Error('Cannot validate the current batch search URL');
    if(selectedRegionIds(this.sales.url())!==selectedRegionIds(batch.searchUrl)) throw new Error('Current Sales Navigator geography differs from the saved batch. Restore that batch manually before resuming.');
    const query=new URL(this.sales.url()).searchParams.get('query')||'';
    if(!/type:CURRENT_TITLE/.test(query) || !/Registered(?:%20|\s)Nurse/.test(query)) throw new Error('Registered Nurse title filter is missing');
  }
  async assertDestination(batch) {
    const combo=this.sales.getByRole('combobox',{name:'',exact:true});
    const text=clean((await combo.innerText()).split('\n')[0]);
    if(text!==batch.listName) throw new Error('Current GrowMeOrganic list differs from the saved batch; bot will not switch a running destination.');
  }
  async progress(batch) {
    this.assertBatchSearch(batch);await this.openExtractor();await this.assertDestination(batch);const text=await this.body();
    const counter=name=>Number(text.match(new RegExp(`${name}:\\s*([\\d,]+)`,'i'))?.[1]?.replaceAll(',','')||0);
    const page=counter('Page'); const nav=text.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    const urlPage=Number(new URL(this.sales.url()).searchParams.get('page')||1);
    const beyondLastPage=/no leads matched your search/i.test(text) && urlPage>1 && Math.max(counter('Extracting'),batch.maxExtracted||0)>0;
    return {active:Boolean(await this.sales.getByRole('button',{name:'In progress / click to stop..',exact:true}).count()),
      page:page||Number(nav?.[1]||urlPage),extracting:counter('Extracting'),saved:counter('Saved to your account'),
      beyondLastPage,atLastPage:(!!nav && nav[1]===nav[2])||beyondLastPage};
  }
  async finalCounts(batch) {
    await this.listPage(); const row=this.row(batch.listName); await row.waitFor({timeout:30000});
    const text=await row.innerText(); const match=text.match(/([\d,]+)\s*\/\s*([\d,]+)\s*Emails found\s*\/\s*Contacts/i);
    if(!match) throw new Error('Could not read actual saved contact count');
    return {emails:Number(match[1].replaceAll(',','')),saved:Number(match[2].replaceAll(',',''))};
  }
  async exportList(batch,directory) {
    const output=path.join(directory,'exports',`${batch.id}.csv`);
    await fs.mkdir(path.dirname(output),{recursive:true});
    if(!await fs.stat(output).catch(()=>null)) {
      await this.listPage(); const row=this.row(batch.listName);
      await row.getByRole('button',{name:' Download ',exact:true}).click();
      await persistentBrowserDownload({browser:this.browser,page:this.organic,
        directory:path.join(directory,'downloads'),output,click:async()=>{
      await row.getByRole('link',{name:' Download in CSV (.csv)',exact:true}).click();
      }});
    }
    const parsed=await readLocationFiles([output]);
    if(parsed.inputRows!==batch.savedContacts) throw new Error(`Export has ${parsed.inputRows} rows; GrowMeOrganic list shows ${batch.savedContacts}. Retained for review; no automatic comparison.`);
    return output;
  }
  async proof(directory,batch) {
    await fs.mkdir(path.join(directory,'screenshots'),{recursive:true});
    await this.sales.screenshot({path:path.join(directory,'screenshots',`${batch.id}.png`)});
  }
}
