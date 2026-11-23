<script setup lang="ts">
/**
 * Master Data audit trail (master_data.audit): who created / updated /
 * deleted / imported which reference record, with the before → after values.
 * Filters: entity, action, date range, search. Labels are translated; the
 * stored values are shown as recorded.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-vue-next'
import { formatDateTime, formatNumber, t } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'
import { ACTION_LABEL, ENTITY_TYPE_LABEL, listAudit, type AuditAction, type AuditEntry } from '../../lib/masterData'

const PAGE_SIZE = 25
const records = ref<AuditEntry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(true)
const error = ref('')
const open = ref<Set<number>>(new Set())
const filters = reactive({ entityType: '', action: '', from: '', to: '', search: '' })
const searchInput = ref('')
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const ACTIONS: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE', 'IMPORT']
const ACTION_CHIP: Record<AuditAction, string> = {
  CREATE: 'bg-emerald-100 text-emerald-700',
  UPDATE: 'bg-sky-100 text-sky-700',
  DELETE: 'bg-rose-100 text-rose-700',
  IMPORT: 'bg-violet-100 text-violet-700',
}
const dateError = computed(() => Boolean(filters.from && filters.to && filters.from > filters.to))

// Only the newest request may update the table: filters can change while an
// older request is still in flight (e.g. search debounce + action change).
let requestSeq = 0

async function load(): Promise<void> {
  if (dateError.value) return
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const r = await listAudit({
      page: page.value,
      pageSize: PAGE_SIZE,
      entityType: filters.entityType || undefined,
      action: filters.action || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      search: filters.search || undefined,
    })
    if (seq !== requestSeq) return
    records.value = r.records
    total.value = r.total
  } catch (err) {
    if (seq === requestSeq) error.value = apiErrorMessage(err, 'masterData.audit.loadFailed')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(() => [filters.entityType, filters.action, filters.from, filters.to], () => {
  page.value = 1
  void load()
})
let timer = 0
watch(searchInput, (v) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    filters.search = v.trim()
    page.value = 1
    void load()
  }, 300)
})

function reset(): void {
  Object.assign(filters, { entityType: '', action: '', from: '', to: '', search: '' })
  searchInput.value = ''
}
function goPage(p: number): void {
  page.value = Math.min(Math.max(1, p), totalPages.value)
  void load()
}
function toggle(id: number): void {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

/** before/after → rows of changed (or all, for create/delete) fields. */
function diff(e: AuditEntry): Array<{ field: string; before: string; after: string; changed: boolean }> {
  const b = e.before || {}
  const a = e.after || {}
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return keys.map((k) => ({ field: k, before: show(b[k]), after: show(a[k]), changed: show(b[k]) !== show(a[k]) }))
}
function actorName(e: AuditEntry): string {
  return e.actor.full_name || e.actor.username || t('masterData.audit.unknownUser')
}

onMounted(load)
</script>

<template>
  <section class="card space-y-4 p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="section-title">{{ t('masterData.audit.title') }}</h2>
        <p class="mt-1 text-xs text-slate-500">{{ t('masterData.audit.hint') }}</p>
      </div>
      <button type="button" class="btn btn-secondary px-3 py-1.5 text-sm" :disabled="loading" @click="load()">
        <RefreshCw :size="15" :class="loading ? 'animate-spin' : ''" /> {{ t('common.refresh') }}
      </button>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <select v-model="filters.entityType" class="input py-2" :aria-label="t('masterData.audit.entity')">
        <option value="">{{ t('masterData.audit.allEntities') }}</option>
        <option v-for="(label, type) in ENTITY_TYPE_LABEL" :key="type" :value="type">{{ t(label) }}</option>
      </select>
      <select v-model="filters.action" class="input py-2" :aria-label="t('masterData.audit.action')">
        <option value="">{{ t('masterData.audit.allActions') }}</option>
        <option v-for="a in ACTIONS" :key="a" :value="a">{{ t(ACTION_LABEL[a]) }}</option>
      </select>
      <input v-model="filters.from" type="date" class="input py-2" :aria-label="t('masterData.audit.from')" />
      <input v-model="filters.to" type="date" class="input py-2" :aria-label="t('masterData.audit.to')" />
      <input v-model="searchInput" type="text" class="input py-2" :placeholder="t('masterData.audit.searchPlaceholder')" :aria-label="t('masterData.audit.searchPlaceholder')" />
    </div>
    <div class="flex items-center justify-between text-xs text-slate-500">
      <span>{{ t('masterData.totalRecords', { count: formatNumber(total) }) }}</span>
      <button type="button" class="text-indigo-600 hover:underline" @click="reset">{{ t('common.clearFilters') }}</button>
    </div>
    <p v-if="dateError" class="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{{ t('masterData.audit.dateOrder') }}</p>
    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

    <div class="overflow-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th class="w-8 px-2 py-2"></th>
            <th class="px-3 py-2">{{ t('masterData.audit.time') }}</th>
            <th class="px-3 py-2">{{ t('masterData.audit.user') }}</th>
            <th class="px-3 py-2">{{ t('masterData.audit.action') }}</th>
            <th class="px-3 py-2">{{ t('masterData.audit.entity') }}</th>
            <th class="px-3 py-2">{{ t('masterData.audit.record') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <template v-for="e in records" :key="e.id">
            <tr class="cursor-pointer hover:bg-slate-50" @click="toggle(e.id)">
              <td class="px-2 py-2 text-slate-400">
                <ChevronDown v-if="open.has(e.id)" :size="15" />
                <ChevronRight v-else :size="15" />
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{{ e.created_at ? formatDateTime(e.created_at) : t('common.dash') }}</td>
              <td class="px-3 py-2 text-slate-700">{{ actorName(e) }}</td>
              <td class="px-3 py-2"><span class="chip" :class="ACTION_CHIP[e.action]">{{ t(ACTION_LABEL[e.action] || 'masterData.audit.actions.UPDATE') }}</span></td>
              <td class="px-3 py-2 text-slate-600">{{ ENTITY_TYPE_LABEL[e.entity_type] ? t(ENTITY_TYPE_LABEL[e.entity_type]) : e.entity_type }}</td>
              <td class="px-3 py-2 text-slate-700">
                {{ e.record_key || e.details.file || t('common.dash') }}
                <span v-if="e.record_id" class="ml-1 font-mono text-[11px] text-slate-400">#{{ e.record_id }}</span>
              </td>
            </tr>
            <tr v-if="open.has(e.id)" class="bg-slate-50/60">
              <td></td>
              <td colspan="5" class="px-3 py-3">
                <table class="w-full text-xs">
                  <thead class="text-slate-500">
                    <tr>
                      <th class="py-1 pr-3 text-left font-semibold">{{ t('masterData.audit.field') }}</th>
                      <th class="py-1 pr-3 text-left font-semibold">{{ t('masterData.audit.before') }}</th>
                      <th class="py-1 text-left font-semibold">{{ t('masterData.audit.after') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in diff(e)" :key="d.field" :class="d.changed ? 'text-slate-800' : 'text-slate-400'">
                      <td class="py-0.5 pr-3 font-mono">{{ d.field }}</td>
                      <td class="py-0.5 pr-3" :class="d.changed && d.before ? 'text-rose-700 line-through' : ''">{{ d.before || t('common.dash') }}</td>
                      <td class="py-0.5" :class="d.changed && d.after ? 'font-semibold text-emerald-700' : ''">{{ d.after || t('common.dash') }}</td>
                    </tr>
                    <tr v-if="!diff(e).length"><td colspan="3" class="py-1 text-slate-400">{{ t('masterData.audit.noValues') }}</td></tr>
                  </tbody>
                </table>
                <p v-if="e.details.file" class="mt-2 text-xs text-slate-500">{{ t('masterData.audit.file', { name: e.details.file }) }}</p>
              </td>
            </tr>
          </template>
          <tr v-if="!records.length && !loading">
            <td colspan="6" class="px-3 py-6 text-center text-sm text-slate-400">{{ t('masterData.audit.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-between text-sm text-slate-600">
      <span>{{ t('masterData.pageOf', { page: formatNumber(page), pages: formatNumber(totalPages) }) }}</span>
      <div class="flex gap-2">
        <button class="btn btn-secondary px-3 py-1.5" :disabled="page <= 1 || loading" @click="goPage(page - 1)">{{ t('common.prev') }}</button>
        <button class="btn btn-secondary px-3 py-1.5" :disabled="page >= totalPages || loading" @click="goPage(page + 1)">{{ t('common.next') }}</button>
      </div>
    </div>
  </section>
</template>
