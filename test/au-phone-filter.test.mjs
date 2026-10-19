import test from "node:test";
import assert from "node:assert/strict";
import { parseAndValidatePhone, isAustralianMobile, isAustralianPhone } from "../src/phone-validator.mjs";

test("parseAndValidatePhone accepts valid Australian mobiles in all common formats", () => {
  assert.equal(parseAndValidatePhone("+61412345678").normalized, "+61412345678");
  assert.equal(parseAndValidatePhone("0412345678").normalized, "+61412345678");
  assert.equal(parseAndValidatePhone("+61 412 345 678").normalized, "+61412345678");
  assert.equal(parseAndValidatePhone("'+61491570156").normalized, "+61491570156");
  assert.equal(isAustralianMobile("0491570006"), true);
});

test("parseAndValidatePhone accepts Australian Canberra/NSW landline (02)", () => {
  const res = parseAndValidatePhone("+61261234567");
  assert.equal(res.isValidAu, true);
  assert.equal(res.isAuLandline, true);
  assert.equal(res.normalized, "+61261234567");
});

test("parseAndValidatePhone rejects and flags non-Australian phone numbers (+1, +91, +44, +971)", () => {
  // US/Canada
  const us = parseAndValidatePhone("+15128209742");
  assert.equal(us.isValidAu, false);
  assert.equal(us.isInternational, true);
  assert.equal(us.normalized, null);

  // India
  const india = parseAndValidatePhone("'+919811045588");
  assert.equal(india.isValidAu, false);
  assert.equal(india.isInternational, true);

  // UK
  const uk = parseAndValidatePhone("+447855064390");
  assert.equal(uk.isValidAu, false);
  assert.equal(uk.isInternational, true);

  // UAE
  const uae = parseAndValidatePhone("'+971563266425");
  assert.equal(uae.isValidAu, false);
  assert.equal(uae.isInternational, true);

  // Ireland
  const ireland = parseAndValidatePhone("+353861068560");
  assert.equal(ireland.isValidAu, false);
  assert.equal(ireland.isInternational, true);
});
