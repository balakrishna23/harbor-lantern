const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(action) {
  try {
    const response=await fetch('/api/extraction-bot'+(action?'/'+action:''),action?{method:'POST',headers:{'content-type':'application/json'},body:'{}'}:{});
    const s=await response.json();if(!response.ok)throw new Error(s.error);
    $('status').textContent=`${s.status.replaceAll('_',' ')} · Worker ${s.workerAlive?'running':'idle'} · ${s.maxPages}-page limit${s.pauseAfterBatch?' · Will pause after this batch':''}`;
    $('error').textContent=s.error;
    $('summary').textContent='Location suggestions: '+Object.entries(s.locationCounts).map(([k,v])=>`${v.toLocaleString()} ${k.replaceAll('_',' ')}`).join(' · ');
    const b=s.activeBatch;
    $('current').textContent=b?`${b.listName} · ${b.phase.replaceAll('_',' ')} · ${b.pages} search pages · ${b.savedContacts==null?'Saved count not checked yet':b.savedContacts+' saved'}${b.lastProgress?` · Extractor page ${b.lastProgress.page}`:''}${b.locations.length?' · Locations: '+b.locations.join('; '):''}${b.probingLocation?' · Checking: '+b.probingLocation:''}`:'No active batch';
    $('batches').innerHTML='<table><thead><tr><th>List</th><th>Stage</th><th>Pages</th><th>Saved</th><th>Coverage</th><th>Comparison</th></tr></thead><tbody>'+s.batches.map(b=>`<tr><td>${esc(b.listName)}</td><td>${esc(b.phase)}</td><td>${esc(b.pages)}</td><td>${esc(b.savedContacts??'Unreconciled')}</td><td>${esc(b.coverage)}</td><td>${b.matchJobId?'Available in matching dashboard':'—'}</td></tr>`).join('')+'</tbody></table>';
    $('events').innerHTML=s.events.map(e=>`<p><small>${esc(new Date(e.at).toLocaleString())}</small> ${esc(e.message)}${e.error?': '+esc(e.error):''}</p>`).join('');
  } catch(e) {$('error').textContent=e.message;}
}
$('start').onclick=()=>refresh('start');$('pause').onclick=()=>refresh('pause');$('refresh').onclick=()=>refresh();
setInterval(()=>refresh(),5000);refresh();
