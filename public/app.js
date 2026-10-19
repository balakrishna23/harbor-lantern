const state = {
  candidates: [], selected: new Set(), dashboard: null,
  pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const displayValue = (value, fallback = "—") => escapeHtml(value || fallback);

function jsonList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return String(value).split(/\s*;\s*/).filter(Boolean);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || "Request failed");
  }
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : response.text();
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 3500);
}

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  const c = state.dashboard.counts;
  $("#metrics").innerHTML = [
    [c.total || 0, "Unique candidates"], [c.registration_records || 0, "Source registrations"], [c.confirmed || 0, "Confirmed identities"],
    [c.valid_emails || 0, "Verified emails"], [c.campaign_ready || 0, "Campaign ready"],
    [c.needs_review || 0, "Needs review"]
  ].map(([value,label]) => `<article class="metric"><strong>${value}</strong><span>${label}</span></article>`).join("");
  $("#creditBudget").value ||= state.dashboard.config.defaultBudget;
  $("#recordCeiling").max = state.dashboard.config.maxBatchRecords;
  $("#recordCeiling").value = Math.min(Number($("#recordCeiling").value), state.dashboard.config.maxBatchRecords);
  for (const value of ["phone", "email_phone"]) {
    const option = $(`#batchKind option[value="${value}"]`);
    option.disabled = !state.dashboard.config.phoneEnabled;
    option.textContent = option.textContent.replace(" (disabled)", "") + (option.disabled ? " (disabled)" : "");
  }
  renderBatches();
}

async function loadClayStatus() {
  const status = await api("/api/clay/status");
  $("#clayStatus").textContent = status.connected
    ? `Connected · ${status.tools.length} available Clay tools/functions · tokens stored in memory only`
    : "Not connected";
  $("#connectClay").disabled = status.connected;
  $("#refreshClayTools").disabled = !status.connected;
  $("#disconnectClay").disabled = !status.connected;
  $("#clayTools").innerHTML = status.tools.length
    ? status.tools.map((tool) => `<p><strong>${escapeHtml(tool.name)}</strong><br>${displayValue(tool.description, "No description")}<br><small>Inputs: ${displayValue(tool.inputProperties.join(", "), "None declared")}</small></p>`).join("")
    : "No enabled Clay functions discovered.";
}

async function connectClay() {
  const result = await api("/api/clay/connect", { method:"POST", body:"{}" });
  window.location.assign(result.authorizationUrl);
}

async function refreshClayTools() {
  await api("/api/clay/tools/refresh", { method:"POST", body:"{}" });
  await loadClayStatus();
  toast("Clay functions refreshed");
}

async function disconnectClay() {
  await api("/api/clay/disconnect", { method:"POST", body:"{}" });
  await loadClayStatus();
  toast("Clay disconnected");
}

async function loadCandidates(page = state.pagination.page) {
  const query = new URLSearchParams({
    search: $("#search").value,
    status: $("#statusFilter").value,
    page: String(page),
    pageSize: $("#pageSize").value
  });
  const payload = await api(`/api/candidates?${query}`);
  state.candidates = payload.candidates;
  state.pagination = payload.pagination;
  renderCandidates();
}

function renderCandidates() {
  const rows = state.candidates.map((c) => `<tr>
    <td><input type="checkbox" aria-label="Select ${escapeHtml(c.full_name)}" data-select="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}></td>
    <td><strong>${escapeHtml(c.full_name)}</strong><br><small>${displayValue(c.ahpra_number, "No registration number")}</small></td>
    <td>${displayValue(c.registration_status)}<br><small>${displayValue(c.registration_type)}</small></td>
    <td>${displayValue(c.profession)}<br><small>${escapeHtml([c.suburb,c.state,c.postcode].filter(Boolean).join(" "))}</small></td>
    <td><span class="score">${c.identity_match_score ?? c.identity_confidence}</span><br><small>${displayValue(c.match_confidence, "source estimate")}</small></td>
    <td><span class="status ${c.identity_status}">${escapeHtml(c.identity_status.replaceAll("_"," "))}</span></td>
    <td>${displayValue(c.employer)}<br><small>${escapeHtml(c.current_title || "")}</small></td>
    <td>${displayValue(c.work_email)}<br><span class="status ${c.email_status}">${escapeHtml(c.email_status.replaceAll("_"," "))}</span></td>
    <td><span class="status ${c.campaign_status}">${escapeHtml(c.campaign_status.replaceAll("_"," "))}</span></td>
    <td><button class="secondary" data-review="${c.id}">Review</button></td>
  </tr>`).join("");
  $("#candidateTable").innerHTML = state.candidates.length
    ? `<table><thead><tr><th></th><th>Candidate</th><th>AHPRA status/type</th><th>Profession/location</th><th>Match score</th><th>Identity</th><th>Provider-enriched work</th><th>Email</th><th>Campaign</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">No candidates match the current filters.</div>`;
  document.querySelectorAll("[data-select]").forEach((node) => node.addEventListener("change", () => {
    const id = Number(node.dataset.select);
    node.checked ? state.selected.add(id) : state.selected.delete(id);
    updateSelection();
  }));
  document.querySelectorAll("[data-review]").forEach((node) => node.addEventListener("click", () => {
    openReview(Number(node.dataset.review)).catch((error) => toast(error.message));
  }));
  const { page, pageSize, total, totalPages } = state.pagination;
  const first = total ? ((page - 1) * pageSize) + 1 : 0;
  const last = Math.min(page * pageSize, total);
  $("#pageSummary").textContent = `Page ${page} of ${totalPages} · ${first}–${last} of ${total}`;
  $("#previousPage").disabled = page <= 1;
  $("#nextPage").disabled = page >= totalPages;
  updateSelection();
}

function updateSelection() {
  $("#selectionCount").textContent = `${state.selected.size} candidates selected`;
}

async function openReview(id) {
  const detail = await api(`/api/candidates/${id}`);
  const c = detail.candidate;
  $("#reviewId").value = id;
  $("#reviewName").textContent = `${c.full_name} · ${c.profession || "Profession unavailable"}`;
  $("#reviewStatus").value = c.identity_status === "confirmed" ? "confirmed" : c.identity_status === "rejected" ? "rejected" : "manual_review";
  $("#reviewLinkedin").value = c.linkedin_url || "";
  $("#reviewEmployer").value = c.employer || "";
  $("#reviewTitle").value = c.current_title || "";
  $("#reviewBasis").checked = Boolean(c.contact_basis_approved);
  $("#reviewNotes").value = c.recruiter_notes || "";
  $("#reviewSuppressed").checked = Boolean(c.suppressed);
  $("#reviewOptedOut").checked = Boolean(c.opted_out);
  $("#suppressionReason").value = "";
  $("#campaignEligibility").textContent = detail.campaignEligibility.eligible
    ? "Campaign eligible"
    : `Not campaign eligible: ${detail.campaignEligibility.reasons.join("; ")}`;
  $("#reviewSource").innerHTML = `
    <p><strong>AHPRA:</strong> ${displayValue(c.ahpra_number)}</p>
    <p><strong>Status:</strong> ${displayValue(c.registration_status)}</p>
    <p><strong>Types:</strong> ${displayValue(c.registration_type)}</p>
    <p><strong>Location:</strong> ${displayValue([c.suburb,c.state,c.postcode].filter(Boolean).join(" "))}</p>
    <p><strong>Qualifications:</strong> ${displayValue(c.qualifications)}</p>
    <p><strong>Languages:</strong> ${displayValue(c.languages)}</p>
    <p><strong>Source registrations:</strong> ${detail.registrations.length}</p>`;
  const latestEvidence = detail.matchEvidence[0];
  const reasons = jsonList(latestEvidence?.reasons_json || c.match_reasons);
  const conflicts = jsonList(latestEvidence?.conflicts_json || c.conflicting_evidence);
  $("#reviewEvidence").innerHTML = `
    <p><strong>Provider:</strong> ${displayValue(latestEvidence?.provider || c.identity_provider)}</p>
    <p><strong>Profile:</strong> ${displayValue(c.linkedin_url)}</p>
    <p><strong>Employer/title:</strong> ${displayValue([c.employer,c.current_title].filter(Boolean).join(" · "))}</p>
    <p><strong>Match:</strong> ${displayValue(latestEvidence?.score ?? c.identity_match_score)} (${displayValue(latestEvidence?.confidence_band || c.match_confidence)})</p>
    <p><strong>Reasons:</strong> ${displayValue(reasons.join("; "))}</p>
    <p><strong>Conflicts:</strong> ${displayValue(conflicts.join("; "), "None recorded")}</p>`;
  const suggestedLeads = detail.suggestedLeads.filter((lead) => lead.linkedin_url !== c.linkedin_url);
  $("#reviewSuggestedLeads").innerHTML = suggestedLeads.length
    ? suggestedLeads.map((lead) => `
      <p class="suggested-lead">
        <strong>${displayValue(lead.matched_full_name)}</strong> · ${displayValue(lead.created_at)}<br>
        <a href="${escapeHtml(lead.linkedin_url)}" target="_blank" rel="noopener">${escapeHtml(lead.linkedin_url)}</a><br>
        ${displayValue([lead.headline, lead.employer].filter(Boolean).join(" · "), "No headline/employer captured")}<br>
        ${displayValue(lead.location)}${lead.education_snippet ? ` · ${escapeHtml(lead.education_snippet)}` : ""}
        <button type="button" class="secondary" data-use-lead="${lead.id}">Use this lead</button>
      </p>`).join("")
    : "No unconfirmed leads — the agent either found nothing or already attached a confident match above.";
  document.querySelectorAll("[data-use-lead]").forEach((node) => node.addEventListener("click", () => {
    const lead = suggestedLeads.find((item) => String(item.id) === node.dataset.useLead);
    if (!lead) return;
    $("#reviewLinkedin").value = lead.linkedin_url || "";
    if (lead.employer) $("#reviewEmployer").value = lead.employer;
    if (lead.current_title) $("#reviewTitle").value = lead.current_title;
    toast("Lead copied into the form below — review it, then save");
  }));
  $("#reviewHistory").innerHTML = detail.reviewHistory.length
    ? detail.reviewHistory.map((item) => `<p><strong>${displayValue(item.decision)}</strong> · ${displayValue(item.reviewer)} · ${displayValue(item.created_at)}<br>${displayValue(item.notes, "No notes")}</p>`).join("")
    : "No recruiter decisions recorded.";
  const jobs = detail.enrichmentJobs.map((job) => `<p><strong>${displayValue(job.kind)}</strong> · ${displayValue(job.status)} · est. ${job.estimated_credits}, actual ${job.actual_credits}${job.error_code ? `<br>Error ${displayValue(job.error_code)}: ${displayValue(job.error_message)}` : ""}</p>`);
  const contacts = detail.contactPoints.map((contact) => `<p><strong>${displayValue(contact.kind)}</strong> · ${displayValue(contact.verification_status)} · ${displayValue(contact.provider)} · ${displayValue(contact.enriched_at)}</p>`);
  $("#enrichmentHistory").innerHTML = [...jobs, ...contacts].join("") || "No enrichment history recorded.";
  $("#reviewDialog").showModal();
}

async function saveReview(event) {
  event.preventDefault();
  const id = $("#reviewId").value;
  await api(`/api/candidates/${id}/review`, { method:"POST", body:JSON.stringify({
    identityStatus:$("#reviewStatus").value, linkedinUrl:$("#reviewLinkedin").value,
    employer:$("#reviewEmployer").value, currentTitle:$("#reviewTitle").value,
    contactBasisApproved:$("#reviewBasis").checked, notes:$("#reviewNotes").value,
    reviewer:$("#reviewer").value
  }) });
  $("#reviewDialog").close();
  toast("Review saved");
  await Promise.all([loadCandidates(), loadDashboard()]);
}

async function saveSuppression() {
  const id = $("#reviewId").value;
  const suppressed = $("#reviewSuppressed").checked;
  const optedOut = $("#reviewOptedOut").checked;
  const reason = $("#suppressionReason").value.trim();
  if ((suppressed || optedOut) && !reason) return toast("Add a reason for suppression or opt-out");
  await api(`/api/candidates/${id}/suppression`, { method:"POST", body:JSON.stringify({
    suppressed, optedOut, reason, actor:$("#reviewer").value
  }) });
  $("#reviewDialog").close();
  toast("Privacy controls saved");
  await Promise.all([loadCandidates(), loadDashboard()]);
}

async function importSource() {
  const file = $("#sourceFile").files[0];
  if (!file) return toast("Choose an Excel or CSV file first");
  const payload = { filename:file.name, agreementReference:$("#agreement").value };
  if (file.name.toLowerCase().endsWith(".xlsx")) payload.fileBase64 = arrayBufferToBase64(await file.arrayBuffer());
  else payload.csvText = await file.text();
  const result = await api("/api/import", { method:"POST", body:JSON.stringify(payload) });
  $("#importResult").textContent = JSON.stringify(result,null,2);
  toast(`Imported ${result.inserted} candidates`);
  await Promise.all([loadCandidates(1), loadDashboard()]);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function createBatch() {
  const result = await api("/api/enrichment/batches", { method:"POST", body:JSON.stringify({
    candidateIds:[...state.selected], name:$("#batchName").value, kind:$("#batchKind").value,
    creditBudget:Number($("#creditBudget").value), recordCeiling:Number($("#recordCeiling").value),
    dryRun:$("#dryRun").checked
  }) });
  toast(`Batch ${result.batchId} created: ${result.records} records, estimated ${result.estimatedCredits} credits`);
  state.selected.clear();
  await Promise.all([loadCandidates(), loadDashboard()]);
  document.querySelector('[data-tab="enrichment"]').click();
}

function renderBatches() {
  const batches = state.dashboard?.batches || [];
  const currentBatch = $("#resultsBatch").value;
  $("#resultsBatch").innerHTML = `<option value="">Choose a batch</option>${batches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(b.kind)})</option>`).join("")}`;
  $("#resultsBatch").value = currentBatch;
  $("#batchList").innerHTML = batches.length
    ? `<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Type</th><th>Records</th><th>Credits est./actual</th><th>Mode/status</th><th></th></tr></thead><tbody>${batches.map((b) => `<tr><td>${escapeHtml(b.name)}</td><td>${escapeHtml(b.kind)}</td><td>${b.record_count}/${b.record_ceiling}</td><td>${b.estimated_credits}/${b.actual_credits}</td><td>${b.dry_run ? "dry run" : "controlled"} · ${escapeHtml(b.status)}</td><td><a href="/api/enrichment/batches/${b.id}/csv"><button>Download Clay CSV</button></a></td></tr>`).join("")}</tbody></table></div>`
    : `<p class="empty">No enrichment batches yet.</p>`;
}

async function importResults() {
  const file = $("#resultsFile").files[0];
  if (!file) return toast("Choose a Clay results CSV first");
  const batchId = Number($("#resultsBatch").value);
  if (!Number.isInteger(batchId) || batchId < 1) return toast("Choose the batch these results belong to");
  const result = await api("/api/enrichment/results", { method:"POST", body:JSON.stringify({ batchId, csvText:await file.text() }) });
  $("#resultsOutput").textContent = JSON.stringify(result,null,2);
  toast(`Updated ${result.updated} candidates`);
  await Promise.all([loadCandidates(), loadDashboard()]);
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-tab],.tab-panel").forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
  $(`#${button.dataset.tab}`).classList.add("active");
}));
let searchTimer;
$("#refresh").addEventListener("click", () => loadCandidates());
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCandidates(1), 250);
});
$("#statusFilter").addEventListener("change", () => loadCandidates(1));
$("#pageSize").addEventListener("change", () => loadCandidates(1));
$("#previousPage").addEventListener("click", () => loadCandidates(state.pagination.page - 1));
$("#nextPage").addEventListener("click", () => loadCandidates(state.pagination.page + 1));
$("#importButton").addEventListener("click", () => importSource().catch((error) => toast(error.message)));
$("#createBatch").addEventListener("click", () => createBatch().catch((error) => toast(error.message)));
$("#importResults").addEventListener("click", () => importResults().catch((error) => toast(error.message)));
$("#saveReview").addEventListener("click", (event) => saveReview(event).catch((error) => toast(error.message)));
$("#saveSuppression").addEventListener("click", () => saveSuppression().catch((error) => toast(error.message)));
$("#connectClay").addEventListener("click", () => connectClay().catch((error) => toast(error.message)));
$("#refreshClayTools").addEventListener("click", () => refreshClayTools().catch((error) => toast(error.message)));
$("#disconnectClay").addEventListener("click", () => disconnectClay().catch((error) => toast(error.message)));
const clayResult = new URLSearchParams(window.location.search);
if (clayResult.get("clay") === "connected") toast("Clay connected. Review the available functions before enabling execution.");
if (clayResult.get("clay") === "error") toast(clayResult.get("message") || "Clay connection failed");
if (clayResult.has("clay")) history.replaceState({}, "", window.location.pathname);
await Promise.all([loadDashboard(), loadCandidates(1), loadClayStatus()]);
