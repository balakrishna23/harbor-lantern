import { db } from "../src/db.mjs";

// 1. Total Candidates in registry
const totalCandidates = db.prepare("SELECT count(*) as c FROM candidates").get().c;

// 2. LinkedIn Discovery Stats
// Touched = candidates with non-null linkedin_url OR workflow_stage not in ('source_imported')
const withLinkedIn = db.prepare("SELECT count(*) as c FROM candidates WHERE linkedin_url IS NOT NULL AND linkedin_url != ''").get().c;
const attemptedDiscovery = db.prepare("SELECT count(DISTINCT candidate_id) as c FROM enrichment_jobs WHERE kind = 'identity'").get().c;
const discoveryBatches = db.prepare("SELECT count(*) as c FROM enrichment_batches WHERE kind = 'identity'").get().c;

// 3. Identity Verification Stats
const confirmed = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed'").get().c;
const rejected = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'rejected'").get().c;
const manualReview = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'manual_review'").get().c;
const unreviewed = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'unreviewed'").get().c;

// 4. Contact Enrichment Stats (among confirmed candidates)
const contactJobs = db.prepare("SELECT count(DISTINCT candidate_id) as c FROM enrichment_jobs WHERE kind IN ('email', 'email_phone', 'phone')").get().c;
const validEmails = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND work_email IS NOT NULL AND work_email != '' AND email_status = 'valid'").get().c;
const allEmails = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND work_email IS NOT NULL AND work_email != ''").get().c;
const validPhones = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND mobile_phone IS NOT NULL AND mobile_phone != ''").get().c;
const ausMobiles = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND mobile_phone LIKE '%+614%'").get().c;
const bothEmailAndPhone = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND work_email IS NOT NULL AND work_email != '' AND mobile_phone IS NOT NULL AND mobile_phone != ''").get().c;
const atLeastOneContact = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND ((work_email IS NOT NULL AND work_email != '') OR (mobile_phone IS NOT NULL AND mobile_phone != ''))").get().c;

// 5. Total unique confirmed candidates who underwent contact enrichment
const contactAttemptedConfirmed = db.prepare(`
  SELECT count(DISTINCT candidate_id) as c 
  FROM enrichment_jobs ej 
  JOIN candidates c ON c.id = ej.candidate_id 
  WHERE ej.kind IN ('email', 'email_phone')
`).get().c;

// 6. Credits
const actualCredits = db.prepare("SELECT sum(credits) as total FROM credit_ledger WHERE entry_type = 'actual'").get().total || 0;

console.log(JSON.stringify({
  totalInRegistry: totalCandidates,
  discovery: {
    attemptedDiscovery,
    withLinkedIn,
    discoveryHitRate: attemptedDiscovery > 0 ? ((withLinkedIn / attemptedDiscovery) * 100).toFixed(1) + "%" : "N/A"
  },
  verification: {
    confirmed,
    manualReview,
    rejected,
    confirmationRate: withLinkedIn > 0 ? ((confirmed / withLinkedIn) * 100).toFixed(1) + "%" : "N/A"
  },
  contactEnrichment: {
    candidatesTargeted: contactAttemptedConfirmed,
    withValidEmail: validEmails,
    emailSuccessRate: contactAttemptedConfirmed > 0 ? ((validEmails / contactAttemptedConfirmed) * 100).toFixed(1) + "%" : "N/A",
    withMobilePhone: validPhones,
    phoneSuccessRate: contactAttemptedConfirmed > 0 ? ((validPhones / contactAttemptedConfirmed) * 100).toFixed(1) + "%" : "N/A",
    withAustralianMobile: ausMobiles,
    ausMobileRate: contactAttemptedConfirmed > 0 ? ((ausMobiles / contactAttemptedConfirmed) * 100).toFixed(1) + "%" : "N/A",
    withBothEmailAndPhone: bothEmailAndPhone,
    bothSuccessRate: contactAttemptedConfirmed > 0 ? ((bothEmailAndPhone / contactAttemptedConfirmed) * 100).toFixed(1) + "%" : "N/A",
    withAtLeastOneContact: atLeastOneContact,
    overallReachabilityRate: contactAttemptedConfirmed > 0 ? ((atLeastOneContact / contactAttemptedConfirmed) * 100).toFixed(1) + "%" : "N/A"
  },
  financials: {
    totalCreditsSpent: actualCredits,
    avgCreditsPerConfirmed: confirmed > 0 ? (actualCredits / confirmed).toFixed(2) : "0",
    avgCreditsPerDeliverableEmail: validEmails > 0 ? (actualCredits / validEmails).toFixed(2) : "0"
  }
}, null, 2));
