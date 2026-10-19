const el = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const label = value => String(value || '').replaceAll('_', ' ');
const active = status => ['matching', 'verifying', 'stopping'].includes(status);
let jobs = [], selected = '', offset = 0, total = 0, busy = false;

async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Agent request failed');
  return result;
}
function error(error) { el('locationJobError').textContent = error.message; }
function uploadButton() {
  el('startLocationMatch').disabled = busy || jobs.some(j => active(j.status)) || !el('locationRealData').checked || !el('locationFiles').files.length;
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}
async function refresh() {
  ({ jobs } = await request('/api/location-agents'));
  if (!jobs.some(j => j.id === selected)) selected = jobs[0]?.id || '';
  el('locationJobSelect').innerHTML = jobs.length ? jobs.map(j => `<option value="${html(j.id)}" ${j.id === selected ? 'selected' : ''}>${html(j.name)} — ${html(label(j.status))}</option>`).join('') : '<option value="">No matching runs yet</option>';
  uploadButton();
  if (selected) await detail();
}
async function detail() {
  const id = selected;
  const data = await request(`/api/location-agents/${id}?offset=${offset}&limit=25`);
  if (selected !== id) return;
  const { job, profiles } = data;
  total = data.total;
  el('locationJobStatus').textContent = `${label(job.status)}${job.phase ? ` · ${label(job.phase)}` : ''}${job.register ? ` · Register source: ${job.register.filename}` : ''}${job.status === 'stopping' ? ' · The current profile check will finish before stopping.' : ''}`;
  el('locationJobError').textContent = job.error;
  const anyRunning = jobs.some(j => active(j.status));
  el('startSchoolChecks').disabled = !job.summary || anyRunning;
  el('stopLocationAgent').disabled = !active(job.status) || job.status === 'stopping';
  el('locationCheckLimit').disabled = active(job.status);
  el('locationRetry').disabled = active(job.status);
  const s = job.summary;
  el('locationSummary').innerHTML = s ? [
    `${s.inputRows} source rows`, `${s.uniqueProfiles} unique profiles`, `${s.duplicateRows} duplicate rows`,
    ...Object.entries(s.matchCounts || {}).map(([key, count]) => `${count} ${label(key)}`),
    ...Object.entries(s.verificationCounts || {}).map(([key, count]) => `${count} ${key === 'confirmed' ? 'school confirmed' : label(key)}`),
    ...Object.entries(s.databaseCounts || {}).map(([key, count]) => `${count} ${key === 'candidate_updated' ? 'candidate records updated' : key === 'review_required' ? 'database updates held for review' : 'evidence records saved'}`)
  ].map(value => `<span>${html(value)}</span>`).join('') : '';
  el('locationDownloads').innerHTML = s ? [['results.csv', 'All results'], ['register-candidates.csv', 'Possible register matches'], ['confirmed.csv', 'School-confirmed'], ['review.csv', 'Review queue']]
    .map(([file, name]) => `<a href="/api/location-agents/${html(id)}/export?file=${file}">${name} CSV</a>`).join('') : '';
  el('locationProfileTable').innerHTML = profiles.length ? `<table><thead><tr><th>Profile</th><th>Work / location</th><th>Register match</th><th>School verification</th><th>Register evidence</th><th>Observed education</th><th>Source</th></tr></thead><tbody>${profiles.map(p => `<tr>
    <td><strong>${html(p.fullName)}</strong>${p.url ? `<br><a href="${html(p.url)}" target="_blank" rel="noreferrer">LinkedIn profile</a>` : ''}</td>
    <td>${html(p.title)}<br>${html(p.employer)}<br><small>${html(p.location)}</small></td>
    <td>${html(label(p.matchStatus))}<br><small>${p.candidates.filter(c => c.eligible).length} eligible RN candidates</small>${p.issues.length ? `<p>${html(p.issues.join('; '))}</p>` : ''}</td>
    <td><span class="status ${p.verificationStatus === 'confirmed' ? 'confirmed' : 'manual_review'}">${html(p.verificationStatus === 'confirmed' ? 'school confirmed' : label(p.verificationStatus))}</span><p>${html(p.reason)}</p>${p.databaseWrite ? `<p><strong>Database: ${html(label(p.databaseWrite.status))}</strong>${p.databaseWrite.status === 'review_required' ? `<br>${html(p.databaseWrite.reason)}` : ''}</p>` : ''}${p.checkedAt ? `<small>${html(new Date(p.checkedAt).toLocaleString())}</small>` : ''}</td>
    <td class="agent-details">${p.candidates.map(c => `<details><summary>${html(c.fullName)} · ${html(c.registrationNumber)}${c.eligible ? '' : ' · ineligible'}</summary><p>${html(c.qualifications || 'No usable qualification recorded')}</p>${c.registrations.map(r => `<p>${html(r.registrationStatus)} · ${html(r.registrationType)}</p>`).join('')}${p.checks.filter(check => check.candidateId === c.candidateId).map(check => `<p>${html(label(check.schoolStatus))}${check.yearConflict ? ' · Year conflict' : ''}${check.middleConflict ? ' · Middle-name conflict' : ''}</p>`).join('')}</details>`).join('') || 'No matching register names'}</td>
    <td class="agent-details">${p.evidence?.education?.length ? p.evidence.education.map(e => `<details><summary>${html(e.school)}${e.endYear ? ` (${html(e.endYear)})` : ''}</summary><p>${html(e.snippet)}</p></details>`).join('') : 'No education evidence checked yet'}</td>
    <td>${p.sources.map(source => `${html(source.filename)}<br><small>${html(source.sheet)} · row ${source.row}</small>`).join('<br>')}</td>
  </tr>`).join('')}</tbody></table>` : '<div class="empty">Matching results will appear here when the agent finishes.</div>';
  el('locationPageSummary').textContent = total ? `${offset + 1}–${Math.min(offset + 25, total)} of ${total} profiles` : '';
  el('locationPrevious').disabled = offset === 0;
  el('locationNext').disabled = offset + 25 >= total;
}
el('locationFiles').addEventListener('change', uploadButton);
el('locationRealData').addEventListener('change', uploadButton);
el('startLocationMatch').addEventListener('click', async () => {
  busy = true; uploadButton(); el('locationJobError').textContent = '';
  try {
    const chosen = [...el('locationFiles').files];
    if (!chosen.length || !el('locationRealData').checked) throw new Error('Choose real search exports and tick the real-data declaration.');
    if (chosen.reduce((sum, file) => sum + file.size, 0) > 25000000) throw new Error('Choose files totalling no more than 25 MB per matching run.');
    el('locationUploadStatus').textContent = 'Uploading exports and starting register matching…';
    const files = await Promise.all(chosen.map(async file => ({ filename: file.name, fileBase64: await fileBase64(file) })));
    const job = await request('/api/location-agents', { name: el('locationRunName').value, realData: true, files });
    selected = job.id; offset = 0;
    el('locationUploadStatus').textContent = 'Matching started. School checks start only when you press the separate button.';
    el('locationFiles').value = ''; el('locationRealData').checked = false;
    await refresh();
  } catch (e) { error(e); el('locationUploadStatus').textContent = ''; }
  finally { busy = false; uploadButton(); }
});
el('locationJobSelect').addEventListener('change', () => { selected = el('locationJobSelect').value; offset = 0; detail().catch(error); });
el('refreshLocationJobs').addEventListener('click', () => refresh().catch(error));
el('startSchoolChecks').addEventListener('click', async () => {
  el('startSchoolChecks').disabled = true;
  try { await request(`/api/location-agents/${selected}/verify`, { limit: Number(el('locationCheckLimit').value), retryUnavailable: el('locationRetry').checked }); await refresh(); }
  catch (e) { error(e); el('startSchoolChecks').disabled = false; }
});
el('stopLocationAgent').addEventListener('click', async () => {
  try { await request(`/api/location-agents/${selected}/stop`, {}); await refresh(); } catch (e) { error(e); }
});
el('locationPrevious').addEventListener('click', () => { offset = Math.max(0, offset - 25); detail().catch(error); });
el('locationNext').addEventListener('click', () => { offset += 25; detail().catch(error); });
document.querySelector('[data-tab="locationAgents"]').addEventListener('click', () => refresh().catch(error));
setInterval(() => { if (el('locationAgents').classList.contains('active') && !busy) refresh().catch(error); }, 4000);
if (window.location.hash === '#locationAgents') document.querySelector('[data-tab="locationAgents"]').click();
