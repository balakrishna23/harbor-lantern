/**
 * Australian Phone Number Validator & Normalizer
 * Enforces strict Australian phone standards (+61) to prevent overseas numbers
 * (+1, +91, +44, +971, etc.) from contaminating candidate outreach channels.
 */

export function parseAndValidatePhone(rawPhone) {
  if (!rawPhone) {
    return { isValidAu: false, isAuMobile: false, isAuLandline: false, normalized: null, isInternational: false, raw: "" };
  }

  const raw = String(rawPhone).trim();
  // Strip single quotes, spaces, dashes, parentheses
  const cleaned = raw.replace(/['"\s\-()]/g, "");

  // International phone check (non +61)
  if (cleaned.startsWith("+") && !cleaned.startsWith("+61")) {
    return {
      isValidAu: false,
      isAuMobile: false,
      isAuLandline: false,
      normalized: null,
      isInternational: true,
      raw
    };
  }

  // Handle Australian numbers
  let digits = cleaned;
  if (digits.startsWith("+61")) {
    digits = digits.slice(3);
  } else if (digits.startsWith("61") && digits.length >= 10) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // Mobile: starts with 4 and has 9 digits total (e.g. 412 345 678)
  if (/^4\d{8}$/.test(digits)) {
    return {
      isValidAu: true,
      isAuMobile: true,
      isAuLandline: false,
      normalized: `+61${digits}`,
      isInternational: false,
      raw
    };
  }

  // Landline: starts with 2 (ACT/NSW), 3 (VIC/TAS), 7 (QLD), 8 (SA/WA/NT) and has 9 digits total
  if (/^[2378]\d{8}$/.test(digits)) {
    return {
      isValidAu: true,
      isAuMobile: false,
      isAuLandline: true,
      normalized: `+61${digits}`,
      isInternational: false,
      raw
    };
  }

  return {
    isValidAu: false,
    isAuMobile: false,
    isAuLandline: false,
    normalized: null,
    isInternational: cleaned.startsWith("+") || cleaned.length > 10,
    raw
  };
}

export function isAustralianMobile(phone) {
  return parseAndValidatePhone(phone).isAuMobile;
}

export function isAustralianPhone(phone) {
  return parseAndValidatePhone(phone).isValidAu;
}
