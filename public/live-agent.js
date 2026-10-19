(function () {
  const POLL_MS = 4000;
  const OLDER_PAGE_SIZE = 100;
  let seenLeadIds = new Set();
  let firstLoad = true;
  // liveRows auto-refreshes every poll (most recent page). olderRows only
  // grows when "Load older entries" is clicked, so history you've already
  // paged into stays put instead of being wiped by the next refresh.
  let liveRows = [];
  let olderRows = [];
  let totalLeads = 0;
  let hasMore = false;
  let loadingOlder = false;

  function timeAgo(iso) {
    if (!iso) return "never";
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso + "Z").getTime()) / 1000));
    if (seconds < 60) return seconds + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    return Math.floor(seconds / 3600) + "h ago";
  }

  // A lead in browser_leads is an audit record of everything ever found,
  // including leads that were found and then rejected (e.g. the name didn't
  // match — see src/browser-agent.mjs's applyBrowserLeadDecision). Whether
  // THIS lead is actually attached to the candidate right now is a separate
  // question: compare it against the candidate's current linkedin_url. A
  // rejected lead must never render identically to an accepted weak match —
  // that's what made a correctly-working rejection look like a system
  // failure in the feed.
  function leadIsAttached(row) {
    return Boolean(row.candidate_linkedin_url) && row.candidate_linkedin_url === row.linkedin_url;
  }

  function decisionBadge(row) {
    if (row.identity_status === "confirmed") {
      const via = row.identity_provider === "academic_resolver" ? "Academic/web" : "Sales Nav";
      return `<span class="status confirmed">Confirmed (${via})</span>`;
    }
    if (row.status === "found" && !leadIsAttached(row)) {
      return `<span class="status rejected">Rejected — different person</span>`;
    }
    if (row.workflow_stage === "manual_review") return `<span class="status manual_review">Manual review</span>`;
    if (row.workflow_stage === "identity_unresolved") return `<span class="status rejected">Unresolved</span>`;
    return `<span class="status">${row.workflow_stage || "—"}</span>`;
  }

  function rowHtml(row, isNew) {
    const found = row.status === "found";
    // Only show a clickable URL when this lead is actually the one
    // attached to the candidate right now. A found-but-rejected lead
    // (name mismatch, or found with no real corroboration) still shows
    // "Found" in the Result column so you can see a search happened, but
    // the URL itself is withheld — showing a URL for a lead we didn't
    // keep is misleading, exactly what made #163 confusing at a glance.
    const url = leadIsAttached(row)
      ? `<a class="link" href="${row.linkedin_url}" target="_blank" rel="noopener">${row.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com/, "")}</a>`
      : "—";
    return `<tr class="${isNew ? "feed-row-new" : ""}">
      <td class="muted-small">${timeAgo(row.created_at)}</td>
      <td>#${row.candidate_id} ${row.candidate_name || ""}</td>
      <td>${found ? '<span class="status">Found</span>' : '<span class="status">Not found</span>'}</td>
      <td>${decisionBadge(row)}</td>
      <td class="score">${row.identity_match_score ?? "—"}</td>
      <td class="url-cell">${url}</td>
    </tr>`;
  }

  function renderTable() {
    const body = document.getElementById("feedBody");
    const liveIds = new Set(liveRows.map((row) => row.id));
    // olderRows can overlap with liveRows (the live window shifts as new
    // activity comes in) — liveRows always wins so nothing renders twice.
    const older = olderRows.filter((row) => !liveIds.has(row.id));
    const combined = [...liveRows, ...older];

    if (!combined.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No searches recorded yet.</td></tr>';
    } else {
      body.innerHTML = combined.map((row, index) => {
        const isNew = !firstLoad && index < liveRows.length && !seenLeadIds.has(row.id);
        return rowHtml(row, isNew);
      }).join("");
    }
    seenLeadIds = new Set(liveRows.map((row) => row.id));
    firstLoad = false;

    const loadedCount = combined.length;
    const countLabel = document.getElementById("feedCount");
    countLabel.textContent = totalLeads
      ? `Showing ${loadedCount} of ${totalLeads} total search${totalLeads === 1 ? "" : "es"}`
      : "";
    const btn = document.getElementById("loadOlderBtn");
    btn.hidden = !hasMore;
    btn.disabled = loadingOlder;
    btn.textContent = loadingOlder ? "Loading…" : "Load older entries";
  }

  const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString());

  function formatEta(days) {
    if (days == null) return "–";
    if (days < 1) return Math.max(1, Math.round(days * 24)) + " h";
    return Math.round(days) + " days";
  }

  function renderRound(round) {
    const panel = document.getElementById("roundPanel");
    panel.hidden = !round;
    if (!round) return;
    document.getElementById("roundNote").textContent =
      `Re-search started ${new Date(round.round.replace(" ", "T") + "Z").toLocaleString()}. ACT first, then the national register. ` +
      "Healthcare workers in Australia only. Not-found results are saved in groups of 20 after a test search passes, so that count moves in steps.";
    document.getElementById("rSearched").textContent = fmt(round.searched);
    document.getElementById("rConfirmed").textContent = fmt(round.confirmed);
    document.getElementById("rReview").textContent = fmt(round.review);
    document.getElementById("rNotFound").textContent = fmt(round.not_found);
    document.getElementById("rRemainingAct").textContent = fmt(round.remainingAct);
    document.getElementById("rRemainingNational").textContent = fmt(round.remainingNational);
    document.getElementById("rRate").textContent = round.perMinute ? round.perMinute.toFixed(1) : "–";
    document.getElementById("rEta").textContent = formatEta(round.etaDays);
  }

  function render(data) {
    renderRound(data.round);
    const f = data.funnel || {};
    document.getElementById("mTotal").textContent = f.total ?? "–";
    document.getElementById("mConfirmedSN").textContent = f.salesnav_confirmed ?? 0;
    document.getElementById("mConfirmedAcademic").textContent = f.academic_confirmed ?? 0;
    document.getElementById("mManualReview").textContent = f.salesnav_manual_review ?? 0;
    document.getElementById("mUnresolved").textContent = f.unresolved ?? 0;
    document.getElementById("mWithLinkedIn").textContent = f.with_linkedin ?? 0;
    document.getElementById("mQueued").textContent = f.still_queued ?? 0;

    const pulse = document.getElementById("pulse");
    const statusLine = document.getElementById("statusLine");
    const lastSeconds = data.lastActivity ? Math.floor((Date.now() - new Date(data.lastActivity + "Z").getTime()) / 1000) : null;
    const stale = lastSeconds === null || lastSeconds > 120;
    pulse.classList.toggle("stale", stale);
    statusLine.textContent = stale
      ? `No search activity in the last ${lastSeconds === null ? "—" : timeAgo(data.lastActivity)}. Agent may be idle or paused.`
      : `Live — last search ${timeAgo(data.lastActivity)}.`;

    liveRows = data.recentLeads || [];
    totalLeads = data.totalLeads ?? totalLeads;
    // hasMore reflects the live page's own window (offset 0..50) unless
    // older pages have already been loaded, in which case it's tracked by
    // loadOlder() instead so it doesn't snap back after paging deeper.
    if (!olderRows.length) hasMore = Boolean(data.hasMore);
    renderTable();
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore) return;
    loadingOlder = true;
    renderTable();
    try {
      const offset = liveRows.length + olderRows.length;
      const res = await fetch(`/api/browser-agent/live?limit=${OLDER_PAGE_SIZE}&offset=${offset}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      olderRows = olderRows.concat(data.recentLeads || []);
      hasMore = Boolean(data.hasMore);
      totalLeads = data.totalLeads ?? totalLeads;
    } catch (error) {
      // Leave hasMore as-is so the button stays visible to retry.
    } finally {
      loadingOlder = false;
      renderTable();
    }
  }

  async function poll() {
    try {
      const res = await fetch("/api/browser-agent/live", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      render(await res.json());
    } catch (error) {
      document.getElementById("statusLine").textContent = "Could not reach the local server — is it still running?";
      document.getElementById("pulse").classList.add("stale");
    } finally {
      document.getElementById("clock").textContent = new Date().toLocaleTimeString();
      setTimeout(poll, POLL_MS);
    }
  }

  document.getElementById("loadOlderBtn").addEventListener("click", loadOlder);
  poll();
})();
