<script setup lang="ts">
/**
 * Bulk create folders from an Excel list (Data Warrior). One folder per row
 * (column "Folder" / "Nama Folder", or the first column). The server refuses
 * duplicates — names repeated in the file or already in the target folder —
 * and reports them; this dialog shows the result per row and a notification.
 */
import { computed, ref } from 'vue'
import { CheckCircle2, FileSpreadsheet, X } from 'lucide-vue-next'
import LoadingButton from '../LoadingButton.vue'
import { useAsyncAction } from '../../composables/useAsyncAction'
import { formatNumber, t, type MessageKey } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'
import { fileToPayload } from '../../lib/loaderApi'
import { bulkCreateFolders, type BulkFolderResult, type BulkSkipReason } from '../../lib/storageApi'
import { storageStore } from '../../stores/storage'

const props = defineProps<{ parentId: number | null; parentName: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const input = ref<HTMLInputElement | null>(null)
const result = ref<BulkFolderResult | null>(null)
const error = ref('')

const REASON: Record<BulkSkipReason, MessageKey> = {
  duplicate_in_file: 'storage.bulkReasonDuplicate',
  exists: 'storage.bulkReasonExists',
  invalid: 'storage.bulkReasonInvalid',
}
const duplicates = computed(() => (result.value ? result.value.skipped.filter((s) => s.reason !== 'invalid') : []))
/** Every row of the file: created first by row number, then skipped. */
const rows = computed(() => {
  if (!result.value) return []
  return [
    ...result.value.created.map((c) => ({ row: c.row, name: c.name, ok: true, note: t('storage.bulkCreated') })),
    ...result.value.skipped.map((s) => ({ row: s.row, name: s.name, ok: false, note: t(REASON[s.reason], { row: s.firstRow ?? '' }) })),
  ].sort((a, b) => a.row - b.row)
})

const uploadAction = useAsyncAction(async (file: File): Promise<void> => {
  error.value = ''
  result.value = null
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return void (error.value = t('storage.bulkFileType'))
  try {
    const r = await bulkCreateFolders(props.parentId, await fileToPayload(file))
    result.value = r
    emit('done')
    // Notification: how many were created / skipped, and which names were duplicates.
    storageStore.toast(r.created.length ? 'success' : 'info', t('storage.bulkSummary', { created: formatNumber(r.created.length), skipped: formatNumber(r.skipped.length) }), 6000)
    const dupNames = [...new Set(r.skipped.filter((s) => s.reason !== 'invalid').map((s) => s.name))]
    if (dupNames.length) {
      const shown = dupNames.slice(0, 8).join(', ') + (dupNames.length > 8 ? ` +${dupNames.length - 8}` : '')
      storageStore.toast('error', t('storage.bulkDuplicatesToast', { count: formatNumber(dupNames.length), names: shown }), 10000)
    }
  } catch (err) {
    error.value = apiErrorMessage(err, 'storage.bulkFailed')
  }
})

function pick(e: Event): void {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  el.value = ''
  if (f) void uploadAction.run(f)
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="emit('close')">
      <div class="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-6 shadow-2xl" role="dialog" :aria-label="t('storage.bulkTitle')" data-testid="bulk-dialog">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 class="section-title">{{ t('storage.bulkTitle') }}</h3>
            <p class="mt-1 text-xs text-slate-500">{{ t('storage.bulkTarget', { name: props.parentName || t('storage.bulkRoot') }) }}</p>
          </div>
          <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" :aria-label="t('common.close')" @click="emit('close')"><X :size="18" /></button>
        </div>
        <p class="mb-4 text-sm text-slate-600">{{ t('storage.bulkHint') }}</p>

        <div class="flex flex-wrap items-center gap-3">
          <LoadingButton class="btn btn-primary" :loading="uploadAction.pending" :loading-text="t('storage.bulkCreating')" @click="input?.click()">
            <FileSpreadsheet :size="16" /> {{ result ? t('storage.bulkAnother') : t('storage.bulkChoose') }}
          </LoadingButton>
          <input ref="input" type="file" accept=".xlsx,.xls,.csv" class="hidden" data-testid="bulk-input" @change="pick" />
        </div>
        <p v-if="error" class="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

        <template v-if="result">
          <p class="mt-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm" :class="result.skipped.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'" data-testid="bulk-summary">
            <CheckCircle2 :size="16" class="shrink-0" />
            {{ t('storage.bulkSummary', { created: formatNumber(result.created.length), skipped: formatNumber(result.skipped.length) }) }}
          </p>
          <p v-if="duplicates.length" class="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {{ t('storage.bulkDuplicatesTitle', { count: formatNumber(duplicates.length) }) }}
          </p>
          <div class="mt-3 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200">
            <table class="w-full text-left text-sm">
              <thead class="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th class="w-16 px-3 py-2">{{ t('storage.bulkRow') }}</th>
                  <th class="px-3 py-2">{{ t('storage.folderName') }}</th>
                  <th class="px-3 py-2">{{ t('storage.bulkStatus') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="r in rows" :key="r.row" :class="r.ok ? 'text-slate-700' : 'bg-rose-50 text-rose-800'" :data-skipped="r.ok ? undefined : 'true'">
                  <td class="px-3 py-1.5 font-mono text-xs">{{ r.row }}</td>
                  <td class="px-3 py-1.5">{{ r.name }}</td>
                  <td class="px-3 py-1.5 text-xs">{{ r.note }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
