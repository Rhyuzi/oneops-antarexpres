/**
 * Indonesian mobile-number rule — browser twin of server/recheck/phone.js.
 * Both are tested against tests/fixtures/phone-cases.json (tests/test-phone.js),
 * so the rechecker queue and the loader always agree on what is valid.
 *
 *  - strips every non-digit (+, spaces, dashes, dots)
 *  - 0062… → 62…, 620… → 62… (6208… → 628…), 0… → 62…, 8… → 628…
 *  - valid = 628 followed by 7–11 digits (10–14 digits total)
 */
export interface NormalizedPhone {
  value: string
  valid: boolean
  changed: boolean
  issue: 'empty' | 'invalid' | null
}

export function normalizePhone(raw: unknown): NormalizedPhone {
  const original = raw === null || raw === undefined ? '' : String(raw).trim()
  let digits = original.replace(/\D/g, '')
  if (!digits) return { value: '', valid: false, changed: original !== '', issue: 'empty' }
  if (digits.startsWith('0062')) digits = digits.slice(2) // international 00 prefix
  if (digits.startsWith('620')) digits = '62' + digits.slice(3).replace(/^0+/, '')
  else if (digits.startsWith('0')) digits = '62' + digits.replace(/^0+/, '')
  else if (digits.startsWith('8')) digits = '62' + digits
  const valid = /^628\d{7,11}$/.test(digits)
  return { value: digits, valid, changed: digits !== original, issue: valid ? null : 'invalid' }
}
