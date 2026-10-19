import { db } from "../src/db.mjs";

const confirmed = db.prepare("SELECT id, full_name, mobile_phone, international_phone, work_email FROM candidates WHERE identity_status = 'confirmed'").all();
console.log("=== CONFIRMED CANDIDATES PURITY REPORT ===");
console.log(`Total Confirmed: ${confirmed.length}`);

const withForeignPhone = confirmed.filter(c => c.international_phone);
console.log(`With International Phone: ${withForeignPhone.length} (Expected: 0)`);

const withMobile = confirmed.filter(c => c.mobile_phone);
console.log(`With AU Mobile: ${withMobile.length}`);

const withEmail = confirmed.filter(c => c.work_email);
console.log(`With Work Email: ${withEmail.length}`);

console.log("\nAll Mobile Phones:");
withMobile.forEach(c => console.log(`  [#${c.id}] ${c.full_name}: ${c.mobile_phone}`));

console.log("\nAll Work Emails:");
withEmail.forEach(c => console.log(`  [#${c.id}] ${c.full_name}: ${c.work_email}`));
