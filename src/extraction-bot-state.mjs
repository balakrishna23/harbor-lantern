import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsv } from './csv.mjs';

// Windows sync/indexing tools can briefly lock a destination during replacement.
// Retry the atomic rename without removing the last good checkpoint.
export function atomicCheckpoint(filename, content, {rename=fs.renameSync, wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}) {
  const temporary=`${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary,content);
    for(let attempt=0;;attempt++) {
      try { rename(temporary,filename);return; }
      catch(error) {
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=8)throw error;
        wait(Math.min(25*2**attempt,500));
      }
    }
  } finally {
    try {fs.rmSync(temporary,{force:true});}catch{/* Preserve the original error. */}
  }
}

export const extractionAlive = pid => { if(!Number.isInteger(pid)||pid<1)return false;try {process.kill(pid,0);return true;} catch(error) {return error.code==='EPERM';} };
export const locationKey = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const states = ['New South Wales', 'Victoria', 'Queensland', 'South Australia', 'Western Australia', 'Tasmania', 'Northern Territory', 'Australian Capital Territory'];
const priority = {
  'New South Wales': ['Sydney','Penrith','Parramatta','Liverpool','Campbelltown','Blacktown','Bankstown','Ryde','Hornsby','Sutherland','Manly','Goulburn','Kiama','Batemans Bay','Ulladulla','Lithgow','Mudgee','Broken Hill','Griffith','Leeton','Parkes','Forbes','Young','Cowra','Singleton','Muswellbrook','Nelson Bay','Byron Bay','Tweed Heads'],
  Victoria: ['Melbourne','Geelong','Ballarat','Bendigo','Shepparton','Mildura','Warrnambool','Wodonga','Traralgon','Wangaratta','Sale','Horsham','Echuca','Bairnsdale','Frankston','Dandenong','Pakenham','Werribee','Sunbury','Melton'],
  Queensland: ['Brisbane','Gold Coast','Sunshine Coast','Townsville','Cairns','Toowoomba','Ipswich','Logan','Mackay','Rockhampton','Bundaberg','Hervey Bay','Gladstone','Maryborough','Gympie','Mount Isa','Warwick','Emerald','Roma','Kingaroy'],
  'South Australia': ['Adelaide','Mount Gambier','Whyalla','Murray Bridge','Port Lincoln','Port Augusta','Port Pirie','Victor Harbor','Gawler','Mount Barker'],
  'Western Australia': ['Perth','Bunbury','Albany','Geraldton','Kalgoorlie','Busselton','Mandurah','Broome','Karratha','Port Hedland','Esperance','Northam'],
  Tasmania: ['Hobart','Launceston','Devonport','Burnie','Ulverstone','New Norfolk'],
  'Northern Territory': ['Darwin','Alice Springs','Katherine','Tennant Creek','Palmerston'],
  'Australian Capital Territory': ['Canberra','Belconnen','Gungahlin','Tuggeranong','Woden']
};

/** Official locality names are search suggestions; every actual platform tag is checked live. */
export function seedExtractionQueue(root) {
  const rows = []; const seen = new Set();
  const add = (name, state, kind = 'locality') => {
    const query = kind === 'state' ? `${state}, Australia` : `${name}, ${state}, Australia`;
    const id = locationKey(query); if (seen.has(id)) return; seen.add(id);
    rows.push({ id, name, state, query, kind, status: 'pending' });
  };
  // Finish regional NSW, then test other states before splitting into their localities.
  for (const state of states) {
    add(state, state, 'state');
    for (const name of priority[state]) add(name, state);
  }
  const csv = path.join(root, 'outputs/australia-location-checklist/Australia_Location_Checklist.csv');
  if (fs.existsSync(csv)) for (const row of parseCsv(fs.readFileSync(csv, 'utf8').replace(/^\uFEFF/, ''))) {
    const state = row['State or territory']; const name = row.Locality;
    if (state && name && !/Remainder/i.test(name)) add(name, state);
  }
  return rows;
}

export class ExtractionStore {
  constructor(root, directory = path.join(root, 'data/extraction-bot')) {
    this.root = root; this.directory = directory; this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
  }
  load() { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  exists() { return fs.existsSync(this.file); }
  save(state) {
    state.updatedAt = new Date().toISOString();
    atomicCheckpoint(this.file, JSON.stringify(state, null, 2));
  }
  initialize() {
    if (this.exists()) return this.load();
    const state = { version: 1, status: 'idle', maxPages: 99, title: 'Registered Nurse', folder: 'hcrhub',
      createdAt: new Date().toISOString(), locations: seedExtractionQueue(this.root), batches: [], activeBatchId: null,
      events: [], control: { pauseAfterBatch: false }, automaticMatching: true, automaticSchoolChecks: false };
    const proof = path.join(this.root, 'outputs/extraction-proof');
    if (fs.existsSync(proof)) for (const file of fs.readdirSync(proof).filter(f => f.endsWith('-batch.json'))) {
      const old = JSON.parse(fs.readFileSync(path.join(proof, file), 'utf8'));
      const names = old.locations || (old.location ? [old.location.split(',')[0]] : []);
      for (const name of names) {
        const query = `${name}, New South Wales, Australia`; const id = locationKey(query);
        let item = state.locations.find(l => l.id === id);
        if (!item) { item = { id, name, query, state: 'New South Wales', kind: 'locality' }; state.locations.push(item); }
        item.status = 'previously_searched'; item.previousList = old.destinationList;
      }
      const active = /regional-02/.test(file);
      state.batches.push({ id: `legacy-${file.slice(0,-5)}`, listName: old.destinationList, locationIds: names.map(name => locationKey(`${name}, New South Wales, Australia`)),
        phase: active ? 'adopt' : 'previously_searched', pages: old.displayedPages || 0, searchUrl: old.searchUrl,
        coverage: 'unreconciled', imported: true, createdAt: state.createdAt });
      if (active) state.activeBatchId = state.batches.at(-1).id;
    }
    this.save(state); return state;
  }
  event(state, message, detail = {}) {
    const event = { at: new Date().toISOString(), message, ...detail };
    state.events.push(event); state.events = state.events.slice(-100); this.save(state);
    fs.appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify(event) + '\n');
  }
  command(command) {
    atomicCheckpoint(path.join(this.directory,'command.json'),JSON.stringify({ command, at: Date.now() }));
  }
  applyCommand(state) {
    const file = path.join(this.directory, 'command.json'); if (!fs.existsSync(file)) return;
    const { command } = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file);
    if (command === 'pause') state.control.pauseAfterBatch = true;
    if (command === 'resume') state.control.pauseAfterBatch = false;
    this.save(state);
  }
  lock() {
    const file = path.join(this.directory, 'worker.lock');
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (extractionAlive(previous.pid)) throw new Error('Extraction bot is already running');
      fs.unlinkSync(file);
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return () => { if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); };
  }
}

export function newExtractionBatch(state) {
  const id = crypto.randomUUID();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const batch = { id, phase: 'building', listName: `AU - RN - Auto ${String(state.batches.filter(b=>!b.imported).length + 1).padStart(3,'0')} - ${day} - ${id.slice(0,6)}`,
    locationIds: [], pages: 0, createdAt: new Date().toISOString(), coverage: 'unreconciled' };
  state.batches.push(batch); state.activeBatchId = id; return batch;
}

export function extractionSummary(state) {
  const counts = {}; for (const item of state.locations) counts[item.status] = (counts[item.status] || 0) + 1;
  const active=state.batches.find(b=>b.id===state.activeBatchId);
  return { status: state.status, error: state.error || '', pid: state.pid, workerAlive: extractionAlive(state.pid), updatedAt: state.updatedAt,
    maxPages: state.maxPages, pauseAfterBatch: state.control.pauseAfterBatch, locationCounts: counts,
    activeBatch: active?{...active,locations:active.locationIds.map(id=>state.locations.find(l=>l.id===id)?.query||id),probingLocation:state.locations.find(l=>l.id===active.probeId)?.query||null}:null,
    savedContacts: state.batches.reduce((n,b)=>n+(b.savedContacts||0),0),
    batches: state.batches.slice(-30).reverse(), events: state.events.slice(-15).reverse(),
    automaticSchoolChecks: false };
}
