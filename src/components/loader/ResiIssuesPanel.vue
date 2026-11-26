<script setup lang="ts">
/**
 * Red resi issue list: Excel row · resi · issue note (why it is red — resi
 * double with the twin rows and/or invalid characters, both when both apply).
 * Same red as the downloaded files. Used for the file-mode confirmation, the
 * API pre-check and the result.
 */
import { AlertOctagon } from 'lucide-vue-next'
import { formatNumber, t, type MessageKey, type MessageParams } from '../../i18n'
import { issueText } from '../../lib/resiIssues'
import type { ResiIssueRow } from '../../lib/loaderApi'

const props = withDefaults(
  defineProps<{ rows: ResiIssueRow[]; titleKey: MessageKey; titleParams?: MessageParams; hint?: MessageKey | null; truncated?: boolean }>(),
  { titleParams: () => ({}), hint: null, truncated: false }
)
</script>

<template>
  <div class="space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-3" role="alert" data-testid="resi-issues">
    <p class="flex items-center gap-2 text-sm font-semibold text-rose-800">
      <AlertOctagon :size="16" class="shrink-0" />
      {{ t(props.titleKey, props.titleParams) }}
    </p>
    <p v-if="props.hint" class="text-xs text-rose-700">{{ t(props.hint) }}</p>
    <div class="max-h-64 overflow-auto rounded-lg border border-rose-200 bg-white">
      <table class="w-full text-left text-xs">
        <thead class="sticky top-0 bg-rose-100 text-rose-800">
          <tr>
            <th class="w-16 px-3 py-1.5">{{ t('loader.resiIssue.colRow') }}</th>
            <th class="px-3 py-1.5">{{ t('loader.resiIssue.colResi') }}</th>
            <th class="px-3 py-1.5">{{ t('loader.resiIssue.colIssue') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in props.rows" :key="r.row" class="border-t border-rose-200 bg-rose-50 text-rose-800" data-issue="true">
            <td class="px-3 py-1.5 font-mono">{{ formatNumber(r.row) }}</td>
            <td class="px-3 py-1.5 font-mono font-semibold">{{ r.resi }}</td>
            <td class="px-3 py-1.5" data-testid="issue-note">{{ issueText(r.issues) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="props.truncated" class="text-xs text-rose-700">{{ t('loader.resiIssue.truncated') }}</p>
    <slot />
  </div>
</template>
