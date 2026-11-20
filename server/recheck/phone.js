"use strict";

/**
 * THE Indonesian mobile-number rule, shared by the loader (Rule 8) and the
 * server-side recheck queue. The browser rechecker uses the same rule in
 * src/lib/phone.ts; both implementations are tested against the same vectors
 * (tests/fixtures/phone-cases.json), so they cannot drift.
 *
 *  - strips every non-digit (+, spaces, dashes, dots)
 *  - 0062… → 62…, 620… → 62… (6208… → 628…), 0… → 62…, 8… → 628…
 *  - valid = 628 followed by 7–11 digits (10–14 digits total)
 *
 * @returns {{ value: string, valid: boolean, changed: boolean, issue: "empty"|"invalid"|null }}
 */
function normalizePhone(raw) {
  const original = raw === null || raw === undefined ? "" : String(raw).trim();
  let digits = original.replace(/\D/g, "");
  if (!digits) return { value: "", valid: false, changed: original !== "", issue: "empty" };
  if (digits.startsWith("0062")) digits = digits.slice(2); // international 00 prefix
  if (digits.startsWith("620")) digits = "62" + digits.slice(3).replace(/^0+/, "");
  else if (digits.startsWith("0")) digits = "62" + digits.replace(/^0+/, "");
  else if (digits.startsWith("8")) digits = "62" + digits;
  const valid = /^628\d{7,11}$/.test(digits);
  return { value: digits, valid, changed: digits !== original, issue: valid ? null : "invalid" };
}

module.exports = { normalizePhone };
