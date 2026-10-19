import { db } from "../src/db.mjs";

console.log("=== CURRENT PHONE NUMBERS AUDIT ===");

const withPhone = db.prepare(`
  SELECT id, full_name, mobile_phone, business_phone, workflow_stage
  FROM candidates
  WHERE (mobile_phone IS NOT NULL AND mobile_phone != '')
     OR (business_phone IS NOT NULL AND business_phone != '')
`).all();

console.log(`Total candidates with any phone: ${withPhone.length}`);

let auMobiles = 0;
let nonAuPhones = 0;
const prefixCounts = {};

for (const c of withPhone) {
  const phone = (c.mobile_phone || c.business_phone || "").replace(/['\s]/g, "");
  let prefix = "other";
  if (phone.startsWith("+61") || phone.startsWith("04") || phone.startsWith("61")) prefix = "+61 (Australia)";
  else if (phone.startsWith("+1")) prefix = "+1 (US/Canada)";
  else if (phone.startsWith("+44")) prefix = "+44 (UK)";
  else if (phone.startsWith("+91")) prefix = "+91 (India)";
  else if (phone.startsWith("+971")) prefix = "+971 (UAE)";
  else if (phone.startsWith("+353")) prefix = "+353 (Ireland)";
  else if (phone.startsWith("+")) prefix = phone.slice(0, 4);

  prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
  if (prefix === "+61 (Australia)") auMobiles++;
  else nonAuPhones++;
}

console.log("Phone Prefix Breakdown:", prefixCounts);
console.log({ auMobiles, nonAuPhones });
