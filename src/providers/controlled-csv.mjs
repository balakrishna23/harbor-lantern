import { toCsv } from "../csv.mjs";

export const controlledCsvProvider = Object.freeze({
  id: "controlled_csv",
  label: "Controlled CSV exchange",
  executesAutomatically: false,
  supports: ["identity", "email", "phone", "email_phone"],
  requiresManualExport: true,
  requiresManualResultImport: true
});

export const exportColumns = [
  "candidate_id", "ahpra_number", "full_name", "first_name", "middle_name", "last_name",
  "profession", "registration_status", "suburb", "state", "postcode", "qualifications",
  "linkedin_url", "company_name", "company_domain", "existing_work_email"
];

export function controlledCsv(rows) {
  return toCsv(rows, exportColumns);
}

function value(row, ...names) {
  for (const name of names) {
    const found = row[name];
    if (found != null && String(found).trim()) return String(found).trim();
  }
  return "";
}

export function normalizeControlledCsvResult(row) {
  return {
    candidateId: Number(value(row, "candidate_id", "Candidate ID")),
    providerReference: value(row, "provider_reference", "Provider Reference", "clay_record_id", "Clay Record ID"),
    fullName: value(row, "matched_full_name", "full_name", "Full Name"),
    profession: value(row, "matched_profession", "profession", "Profession"),
    state: value(row, "matched_state", "state", "State"),
    postcode: value(row, "matched_postcode", "postcode", "Postcode"),
    qualifications: value(row, "matched_qualifications", "qualifications", "Qualifications"),
    graduationYear: value(row, "graduation_year", "education_year", "matched_graduation_year", "Graduation Year"),
    linkedinUrl: value(row, "linkedin_url", "LinkedIn URL"),
    employer: value(row, "employer", "company_name", "Company Name"),
    companyDomain: value(row, "company_domain", "Company Domain"),
    currentTitle: value(row, "current_title", "Current Title"),
    workEmail: value(row, "work_email", "email", "Work Email"),
    emailStatus: value(row, "email_status", "Email Status").toLowerCase(),
    businessPhone: value(row, "business_phone", "Business Phone"),
    mobilePhone: value(row, "mobile_phone", "Mobile Phone"),
    actualCredits: value(row, "actual_credits", "Actual Credits") === "" ? null : Number(value(row, "actual_credits", "Actual Credits")),
    emailActualCredits: value(row, "email_actual_credits", "Email Actual Credits") === "" ? null : Number(value(row, "email_actual_credits", "Email Actual Credits")),
    phoneActualCredits: value(row, "phone_actual_credits", "Phone Actual Credits") === "" ? null : Number(value(row, "phone_actual_credits", "Phone Actual Credits"))
    ,errorCode: value(row, "error_code", "Error Code")
    ,errorMessage: value(row, "error_message", "Error Message")
  };
}
