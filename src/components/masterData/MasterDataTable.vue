<script setup lang="ts">
/**
 * Generic Master Data CRUD table for one loader reference entity:
 * search, filters, pagination, create / edit (modal), delete (confirm) and
 * Excel import. Read-only without master_data.manage (the server enforces it
 * too). Every change is audited server-side.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-vue-next'
import LoadingButton from '../LoadingButton.vue'
import { useAsyncAction, useKeyedActions } from '../../composables/useAsyncAction'
import { authStore } from '../../stores/auth'
import { formatDateTime, formatNumber, t } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'
import { fileToPayload } from '../../lib/loaderApi'
import {
  createRow,
  deleteRow,
  getMeta,
  importFile,
  listRows,
  updateRow,
  type EntityDef,
  type MasterRow,
  type MasterWilayahOption,
} from '../../lib/masterData'

const props = defineProps<{ entity: EntityDef }>()

const canManage = computed(() => authStore.can('master_data.manage'))
const rows = ref<MasterRow[]>([])
const total = ref(0)
const page = ref(1)
const PAGE_SIZE = 25
const loading = ref(true)
const error = ref('')
const message = ref('')
const searchInput = ref('')
const search = ref('')
const wilayahFilter = ref('')
const missingOnly = ref(false)
const wilayahOptions = ref<string[]>([])
// master_wilayah rows (FK wilayah_id) for the cust-id / wilayah-kota forms + filter.
const masterWilayah = ref<MasterWilayahOption[]>([])
const wilayahIdFilter = ref('')
const canImport = computed(() => props.entity.importable !== false)
const fileInput = ref<HTMLInputElement | null>(null)
const rowOps = useKeyedActions()

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

// Only the newest request may update the table: search (debounced), filters
// and paging can change while an older request is still in flight.
let requestSeq = 0

async function load(): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const r = await listRows(props.entity.key, {
      page: page.value,
      pageSize: PAGE_SIZE,
      search: search.value || undefined,
      wilayah: props.entity.filters.includes('wilayah') && wilayahFilter.value ? wilayahFilter.value : undefined,
      missingLabel: props.entity.filters.includes('missingLabel') && missingOnly.value ? '1' : undefined,
      wilayahId: props.entity.filters.includes('wilayahId') && wilayahIdFilter.value ? wilayahIdFilter.value : undefined,
    })
    if (seq !== requestSeq) return
    rows.value = r.rows
    total.value = r.total
  } catch (err) {
    if (seq === requestSeq) error.value = apiErrorMessage(err, 'masterData.loadFailed')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

async function loadMeta(): Promise<void> {
  try {
    const meta = await getMeta()
    wilayahOptions.value = meta.wilayah
    masterWilayah.value = meta.masterWilayah ?? []
  } catch {
    wilayahOptions.value = []
    masterWilayah.value = []
  }
}

let timer = 0
watch(searchInput, (v) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    search.value = v.trim()
    page.value = 1
    void load()
  }, 300)
})
watch([wilayahFilter, missingOnly, wilayahIdFilter], () => {
  page.value = 1
  void load()
})
watch(() => props.entity.key, () => {
  searchInput.value = ''
  search.value = ''
  wilayahFilter.value = ''
  wilayahIdFilter.value = ''
  missingOnly.value = false
  page.value = 1
  closeForm()
  void load()
})

function goPage(p: number): void {
  page.value = Math.min(Math.max(1, p), totalPages.value)
  void load()
}

// --- create / edit form ------------------------------------------------------------------
const formOpen = ref(false)
const editing = ref<MasterRow | null>(null)
const form = reactive<Record<string, string>>({})
const formError = ref('')

function openForm(row: MasterRow | null): void {
  editing.value = row
  for (const f of props.entity.fields) form[f.key] = row && row[f.key] !== null && row[f.key] !== undefined ? String(row[f.key]) : ''
  formError.value = ''
  formOpen.value = true
}
function closeForm(): void {
  formOpen.value = false
  editing.value = null
}

const saveAction = useAsyncAction(async (): Promise<void> => {
  formError.value = ''
  const missing = props.entity.fields.find((f) => f.required && !String(form[f.key] || '').trim())
  if (missing) return void (formError.value = t('masterData.fieldRequired', { field: t(missing.label) }))
  const body = Object.fromEntries(props.entity.fields.map((f) => [f.key, String(form[f.key] || '').trim()]))
  try {
    if (editing.value) await updateRow(props.entity.key, editing.value.id, body)
    else await createRow(props.entity.key, body)
    message.value = editing.value ? t('masterData.updated') : t('masterData.created')
    closeForm()
    await Promise.all([load(), loadMeta()])
  } catch (err) {
    formError.value = apiErrorMessage(err, 'masterData.saveFailed')
  }
})

async function remove(row: MasterRow): Promise<void> {
  if (!window.confirm(t('masterData.confirmDelete', { name: props.entity.recordKey(row) }))) return
  message.value = ''
  error.value = ''
  try {
    await deleteRow(props.entity.key, row.id)
    message.value = t('masterData.deleted', { name: props.entity.recordKey(row) })
    if (rows.value.length === 1 && page.value > 1) page.value--
    await Promise.all([load(), loadMeta()])
  } catch (err) {
    error.value = apiErrorMessage(err, 'masterData.deleteFailed')
  }
}

// --- import ------------------------------------------------------------------------------
const importAction = useAsyncAction(async (file: File): Promise<void> => {
  message.value = ''
  error.value = ''
  try {
    const r = await importFile(props.entity.key, await fileToPayload(file))
    message.value = t('masterData.imported', {
      rows: formatNumber(r.rows),
      inserted: formatNumber(r.inserted),
      updated: formatNumber(r.updated),
      skipped: formatNumber(r.skipped.length),
    })
    page.value = 1
    await Promise.all([load(), loadMeta()])
  } catch (err) {
    error.value = apiErrorMessage(err, 'masterData.importFailed')
  }
})
function pickFile(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void importAction.run(file)
}

function cell(row: MasterRow, key: string): string {
  const v = row[key]
  return v === null || v === undefined ? '' : String(v)
}

onMounted(() => {
  void load()
  void loadMeta()
})
</script>

<template>
  <section class="card space-y-4 p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="section-title">{{ t(entity.title) }}</h2>
        <p class="mt-1 text-xs text-slate-500">{{ t(entity.hint) }}</p>
      </div>
      <div v-if="canManage" class="flex flex-wrap gap-2">
        <template v-if="canImport">
          <LoadingButton class="btn btn-secondary px-3 py-1.5 text-sm" :loading-text="t('masterData.importing')" :loading="importAction.pending" @click="fileInput?.click()">
            <Upload :size="15" /> {{ t('masterData.import') }}
          </LoadingButton>
          <input ref="fileInput" type="file" accept=".xlsx,.xls" class="hidden" @change="pickFile" />
        </template>
        <button type="button" class="btn btn-primary px-3 py-1.5 text-sm" @click="openForm(null)">
          <Plus :size="15" /> {{ t('masterData.add') }}
        </button>
      </div>
    </div>
    <p v-if="canManage && canImport && entity.importHint" class="text-xs text-slate-400">{{ t(entity.importHint) }}</p>
    <p v-else-if="!canManage" class="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">{{ t('masterData.readOnlyNotice') }}</p>

    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-[220px] flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
        <input v-model="searchInput" type="text" class="input py-2 pl-9" :placeholder="t('masterData.searchPlaceholder')" :aria-label="t('masterData.searchPlaceholder')" />
      </div>
      <select v-if="entity.filters.includes('wilayah')" v-model="wilayahFilter" class="input w-44 py-2" :aria-label="t('masterData.wilayah')">
        <option value="">{{ t('masterData.allWilayah') }}</option>
        <option v-for="w in wilayahOptions" :key="w" :value="w">{{ w }}</option>
      </select>
      <select v-if="entity.filters.includes('wilayahId')" v-model="wilayahIdFilter" class="input w-44 py-2" :aria-label="t('masterData.wilayah')">
        <option value="">{{ t('masterData.allWilayah') }}</option>
        <option v-for="w in masterWilayah" :key="w.id" :value="String(w.id)">{{ w.name }}</option>
      </select>
      <label v-if="entity.filters.includes('missingLabel')" class="flex items-center gap-2 text-xs text-slate-600">
        <input v-model="missingOnly" type="checkbox" class="rounded border-slate-300" /> {{ t('masterData.hubs.onlyMissing') }}
      </label>
      <span class="text-xs text-slate-500">{{ t('masterData.totalRecords', { count: formatNumber(total) }) }}</span>
    </div>

    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>
    <p v-if="message" class="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ message }}</p>

    <div class="overflow-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th v-for="c in entity.columns" :key="c.key" class="px-3 py-2">{{ t(c.label) }}</th>
            <th class="px-3 py-2">{{ t('masterData.updatedAt') }}</th>
            <th v-if="canManage" class="px-3 py-2 text-right">{{ t('masterData.actions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="row in rows" :key="row.id">
            <td v-for="c in entity.columns" :key="c.key" class="px-3 py-2" :class="c.mono ? 'font-mono text-xs text-slate-600' : 'text-slate-700'">
              <span v-if="cell(row, c.key)">{{ cell(row, c.key) }}</span>
              <span v-else-if="c.empty" class="text-xs italic text-amber-700">{{ t(c.empty) }}</span>
              <span v-else class="text-slate-300">{{ t('common.dash') }}</span>
            </td>
            <td class="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
              {{ row.updated_at ? formatDateTime(String(row.updated_at)) : t('common.dash') }}
              <span v-if="row.updated_by" class="block text-slate-400">{{ row.updated_by }}</span>
            </td>
            <td v-if="canManage" class="whitespace-nowrap px-3 py-2 text-right">
              <button type="button" class="rounded p-1.5 text-slate-400 hover:text-indigo-600" :aria-label="`${t('common.edit')} — ${entity.recordKey(row)}`" @click="openForm(row)">
                <Pencil :size="15" />
              </button>
              <LoadingButton
                class="rounded p-1.5 text-slate-400 hover:text-rose-600"
                :spinner-size="15"
                :loading="rowOps.isPending(row.id, 'delete')"
                :aria-label="`${t('common.delete')} — ${entity.recordKey(row)}`"
                @click="rowOps.run(row.id, 'delete', () => remove(row))"
              >
                <Trash2 :size="15" />
              </LoadingButton>
            </td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td :colspan="entity.columns.length + (canManage ? 2 : 1)" class="px-3 py-6 text-center text-sm text-slate-400">{{ t('masterData.empty') }}</td>
          </tr>
          <tr v-if="loading && !rows.length">
            <td :colspan="entity.columns.length + (canManage ? 2 : 1)" class="px-3 py-6 text-center text-sm text-slate-400">{{ t('common.loading') }}</td>
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

    <!-- Create / edit -->
    <div v-if="formOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="closeForm">
      <form class="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5 shadow-2xl" role="dialog" :aria-label="editing ? t('masterData.editTitle') : t('masterData.addTitle')" @submit.prevent="saveAction.run()">
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-slate-900">{{ editing ? t('masterData.editTitle') : t('masterData.addTitle') }} · {{ t(entity.title) }}</h3>
          <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" :aria-label="t('common.close')" @click="closeForm"><X :size="18" /></button>
        </div>
        <div v-for="f in entity.fields" :key="f.key">
          <label class="label" :for="`md-${f.key}`">{{ t(f.label) }}<span v-if="f.required" class="text-rose-500"> *</span></label>
          <template v-if="f.type === 'masterWilayah'">
            <select :id="`md-${f.key}`" v-model="form[f.key]" class="input" :required="f.required">
              <option value="" disabled>{{ t('masterData.chooseWilayah') }}</option>
              <option v-for="w in masterWilayah" :key="w.id" :value="String(w.id)">{{ w.name }}</option>
            </select>
          </template>
          <template v-else-if="f.type === 'wilayah' && !f.allowNew">
            <select :id="`md-${f.key}`" v-model="form[f.key]" class="input" :required="f.required">
              <option value="" :disabled="f.required">{{ f.required ? t('masterData.chooseWilayah') : t('common.dash') }}</option>
              <option v-for="w in wilayahOptions" :key="w" :value="w">{{ w }}</option>
            </select>
          </template>
          <template v-else>
            <input
              :id="`md-${f.key}`"
              v-model="form[f.key]"
              class="input"
              :maxlength="f.maxlength"
              :inputmode="f.inputmode || 'text'"
              :required="f.required"
              :list="f.type === 'wilayah' ? `md-${f.key}-list` : undefined"
              :placeholder="f.placeholder ? t(f.placeholder) : undefined"
            />
            <datalist v-if="f.type === 'wilayah'" :id="`md-${f.key}-list`">
              <option v-for="w in wilayahOptions" :key="w" :value="w" />
            </datalist>
          </template>
        </div>
        <p v-if="formError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ formError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-ghost" @click="closeForm">{{ t('common.cancel') }}</button>
          <LoadingButton type="submit" class="btn btn-primary" :loading-text="t('common.saving')" :loading="saveAction.pending">{{ t('common.save') }}</LoadingButton>
        </div>
      </form>
    </div>
  </section>
</template>
