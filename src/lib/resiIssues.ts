import { t } from '../i18n'
import type { ResiIssue } from './loaderApi'

/**
 * Issue note next to a red resi, in the active language — the same texts as
 * the KETERANGAN ISSUE column of the report (server/loader/resiIssues.js TEXT,
 * kept equal by tests/test-resi-issues.js). "" when the resi has no issue.
 */
export function issueText(issues: ResiIssue[]): string {
  return issues
    .map((x) =>
      x.type === 'duplicate'
        ? t('loader.resiIssue.duplicate', { rows: x.rows.join(', ') })
        : t('loader.resiIssue.invalid', { chars: x.chars.join(', ') })
    )
    .join(t('loader.resiIssue.separator'))
}
