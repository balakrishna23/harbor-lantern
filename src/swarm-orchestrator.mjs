import { db } from "./db.mjs";
import { toCsv } from "./csv.mjs";
import {
  claimCandidates,
  runVerificationBatch,
  runSupervisorCheck
} from "./pipeline-orchestrator.mjs";
import { exportConfirmedCheckpoint } from "../scripts/export-checkpoint.mjs";
import { exportCombinedSheet } from "../scripts/export-combined.mjs";
import { verifyCandidateAcademics, applyAcademicVerificationDecision } from "./academic-resolver.mjs";
import { sendMobileNotification } from "./notifier.mjs";

const API_BASE = "http://127.0.0.1:4173";

let lastNotificationTime = 0;
function safeExport() {
  try {
    exportConfirmedCheckpoint(db);
    exportCombinedSheet();

    // Throttled 10-minute mobile notification
    const now = Date.now();
    if (now - lastNotificationTime >= 10 * 60 * 1000) {
      lastNotificationTime = now;
      const confirmed = db.prepare("SELECT COUNT(*) as c FROM candidates WHERE identity_status = 'confirmed'").get().c;
      sendMobileNotification({
        title: "HCRHUB Swarm 10m Pulse",
        message: `Swarm is active! Confirmed Australian Nurses: ${confirmed}. Next pulse in 10 mins.`
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("[safeExport] Non-fatal export notice:", err.message);
  }
}

export class SwarmOrchestrator {
  constructor({
    concurrency = 3,
    chunkSize = 5,
    apiBase = API_BASE,
    logger = console.log,
    engine = "academic"
  } = {}) {
    this.concurrency = Math.max(1, Math.min(concurrency, 10));
    this.chunkSize = Math.max(1, Math.min(chunkSize, 25));
    this.apiBase = apiBase;
    this.log = logger;
    this.engine = engine;
    this.isRunning = false;
    this.isStopping = false;
    this.workers = [];
    this.stats = {
      chunksProcessed: 0,
      contactsEnriched: 0,
      candidatesDiscovered: 0,
      candidatesPendingConfirmation: 0,
      errorsCount: 0
    };

    const SQUAD_NAMES = ["Scout", "Pulse", "Hunter", "Atlas", "Nova", "Cipher", "Apex", "Valkyrie"];
    for (let i = 1; i <= this.concurrency; i++) {
      const name = SQUAD_NAMES[i - 1] || `operative-${i}`;
      this.workers.push({
        id: name,
        index: i,
        status: "idle",
        currentType: null,
        currentChunk: [],
        taskId: null,
        totalProcessed: 0
      });
    }
  }

  async checkCredits() {
    try {
      const res = await fetch(`${this.apiBase}/api/clay/credits`);
      if (!res.ok) return { available: true };
      const data = await res.json();
      if (data.hasWorkspaceCredits === false || data.exhaustedMessage) {
        return { available: false, message: data.exhaustedMessage || "Clay workspace credits depleted" };
      }
      return { available: true, ...data };
    } catch {
      return { available: true };
    }
  }

  async checkClayStatus() {
    try {
      const res = await fetch(`${this.apiBase}/api/clay/status`);
      if (!res.ok) return { connected: false };
      return await res.json();
    } catch {
      return { connected: false };
    }
  }

  /**
   * Atomically leases the next chunk of work for a given worker.
   * Priority 1: Confirmed candidates needing contact waterfall (email + phone)
   * Priority 2: Registered unreviewed candidates needing LinkedIn discovery
   */
  leaseNextChunk(workerId) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Priority 1: Contact waterfall
      const contactCandidates = db.prepare(`
        SELECT id, full_name, linkedin_url
        FROM candidates
        WHERE identity_status = 'confirmed'
          AND linkedin_url IS NOT NULL AND linkedin_url <> ''
          AND (work_email IS NULL OR work_email = '' OR email_status <> 'valid')
          AND workflow_stage NOT IN ('contact_unresolved', 'enrichment_failed', 'email_verified', 'email_queued', 'phone_queued')
          AND workflow_stage NOT LIKE 'claiming_%'
        ORDER BY id ASC
        LIMIT ?
      `).all(this.chunkSize);

      if (contactCandidates.length > 0) {
        const ids = contactCandidates.map((c) => c.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`
          UPDATE candidates
          SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders})
        `).run(`claiming_contact_${workerId}`, ...ids);
        db.exec("COMMIT");
        return { type: "contact", candidates: contactCandidates };
      }

      // Priority 2: Identity discovery
      const discoveryCandidates = db.prepare(`
        SELECT id, full_name, first_name, last_name, profession, state, postcode
        FROM candidates c
        WHERE c.registration_status = 'Registered'
          AND (c.linkedin_url IS NULL OR c.linkedin_url = '')
          AND c.workflow_stage IN ('source_imported', 'manual_review')
          AND NOT EXISTS (
            SELECT 1 FROM enrichment_jobs j
            WHERE j.candidate_id = c.id AND j.kind = 'identity'
          )
        ORDER BY c.id ASC
        LIMIT ?
      `).all(this.chunkSize);

      if (discoveryCandidates.length > 0) {
        const ids = discoveryCandidates.map((c) => c.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`
          UPDATE candidates
          SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders})
        `).run(`claiming_discovery_${workerId}`, ...ids);
        db.exec("COMMIT");
        return { type: "discovery", candidates: discoveryCandidates };
      }

      db.exec("COMMIT");
      return null;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  releaseChunk(candidateIds, fallbackStage = "manual_review") {
    if (!candidateIds.length) return;
    const placeholders = candidateIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE candidates
      SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(fallbackStage, ...candidateIds);
  }

  async executeContactChunk(worker, candidates) {
    const ids = candidates.map((c) => c.id);
    worker.status = "contact_running";
    worker.currentType = "contact";
    worker.currentChunk = ids;

    this.log(`[${worker.id}] Starting contact cascade for ${ids.length} candidate(s): [${ids.join(", ")}]`);

    const startRes = await fetch(`${this.apiBase}/api/clay/contact/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateIds: ids,
        name: `Swarm ${worker.id} ${new Date().toISOString().slice(11, 19)}`,
        force: true
      })
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      this.releaseChunk(ids, "identity_confirmed");
      throw new Error(`Contact batch start failed: ${startRes.status} ${errText}`);
    }

    const { batchId, taskId } = await startRes.json();
    worker.taskId = taskId;
    this.log(`[${worker.id}] Task ${taskId} started (Batch #${batchId}). Polling...`);

    const ingestedCandidateIds = new Set();

    // Poll up to 100 times * 6s = 10 minutes
    for (let poll = 0; poll < 100; poll++) {
      await new Promise((r) => setTimeout(r, 6000));
      const res = await fetch(`${this.apiBase}/api/clay/tasks/${taskId}`);
      const data = await res.json();
      const raw = JSON.parse(data.content[0].text);

      if (poll % 5 === 0 || raw.isComplete) {
        this.log(`[${worker.id} / Task ${taskId}] Progress: ${raw.processedEntities}/${raw.totalEntities} (Complete: ${raw.isComplete})`);
      }

      // STREAMING INGESTION: Ingest completed entities on every poll without waiting for the whole batch
      const newlyFinishedRows = [];
      for (let idx = 0; idx < (raw.entities || []).length; idx++) {
        const entity = raw.entities[idx];
        const candidateId = ids[idx];
        if (ingestedCandidateIds.has(candidateId)) continue;

        const enrichments = Object.values(entity.enrichments || {})[0];
        const isEntityComplete = enrichments?.state === "completed" || enrichments?.state === "error" || raw.isComplete;

        if (isEntityComplete) {
          let val = {};
          try { val = JSON.parse(enrichments.value || "{}"); } catch {}

          const workEmail = val["Work Email"] || "";
          const mobilePhone = val["Mobile Phone"] || "";
          const org = val["Enrich person"]?.org || "";
          const title = val["Enrich person"]?.title || "";

          if (workEmail || mobilePhone) {
            this.log(`  -> [${worker.id} Stream] Candidate #${candidateId}: Email=${workEmail || "N/A"} | Phone=${mobilePhone || "N/A"} | Org=${org || "N/A"}`);
          }

          newlyFinishedRows.push({
            candidate_id: candidateId,
            work_email: workEmail,
            email_status: workEmail ? "valid" : "unverified",
            mobile_phone: mobilePhone,
            employer: org,
            current_title: title,
            provider_reference: `${taskId}:${entity.entityId}`,
            actual_credits: 3.3,
            email_actual_credits: 1.1,
            phone_actual_credits: 2.2
          });
          ingestedCandidateIds.add(candidateId);
        }
      }

      if (newlyFinishedRows.length > 0) {
        const csv = toCsv(newlyFinishedRows, [
          "candidate_id", "work_email", "email_status", "mobile_phone",
          "employer", "current_title", "provider_reference", "actual_credits",
          "email_actual_credits", "phone_actual_credits"
        ]);

        await fetch(`${this.apiBase}/api/enrichment/results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId, csvText: csv })
        });

        this.stats.contactsEnriched += newlyFinishedRows.filter((r) => r.work_email).length;
        safeExport();
      }

      if (raw.isComplete || ingestedCandidateIds.size === ids.length) {
        for (const cid of ids) {
          db.prepare(`
            UPDATE candidates
            SET workflow_stage = 'contact_unresolved', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND workflow_stage IN ('phone_queued', 'email_queued', 'claiming_contact_${worker.id}')
          `).run(cid);
        }
        this.stats.chunksProcessed += 1;
        worker.totalProcessed += ids.length;
        return { success: true, count: ids.length };
      }
    }

    this.releaseChunk(ids, "identity_confirmed");
    throw new Error(`[${worker.id}] Task ${taskId} timed out after 10 minutes`);
  }

  async executeAcademicDiscoveryChunk(worker, candidates) {
    const ids = candidates.map((c) => c.id);
    worker.status = "academic_recon_running";
    worker.currentType = "discovery";
    worker.currentChunk = ids;

    this.log(`[${worker.id}] Academic Recon: Verifying ${ids.length} candidate(s) against official AU universities: [${ids.join(", ")}]`);

    let verifiedCount = 0;

    for (const candidate of candidates) {
      try {
        const result = await verifyCandidateAcademics(candidate);
        if (result.isAcademicVerified) {
          applyAcademicVerificationDecision(db, candidate, result);
          this.log(`  ✓ [${worker.id}] Candidate #${candidate.id} (${candidate.full_name}) -> University Verified (${result.academicMatchScore} pts)`);
          verifiedCount++;
        } else {
          db.prepare(`
            UPDATE candidates
            SET workflow_stage = 'academic_unresolved',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(candidate.id);
          this.log(`  - [${worker.id}] Candidate #${candidate.id} (${candidate.full_name}) -> No public AU academic record (academic_unresolved)`);
        }
      } catch (err) {
        this.log(`  ! [${worker.id}] Candidate #${candidate.id} error: ${err.message}`);
        db.prepare(`UPDATE candidates SET workflow_stage = 'academic_unresolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(candidate.id);
      }
    }

    this.stats.candidatesDiscovered += ids.length;
    this.stats.candidatesPendingConfirmation += verifiedCount;
    this.stats.chunksProcessed += 1;
    worker.totalProcessed += ids.length;

    safeExport();
    return { success: true, count: ids.length, verifiedCount };
  }

  async executeDiscoveryChunk(worker, candidates) {
    if (this.engine === "academic") {
      return this.executeAcademicDiscoveryChunk(worker, candidates);
    }
    const ids = candidates.map((c) => c.id);
    worker.status = "discovery_running";
    worker.currentType = "discovery";
    worker.currentChunk = ids;

    this.log(`[${worker.id}] Starting LinkedIn discovery for ${ids.length} candidate(s): [${ids.join(", ")}]`);

    const startRes = await fetch(`${this.apiBase}/api/clay/identity/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateIds: ids,
        subroutineName: "Person LinkedIn URL",
        name: `Swarm Discovery ${worker.id} ${new Date().toISOString().slice(11, 19)}`
      })
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      if (errText.includes("Data already exists")) {
        this.releaseChunk(ids, "identity_unresolved");
      } else {
        this.releaseChunk(ids, "manual_review");
      }
      throw new Error(`Discovery start failed: ${startRes.status} ${errText}`);
    }

    const { batchId, taskId } = await startRes.json();
    worker.taskId = taskId;
    this.log(`[${worker.id}] Discovery Task ${taskId} started (Batch #${batchId}). Polling...`);

    for (let poll = 0; poll < 60; poll++) {
      await new Promise((r) => setTimeout(r, 6000));
      const res = await fetch(`${this.apiBase}/api/clay/tasks/${taskId}`);
      const data = await res.json();
      const raw = JSON.parse(data.content[0].text);

      if (poll % 5 === 0 || raw.isComplete) {
        this.log(`[${worker.id} / Task ${taskId}] Discovery: ${raw.processedEntities}/${raw.totalEntities} (Complete: ${raw.isComplete})`);
      }

      if (raw.isComplete) {
        const rows = [];
        for (let idx = 0; idx < raw.entities.length; idx++) {
          const entity = raw.entities[idx];
          const candidateId = ids[idx];
          const enrichments = Object.values(entity.enrichments || {})[0];
          if (enrichments?.runnerStatus === "ERROR_WORKSPACE_SALES_REP_CREDIT_LIMIT_REACHED" || /credit limit reached/i.test(enrichments?.error || "")) {
            this.log(`[Orchestrator] Clay Monthly User Credit Limit Reached! Halting swarm.`);
            this.isStopping = true;
            throw new Error("Monthly user credit limit reached in Clay");
          }
          let val = {};
          try { val = JSON.parse(enrichments.value || "{}"); } catch {}
          const linkedinUrl = val["LinkedIn URL"] || val.url || "";
          rows.push({
            candidate_id: candidateId,
            linkedin_url: linkedinUrl,
            provider_reference: `${taskId}:${entity.entityId}`,
            actual_credits: 2.2
          });
        }

        const csv = toCsv(rows, ["candidate_id", "linkedin_url", "provider_reference", "actual_credits"]);
        await fetch(`${this.apiBase}/api/enrichment/results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId, csvText: csv })
        });

        // Verification Gatekeeper scores match against AHPRA qualifications.
        // A high score with zero conflicts is routed to "pending_confirmation" —
        // it is NOT auto-confirmed. A recruiter must confirm it through the
        // review UI/API before contact enrichment (Priority 1 above) can pick it up.
        const verified = runVerificationBatch(db, ids);
        const newlyPending = verified.filter((v) => v.decision === "pending_confirmation");
        this.stats.candidatesDiscovered += ids.length;
        this.stats.candidatesPendingConfirmation += newlyPending.length;
        this.stats.chunksProcessed += 1;
        worker.totalProcessed += ids.length;

        this.log(`[${worker.id}] Verification complete: ${newlyPending.length}/${ids.length} flagged for recruiter confirmation (score >= 85, awaiting human sign-off).`);

        safeExport();
        return { success: true, count: ids.length, pendingConfirmation: newlyPending.length };
      }
    }

    this.releaseChunk(ids, "manual_review");
    throw new Error(`[${worker.id}] Discovery Task ${taskId} timed out`);
  }

  async runWorker(worker) {
    while (this.isRunning && !this.isStopping) {
      // 1. Credit Check before acquiring new work (skipped if academic engine)
      if (this.engine !== "academic") {
        const creditInfo = await this.checkCredits();
        if (creditInfo.available === false) {
          this.log(`\n[Orchestrator] Clay credits depleted (${creditInfo.message}). Worker ${worker.id} stopping.`);
          this.isStopping = true;
          break;
        }
      }

      // 2. Lease Next Chunk
      let chunk;
      try {
        chunk = this.leaseNextChunk(worker.id);
      } catch (err) {
        this.log(`[${worker.id}] Error leasing chunk:`, err.message);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      if (!chunk) {
        worker.status = "idle";
        worker.currentType = null;
        worker.currentChunk = [];
        worker.taskId = null;
        // Wait before checking for new work
        await new Promise((r) => setTimeout(r, 8000));
        continue;
      }

      // 3. Execute Chunk based on type
      try {
        if (chunk.type === "contact") {
          await this.executeContactChunk(worker, chunk.candidates);
        } else if (chunk.type === "discovery") {
          await this.executeDiscoveryChunk(worker, chunk.candidates);
        }
      } catch (err) {
        this.stats.errorsCount += 1;
        this.log(`[${worker.id}] Chunk processing error:`, err.message);
        if (/workspace credits exhausted|no credits available|insufficient credits|quota exceeded|out of credits/i.test(err.message)) {
          this.log(`[Orchestrator] Provider out of credits. Halting swarm.`);
          this.isStopping = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 6000));
      } finally {
        worker.status = "idle";
        worker.currentType = null;
        worker.currentChunk = [];
        worker.taskId = null;
      }
    }

    worker.status = "stopped";
    this.log(`[${worker.id}] Worker stopped.`);
  }

  async start() {
    this.isRunning = true;
    this.isStopping = false;

    this.log("===============================================================");
    this.log("      HEALTHCARE RECON SWARM DEPLOYED — THE SQUAD");
    this.log("===============================================================");
    this.log(`Operatives: [Scout] Recon | [Pulse] Vitals | [Hunter] Contacts`);
    this.log(`Supervisor: [The Chief] Watchdog | Concurrency: ${this.concurrency} | Chunk: ${this.chunkSize}`);
    this.log("Master Sheet: exports/hcrhub_all_enriched_combined.csv");
    this.log("===============================================================\n");

    // Check Clay connection
    let status = await this.checkClayStatus();
    while (!status.connected) {
      this.log("[The Chief] Waiting for Clay connection...");
      await new Promise((r) => setTimeout(r, 5000));
      status = await this.checkClayStatus();
    }
    this.log(`[The Chief] Clay Connected with ${status.tools.length} active tools!\n`);

    // Initial Supervisor Recovery
    const { staleRecovered, stats: initialStats } = runSupervisorCheck(db);
    if (staleRecovered > 0) {
      this.log(`[The Chief] Recovered ${staleRecovered} stale candidate lease(s).`);
    }
    this.log(`[The Chief / Baseline] Total: ${initialStats.total_candidates} | Confirmed: ${initialStats.identity_confirmed} | Emails: ${initialStats.email_verified}\n`);

    // Start periodic supervisor recovery watchdog (every 60s)
    const supervisorInterval = setInterval(() => {
      if (!this.isRunning) return;
      const { staleRecovered: recovered } = runSupervisorCheck(db);
      if (recovered > 0) {
        this.log(`[The Chief / Watchdog] Auto-recovered ${recovered} timed-out lease(s).`);
      }
    }, 60_000);

    // Launch all parallel worker loops
    const workerPromises = this.workers.map((w) => this.runWorker(w));

    await Promise.all(workerPromises);

    clearInterval(supervisorInterval);
    this.isRunning = false;

    // Final combined export & report
    const combined = exportCombinedSheet();
    const { stats: finalStats } = runSupervisorCheck(db);

    this.log("\n===============================================================");
    this.log("         SWARM ORCHESTRATOR EXECUTION COMPLETE");
    this.log("===============================================================");
    this.log(`Master Sheet: ${combined.path}`);
    this.log(`Total Candidates in Combined Sheet: ${combined.total}`);
    this.log(`Total Verified Emails: ${finalStats.email_verified}`);
    this.log(`Total Phone Numbers: ${finalStats.with_phone}`);
    this.log(`Chunks Processed in this Swarm Run: ${this.stats.chunksProcessed}`);
    this.log(`New Verified Emails in this Run: ${this.stats.contactsEnriched}`);
    this.log("===============================================================\n");

    return {
      masterSheet: combined.path,
      totalConfirmed: combined.total,
      finalStats,
      swarmStats: this.stats
    };
  }

  stop() {
    this.log("[Orchestrator] Stop requested. Draining active workers...");
    this.isStopping = true;
  }
}
