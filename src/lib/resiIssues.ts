import { t } from '../i18n'
import type { ResiIssue } from './loaderApi'

/** Invisible or control character — same set as server/loader/resiIssues.js isInvisible(). */
function isInvisible(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (
    cp < 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad ||
    (cp >= 0x2000 && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) ||
    cp === 0x2060 || cp === 0x3000 || cp === 0xfeff
  )
}

/** " " → "spasi" / "space"; invisible → "U+200B"; others as they are. */
function charLabel(ch: string): string {
  if (ch === ' ') return t('loader.resiIssue.space')
  if (isInvisible(ch)) return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
  return ch
}

/**
 * Issue note next to a red resi, in the active language — the same texts as
 * the KETERANGAN ISSUE column of the Loader JNE file (server/loader/resiIssues.js
 * TEXT, kept equal by tests/test-resi-issues.js). "" when the resi has no issue.
 */
export function issueText(issues: ResiIssue[]): string {
  return issues
    .map((x) =>
      x.type === 'duplicate'
        ? t('loader.resiIssue.duplicate', { rows: x.rows.join(', ') })
        : t('loader.resiIssue.invalid', { chars: x.chars.map(charLabel).join(', ') })
    )
    .join(t('loader.resiIssue.separator'))
}
