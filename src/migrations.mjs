function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/, 1)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

const migrations = [
  {
    version: 1,
    name: "initial_pilot_schema",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          file_hash TEXT NOT NULL UNIQUE,
          source_name TEXT NOT NULL DEFAULT 'AHPRA licensed data',
          agreement_reference TEXT,
          imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          total_rows INTEGER NOT NULL DEFAULT 0,
          inserted_rows INTEGER NOT NULL DEFAULT 0,
          duplicate_rows INTEGER NOT NULL DEFAULT 0,
          rejected_rows INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          import_id INTEGER NOT NULL REFERENCES imports(id),
          source_row INTEGER NOT NULL,
          source_hash TEXT NOT NULL UNIQUE,
          ahpra_number TEXT,
          full_name TEXT NOT NULL,
          first_name TEXT,
          middle_name TEXT,
          last_name TEXT,
          alternative_name TEXT,
          profession TEXT,
          registration_status TEXT,
          registration_type TEXT,
          registration_expiry TEXT,
          suburb TEXT,
          state TEXT,
          postcode TEXT,
          qualifications TEXT,
          languages TEXT,
          specialty TEXT,
          specialty_fields TEXT,
          linkedin_url TEXT,
          employer TEXT,
          current_title TEXT,
          identity_confidence INTEGER NOT NULL DEFAULT 0,
          identity_status TEXT NOT NULL DEFAULT 'unreviewed',
          work_email TEXT,
          email_status TEXT NOT NULL DEFAULT 'not_checked',
          business_phone TEXT,
          mobile_phone TEXT,
          enrichment_source TEXT,
          enriched_at TEXT,
          contact_basis_approved INTEGER NOT NULL DEFAULT 0,
          suppressed INTEGER NOT NULL DEFAULT 0,
          opted_out INTEGER NOT NULL DEFAULT 0,
          campaign_status TEXT NOT NULL DEFAULT 'not_ready',
          recruiter_notes TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_candidates_profession ON candidates(profession);
        CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state);
        CREATE INDEX IF NOT EXISTS idx_candidates_identity ON candidates(identity_status, identity_confidence);
        CREATE INDEX IF NOT EXISTS idx_candidates_campaign ON candidates(campaign_status);

        CREATE TABLE IF NOT EXISTS registrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          import_id INTEGER NOT NULL REFERENCES imports(id),
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          source_row INTEGER NOT NULL,
          registration_number TEXT,
          registration_status TEXT,
          registration_type TEXT,
          registration_expiry TEXT,
          source_record TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(import_id, source_row)
        );
        CREATE INDEX IF NOT EXISTS idx_registrations_candidate ON registrations(candidate_id);
        CREATE INDEX IF NOT EXISTS idx_registrations_number ON registrations(registration_number);

        CREATE TABLE IF NOT EXISTS enrichment_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('identity','email','phone','email_phone')),
          status TEXT NOT NULL DEFAULT 'draft',
          record_count INTEGER NOT NULL,
          estimated_credits REAL NOT NULL,
          credit_budget REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          exported_at TEXT
        );

        CREATE TABLE IF NOT EXISTS enrichment_batch_items (
          batch_id INTEGER NOT NULL REFERENCES enrichment_batches(id) ON DELETE CASCADE,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          status TEXT NOT NULL DEFAULT 'queued',
          PRIMARY KEY(batch_id, candidate_id)
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
  },
  {
    version: 2,
    name: "controlled_enrichment_history",
    up(db) {
      addColumn(db, "candidates", "workflow_stage TEXT NOT NULL DEFAULT 'source_imported'");
      addColumn(db, "candidates", "identity_match_score INTEGER");
      addColumn(db, "candidates", "match_confidence TEXT");
      addColumn(db, "candidates", "match_reasons TEXT");
      addColumn(db, "candidates", "conflicting_evidence TEXT");
      addColumn(db, "candidates", "identity_provider TEXT");
      addColumn(db, "candidates", "identity_provider_reference TEXT");
      addColumn(db, "candidates", "identity_discovered_at TEXT");
      addColumn(db, "candidates", "identity_reviewed_at TEXT");
      addColumn(db, "candidates", "reviewer_decision TEXT");
      addColumn(db, "candidates", "company_domain TEXT");

      addColumn(db, "enrichment_batches", "provider TEXT NOT NULL DEFAULT 'controlled_csv'");
      addColumn(db, "enrichment_batches", "dry_run INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "enrichment_batches", "record_ceiling INTEGER NOT NULL DEFAULT 4");
      addColumn(db, "enrichment_batches", "actual_credits REAL NOT NULL DEFAULT 0");
      addColumn(db, "enrichment_batches", "stopped_reason TEXT");
      addColumn(db, "enrichment_batch_items", "idempotency_key TEXT");
      addColumn(db, "enrichment_batch_items", "updated_at TEXT");

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_items_idempotency
          ON enrichment_batch_items(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_candidates_workflow ON candidates(workflow_stage);

        CREATE TABLE IF NOT EXISTS enrichment_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER REFERENCES enrichment_batches(id),
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          kind TEXT NOT NULL,
          provider TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          idempotency_key TEXT NOT NULL UNIQUE,
          dry_run INTEGER NOT NULL DEFAULT 1,
          estimated_credits REAL NOT NULL DEFAULT 0,
          actual_credits REAL NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_candidate ON enrichment_jobs(candidate_id, kind);
        CREATE INDEX IF NOT EXISTS idx_jobs_batch ON enrichment_jobs(batch_id);

        CREATE TABLE IF NOT EXISTS enrichment_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES enrichment_jobs(id),
          attempt_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          estimated_credits REAL NOT NULL DEFAULT 0,
          actual_credits REAL NOT NULL DEFAULT 0,
          provider_reference TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT,
          UNIQUE(job_id, attempt_number)
        );

        CREATE TABLE IF NOT EXISTS provider_responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES enrichment_jobs(id),
          attempt_id INTEGER REFERENCES enrichment_attempts(id),
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          provider TEXT NOT NULL,
          provider_reference TEXT,
          response_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_provider_responses_candidate ON provider_responses(candidate_id);

        CREATE TABLE IF NOT EXISTS match_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          job_id INTEGER REFERENCES enrichment_jobs(id),
          score INTEGER,
          confidence_band TEXT,
          reasons_json TEXT NOT NULL DEFAULT '[]',
          conflicts_json TEXT NOT NULL DEFAULT '[]',
          provider TEXT,
          provider_reference TEXT,
          discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_match_evidence_candidate ON match_evidence(candidate_id, discovered_at);

        CREATE TABLE IF NOT EXISTS contact_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          kind TEXT NOT NULL CHECK(kind IN ('work_email','business_phone','mobile_phone')),
          contact_value TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'unverified',
          provider TEXT NOT NULL,
          provider_reference TEXT,
          enriched_at TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_contact_points_candidate ON contact_points(candidate_id, kind, created_at);

        CREATE TABLE IF NOT EXISTS credit_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER REFERENCES enrichment_batches(id),
          job_id INTEGER REFERENCES enrichment_jobs(id),
          candidate_id INTEGER REFERENCES candidates(id),
          kind TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('estimate','actual','adjustment')),
          credits REAL NOT NULL,
          provider TEXT,
          provider_reference TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_credit_ledger_batch ON credit_ledger(batch_id, created_at);

        CREATE TABLE IF NOT EXISTS suppression_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          suppressed INTEGER NOT NULL,
          opted_out INTEGER NOT NULL,
          reason TEXT,
          actor TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_suppression_history_candidate ON suppression_history(candidate_id, created_at);

        CREATE TABLE IF NOT EXISTS review_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          decision TEXT NOT NULL,
          match_score INTEGER,
          notes TEXT,
          reviewer TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_review_history_candidate ON review_history(candidate_id, created_at);
      `);

      db.exec(`
        UPDATE candidates SET
          identity_match_score = COALESCE(identity_match_score, identity_confidence),
          workflow_stage = CASE
            WHEN opted_out = 1 THEN 'opted_out'
            WHEN suppressed = 1 THEN 'suppressed'
            WHEN campaign_status = 'ready' THEN 'campaign_ready'
            WHEN email_status = 'valid' THEN 'email_verified'
            WHEN identity_status = 'confirmed' THEN 'identity_confirmed'
            WHEN identity_status = 'rejected' THEN 'identity_rejected'
            WHEN identity_status IN ('manual_review', 'pending_confirmation') THEN 'manual_review'
            ELSE 'source_imported'
          END
      `);
    }
  },
  {
    version: 3,
    name: "provider_task_references",
    up(db) {
      addColumn(db, "enrichment_jobs", "provider_reference TEXT");
    }
  },
  {
    version: 4,
    name: "clear_stale_completed_job_errors",
    up(db) {
      db.exec("UPDATE enrichment_jobs SET error_code = NULL, error_message = NULL WHERE status = 'completed'");
    }
  },
  {
    version: 5,
    name: "ai_search_indices",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_candidates_last_name ON candidates(last_name);
        CREATE INDEX IF NOT EXISTS idx_candidates_postcode ON candidates(postcode);
      `);
    }
  },
  {
    version: 6,
    name: "add_international_phone_quarantine",
    up(db) {
      addColumn(db, "candidates", "international_phone TEXT");
    }
  },
  {
    version: 7,
    name: "browser_agent_leads",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          linkedin_url TEXT,
          matched_full_name TEXT,
          headline TEXT,
          employer TEXT,
          current_title TEXT,
          location TEXT,
          education_snippet TEXT,
          raw_payload TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'found',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_browser_leads_candidate ON browser_leads(candidate_id, created_at);
      `);
    }
  },
  {
    version: 8,
    name: "verified_profile_location",
    // Location derived from a verified match's LinkedIn profile (see
    // src/au-location.mjs). Kept separate from the register's own
    // suburb/state/postcode, which are licensed source facts.
    up(db) {
      addColumn(db, "candidates", "profile_location TEXT");
      addColumn(db, "candidates", "profile_suburb TEXT");
      addColumn(db, "candidates", "profile_state TEXT");
      addColumn(db, "candidates", "profile_postcode TEXT");
      addColumn(db, "candidates", "profile_location_precision TEXT");
    }
  },
  {
    version: 9,
    name: "match_keys",
    // Derived disambiguation keys (see src/match-keys.mjs). Fully rebuildable
    // from candidates; holds no data that is not already in the register.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS match_keys (
          candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id),
          name_key TEXT,
          full_name_key TEXT,
          name_count INTEGER NOT NULL DEFAULT 0,
          full_name_count INTEGER NOT NULL DEFAULT 0,
          uniqueness TEXT NOT NULL,
          institution TEXT,
          institution_known INTEGER NOT NULL DEFAULT 0,
          grad_year INTEGER,
          earliest_year INTEGER,
          inferred_state TEXT,
          register_state TEXT,
          qualification_country TEXT,
          overseas_trained INTEGER NOT NULL DEFAULT 0,
          tier INTEGER NOT NULL,
          built_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_match_keys_tier ON match_keys(tier);
        CREATE INDEX IF NOT EXISTS idx_match_keys_name ON match_keys(name_key);
      `);
    }
  },
  {
    version: 10,
    name: "provider_lookups",
    // One row per direct provider API call (bake-offs and, later, live runs).
    // Results here never change candidate identity fields on their own.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_lookups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id),
          sample_group TEXT,
          provider TEXT NOT NULL,
          query_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          error_code TEXT,
          likelihood INTEGER,
          credits_used REAL NOT NULL DEFAULT 0,
          provider_reference TEXT,
          decision TEXT,
          score INTEGER,
          signals_json TEXT NOT NULL DEFAULT '{}',
          reasons_json TEXT NOT NULL DEFAULT '[]',
          conflicts_json TEXT NOT NULL DEFAULT '[]',
          person_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_provider_lookups_candidate ON provider_lookups(candidate_id, provider);
        CREATE INDEX IF NOT EXISTS idx_provider_lookups_run ON provider_lookups(run_id);
      `);
    }
  },
  {
    version: 11,
    name: "email_findings",
    // Work emails found by HCRHUB's own engine (src/email-engine/), kept apart
    // from provider-supplied contact_points. One current row per candidate;
    // may_email is the Spam Act guardrail (0 for any address we built).
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_findings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
          email TEXT,
          domain TEXT,
          pattern TEXT,
          confidence TEXT NOT NULL,
          verification TEXT NOT NULL,
          source TEXT,
          may_email INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          alternatives_json TEXT NOT NULL DEFAULT '[]',
          run_id TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_email_findings_domain ON email_findings(domain);
      `);
    }
  },
  {
    version: 12,
    name: 'school_verification_checks',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS school_verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        register_import_id INTEGER NOT NULL REFERENCES imports(id),
        candidate_id INTEGER REFERENCES candidates(id),
        decision TEXT NOT NULL,
        database_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        profile_url TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(run_id, profile_id)
      );
      CREATE INDEX IF NOT EXISTS idx_school_checks_candidate ON school_verification_checks(candidate_id);
      CREATE INDEX IF NOT EXISTS idx_school_checks_run ON school_verification_checks(run_id);`);
    }
  }
];

export function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const record = db.prepare("INSERT INTO schema_migrations(version, name) VALUES (?, ?)");
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      record.run(migration.version, migration.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}

export const migrationVersions = migrations.map(({ version, name }) => ({ version, name }));
