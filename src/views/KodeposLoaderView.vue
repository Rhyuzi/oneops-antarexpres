<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  Info,
  KeyRound,
  Loader2,
  PauseCircle,
  Play,
  Square,
  Upload,
  Wand2,
} from 'lucide-vue-next'
import axios from 'axios'
import LoadingButton from '../components/LoadingButton.vue'
import LoaderJobHistory from '../components/loader/LoaderJobHistory.vue'
import KotaWilayahSettings from '../components/loader/KotaWilayahSettings.vue'
import { useAsyncAction } from '../composables/useAsyncAction'
import { authStore } from '../stores/auth'
import { formatBytes, formatDateTime, formatNumber, t, type MessageKey } from '../i18n'
import { apiErrorMessage, localizeMessage } from '../i18n/systemMessages'
import {
  cancelJob,
  downloadResult,
  fileToPayload,
  getJob,
  hasRecheckerToken,
  resumeJob,
  startApiJob,
  type DownloadInfo,
  type LoaderJob,
  type LoaderReport,
  type Precheck,
} from '../lib/loaderApi'

interface WilayahSummary { wilayah: string | null; count: number }

const MAX_BYTES = 10 * 1024 * 1024
const CUST_ID_RE = /^\d{1,15}$/ // CUST ID is exported as a number
const POLL_MS = 1500

const canRun = computed(() => authStore.can('loader.run'))
const canRecheck = computed(() => authStore.can('loader.recheck'))
const canManage = computed(() => authStore.can('loader.manage_reference'))
const canEditRechecker = computed(() => authStore.can('number_rechecking.run'))

// --- form ----------------------------------------------------------------------
type Mode = 'file' | 'api'
const mode = ref<Mode>('file')
const templateFile = ref<File | null>(null)
const recheckedFile = ref<File | null>(null)
const wilayah = ref('')

// Rule 4 switch: convert Berat from Berat Asli (default ON). Remembered per
// browser only as a convenience — the server default is ON as well.
const WEIGHT_PREF_KEY = 'oneops.loader.convertWeight'
function readWeightPref(): boolean {
  try {
    return localStorage.getItem(WEIGHT_PREF_KEY) !== 'off'
  } catch {
    return true
  }
}
const convertWeight = ref(readWeightPref())
watch(convertWeight, (on) => {
  try {
    localStorage.setItem(WEIGHT_PREF_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
})
const custIdNonCod = ref('')
const custIdCod = ref('')
const formError = ref<MessageKey | ''>('')
const serverError = ref('')
const tokenReady = ref(hasRecheckerToken())

const templateInput = ref<HTMLInputElement | null>(null)
const recheckedInput = ref<HTMLInputElement | null>(null)
const masterInput = ref<HTMLInputElement | null>(null)

function setMode(next: Mode): void {
  if (busy.value) return
  mode.value = next
  formError.value = ''
  serverError.value = ''
  precheckResult.value = null
  tokenReady.value = hasRecheckerToken()
}

function pickFile(target: 'template' | 'rechecked', e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return
  formError.value = ''
  precheckResult.value = null
  if (!/\.(xlsx|xls)$/i.test(file.name)) return void (formError.value = 'loader.fileType')
  if (file.size > MAX_BYTES) return void (formError.value = 'loader.fileTooLarge')
  if (target === 'template') templateFile.value = file
  else recheckedFile.value = file
}

function validate(): MessageKey | '' {
  if (!templateFile.value || (mode.value === 'file' && !recheckedFile.value)) {
    return mode.value === 'file' ? 'loader.filesRequired' : 'loader.templateRequired'
  }
  const cod = custIdCod.value.trim()
  const nonCod = custIdNonCod.value.trim()
  if (!cod || !nonCod) return 'loader.custIdRequired'
  if (!CUST_ID_RE.test(cod) || !CUST_ID_RE.test(nonCod)) return 'loader.custIdInvalid'
  if (cod === nonCod) return 'loader.custIdSame'
  if (mode.value === 'api' && !hasRecheckerToken()) return 'loader.tokenMissing'
  return ''
}

// --- results (both modes) ----------------------------------------------------------
const report = ref<LoaderReport | null>(null)
const download = ref<DownloadInfo | null>(null)
const downloadError = ref('')

const downloadAction = useAsyncAction(async (info?: DownloadInfo): Promise<void> => {
  const target = info || download.value
  if (!target) return
  downloadError.value = ''
  try {
    await downloadResult(target)
  } catch (err) {
    downloadError.value = apiErrorMessage(err, 'loader.downloadFailed')
  }
})

// --- file mode ---------------------------------------------------------------------
const processAction = useAsyncAction(async (): Promise<void> => {
  serverError.value = ''
  formError.value = validate()
  if (formError.value) return
  try {
    const [template, rechecked] = await Promise.all([fileToPayload(templateFile.value!), fileToPayload(recheckedFile.value!)])
    const resp = await axios.post('/api/loader/process', {
      template,
      rechecked,
      custIdCod: custIdCod.value.trim(),
      custIdNonCod: custIdNonCod.value.trim(),
      wilayah: wilayah.value || undefined,
      convertWeightFromActual: convertWeight.value,
    })
    report.value = resp.data.report
    download.value = resp.data.download
    historyKey.value++
    await downloadAction.run()
  } catch (err) {
    report.value = null
    download.value = null
    serverError.value = apiErrorMessage(err, 'loader.processFailed')
  }
})

// --- API mode: pre-check → job → poll ---------------------------------------------------
const precheckResult = ref<Precheck | null>(null)
const job = ref<LoaderJob | null>(null)
let pollTimer = 0

const jobActive = computed(() => job.value && (job.value.status === 'running' || job.value.status === 'processing'))
const busy = computed(() => processAction.pending || startAction.pending || Boolean(jobActive.value))
const jobPercent = computed(() => {
  const p = job.value?.progress
  return p && p.total ? Math.round((p.processed / p.total) * 100) : 0
})

function stopPolling(): void {
  window.clearTimeout(pollTimer)
  pollTimer = 0
}

async function poll(): Promise<void> {
  if (!job.value) return
  try {
    const next = await getJob(job.value.id)
    const finishedNow = job.value.status !== 'done' && next.status === 'done'
    job.value = next
    if (next.status === 'done' && next.report) {
      report.value = next.report
      download.value = next.download
      if (finishedNow) await downloadAction.run()
    }
    if (next.status === 'running' || next.status === 'processing') {
      pollTimer = window.setTimeout(poll, POLL_MS)
    } else {
      historyKey.value++
    }
  } catch (err) {
    serverError.value = apiErrorMessage(err, 'loader.jobLoadFailed')
    pollTimer = window.setTimeout(poll, POLL_MS * 2)
  }
}

/**
 * `justStarted`: the job was started/resumed by this click. A fast run can
 * already be done in the server's reply — no poll follows, so download here.
 */
async function trackJob(next: LoaderJob, justStarted = false): Promise<void> {
  stopPolling()
  job.value = next
  report.value = next.report ?? null
  download.value = next.download
  if (next.status === 'running' || next.status === 'processing') pollTimer = window.setTimeout(poll, POLL_MS)
  else if (justStarted && next.status === 'done' && next.download) await downloadAction.run()
}

/** Step 1 (and step 2 with acknowledge): pre-check runs server-side before any API call. */
const startAction = useAsyncAction(async (acknowledge: boolean): Promise<void> => {
  serverError.value = ''
  formError.value = validate()
  tokenReady.value = hasRecheckerToken()
  if (formError.value) return
  report.value = null
  download.value = null
  try {
    const started = await startApiJob({
      template: await fileToPayload(templateFile.value!),
      custIdCod: custIdCod.value.trim(),
      custIdNonCod: custIdNonCod.value.trim(),
      wilayah: wilayah.value || undefined,
      convertWeightFromActual: convertWeight.value,
      acknowledgeWarnings: acknowledge,
    })
    precheckResult.value = null
    historyKey.value++
    await trackJob(started, true)
  } catch (err) {
    const e = err as { response?: { status?: number; data?: { code?: string; precheck?: Precheck } } }
    const data = e.response?.data
    if (data?.precheck && (data.code === 'PRECHECK_WARNINGS' || data.code === 'PRECHECK_FAILED')) {
      precheckResult.value = data.precheck
      return
    }
    serverError.value = apiErrorMessage(err, 'loader.processFailed')
  }
})

const cancelAction = useAsyncAction(async (): Promise<void> => {
  if (!job.value) return
  try {
    await cancelJob(job.value.id)
    await poll()
  } catch (err) {
    serverError.value = apiErrorMessage(err, 'loader.processFailed')
  }
})

const resumeAction = useAsyncAction(async (): Promise<void> => {
  if (!job.value) return
  serverError.value = ''
  tokenReady.value = hasRecheckerToken()
  if (!tokenReady.value) return void (formError.value = 'loader.tokenMissing')
  try {
    await trackJob(await resumeJob(job.value.id), true)
  } catch (err) {
    serverError.value = apiErrorMessage(err, 'loader.processFailed')
  }
})

function precheckLabel(code: string): MessageKey {
  const map: Record<string, MessageKey> = {
    DUPLICATE_RESI: 'loader.pcDuplicateResi',
    EMPTY_RESI: 'loader.pcEmptyResi',
    KECAMATAN_MISSING: 'loader.warnKodeposMissing',
    KECAMATAN_AMBIGUOUS: 'loader.warnKodeposAmbiguous',
    UNKNOWN_COD: 'loader.warnUnknownCod',
    MISSING_COLUMNS: 'loader.pcMissingColumns',
    NO_ROWS: 'loader.pcNoRows',
  }
  return map[code] || 'loader.pcOther'
}

function precheckItem(item: Record<string, unknown>): string {
  if (item.resi !== undefined) return `${item.resi} ×${item.count}`
  if (item.kecamatan !== undefined) {
    const opts = Array.isArray(item.options) ? `: ${(item.options as string[]).join(', ')}` : ''
    return `${item.kecamatan}${opts} — ${t('loader.rowsCount', { count: Number(item.count) })}`
  }
  if (item.value !== undefined) return `${item.value} — ${t('loader.rowsCount', { count: Number(item.count) })}`
  return JSON.stringify(item)
}

const RECHECK_CODES: Record<string, MessageKey> = {
  not_found: 'loader.rcNotFound',
  invalid_phone: 'loader.rcInvalidPhone',
  upstream: 'loader.rcUpstream',
}

const warnings = computed(() => {
  const r = report.value
  if (!r) return []
  const list: Array<{ key: MessageKey; count: number; items: string[] }> = []
  const add = (key: MessageKey, items: string[]) => items.length && list.push({ key, count: items.length, items })
  if (r.recheck) add('loader.warnRecheckFailed', r.recheck.failures.map((f) => `${f.resi} — ${t(RECHECK_CODES[f.code] || 'loader.rcUpstream')}${f.message ? ` (${localizeMessage(f.message)})` : ''}`))
  add('loader.warnKodeposMissing', r.kodepos.missing.map((m) => `${m.kecamatan} — ${t('loader.rowsCount', { count: m.count })}`))
  add('loader.warnKodeposAmbiguous', r.kodepos.ambiguous.map((m) => `${m.kecamatan}: ${m.options.join(', ')}`))
  if (!r.recheck) add('loader.warnNotInRechecked', r.phone.notInRechecked)
  add('loader.warnPhoneInvalid', r.phone.invalid.map((p) => `${p.resi} — ${p.value || '∅'} (${p.issue === 'empty' ? t('loader.phoneEmpty') : t('loader.phoneInvalid')})`))
  add('loader.warnUnknownCod', r.unknownCod.map((u) => `${u.resi} — ${u.value || '∅'}`))
  add('loader.warnNegative', r.negativeNilaiBarang.map((u) => `${u.resi} — ${formatNumber(Number(u.value))}`))
  add('loader.warnInvalidNumbers', r.invalidNumbers.map((u) => `${u.resi} — ${u.field}`))
  add('loader.warnWeightInvalid', r.weight.invalid.map((u) => `${u.resi}`))
  return list
})

const statusChip: Record<string, string> = {
  running: 'bg-sky-100 text-sky-700',
  processing: 'bg-sky-100 text-sky-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-slate-200 text-slate-600',
  interrupted: 'bg-slate-200 text-slate-600',
}

// --- reference -----------------------------------------------------------------------
const summary = ref<{ total: number; wilayah: WilayahSummary[] } | null>(null)
const summaryError = ref('')
const importMessage = ref('')
const importError = ref('')
const foundCustIds = ref<Record<string, { N?: string; Y?: string }>>({})
const historyKey = ref(0)

async function loadSummary(): Promise<void> {
  summaryError.value = ''
  try {
    const resp = await axios.get('/api/loader/reference/summary')
    summary.value = { total: resp.data.total, wilayah: resp.data.wilayah }
  } catch (err) {
    summaryError.value = apiErrorMessage(err, 'loader.referenceLoadFailed')
  }
}

const importAction = useAsyncAction(async (file: File): Promise<void> => {
  importMessage.value = ''
  importError.value = ''
  try {
    const resp = await axios.post('/api/loader/reference/import', { file: await fileToPayload(file) })
    importMessage.value = t('loader.importDone', {
      rows: formatNumber(resp.data.rows),
      inserted: formatNumber(resp.data.inserted),
      total: formatNumber(resp.data.total),
    })
    foundCustIds.value = resp.data.custIds || {}
    await loadSummary()
  } catch (err) {
    importError.value = apiErrorMessage(err, 'loader.importFailed')
  }
})

function pickMaster(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!/\.(xlsx|xls)$/i.test(file.name)) return void (importError.value = t('loader.fileType'))
  if (file.size > MAX_BYTES) return void (importError.value = t('loader.fileTooLarge'))
  void importAction.run(file)
}

function useCustIds(w: string, ids: { N?: string; Y?: string }): void {
  if (ids.N) custIdNonCod.value = ids.N
  if (ids.Y) custIdCod.value = ids.Y
  wilayah.value = w
}

function refreshTokenState(): void {
  tokenReady.value = hasRecheckerToken()
}

onMounted(() => {
  void loadSummary()
  window.addEventListener('focus', refreshTokenState)
})
onUnmounted(() => {
  stopPolling()
  window.removeEventListener('focus', refreshTokenState)
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="flex items-center gap-2 text-xl font-bold text-slate-900">
        <Wand2 :size="22" class="text-indigo-600" /> {{ t('loader.title') }}
      </h1>
      <p class="mt-1 text-sm text-slate-500">{{ t('loader.subtitle') }}</p>
    </div>

    <div class="grid gap-6 xl:grid-cols-3">
      <!-- Process -->
      <section class="card space-y-5 p-5 xl:col-span-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="section-title">{{ t('loader.processCard') }}</h2>
          <!-- Phone source mode -->
          <div class="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" :aria-label="t('loader.modeLabel')">
            <button
              v-for="m in (['file', 'api'] as const)"
              :key="m"
              type="button"
              class="rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
              :class="mode === m ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
              :aria-pressed="mode === m"
              :disabled="busy || (m === 'api' && !canRecheck)"
              :title="m === 'api' && !canRecheck ? t('loader.noRecheckPermission') : undefined"
              @click="setMode(m)"
            >
              {{ m === 'file' ? t('loader.modeFile') : t('loader.modeApi') }}
            </button>
          </div>
        </div>
        <p class="-mt-2 text-xs text-slate-400">{{ mode === 'file' ? t('loader.modeFileHint') : t('loader.modeApiHint') }}</p>

        <div class="grid gap-4" :class="mode === 'file' ? 'md:grid-cols-2' : ''">
          <div v-for="slot in (mode === 'file' ? ['template', 'rechecked'] as const : ['template'] as const)" :key="slot">
            <p class="label">{{ slot === 'template' ? t('loader.templateFile') : t('loader.recheckedFile') }}</p>
            <div class="flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
              <FileSpreadsheet :size="22" class="shrink-0 text-emerald-600" />
              <div class="min-w-0 flex-1">
                <template v-if="(slot === 'template' ? templateFile : recheckedFile)">
                  <p class="truncate text-sm font-medium text-slate-800">{{ (slot === 'template' ? templateFile : recheckedFile)!.name }}</p>
                  <p class="text-xs text-slate-400">{{ formatBytes((slot === 'template' ? templateFile : recheckedFile)!.size) }}</p>
                </template>
                <p v-else class="text-sm text-slate-400">{{ t('loader.noFile') }}</p>
              </div>
              <button
                type="button"
                class="btn btn-secondary shrink-0 px-3 py-1.5 text-xs"
                :disabled="busy"
                @click="(slot === 'template' ? templateInput : recheckedInput)?.click()"
              >
                {{ (slot === 'template' ? templateFile : recheckedFile) ? t('loader.changeFile') : t('loader.chooseFile') }}
              </button>
            </div>
            <p class="mt-1 text-xs text-slate-400">{{ slot === 'template' ? t('loader.templateHint') : t('loader.recheckedHint') }}</p>
          </div>
        </div>
        <input ref="templateInput" type="file" accept=".xlsx,.xls" class="hidden" @change="pickFile('template', $event)" />
        <input ref="recheckedInput" type="file" accept=".xlsx,.xls" class="hidden" @change="pickFile('rechecked', $event)" />

        <!-- API mode: rechecker token status (existing token system) -->
        <div
          v-if="mode === 'api'"
          class="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 text-sm"
          :class="tokenReady ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'"
        >
          <KeyRound :size="16" class="shrink-0" />
          <span class="flex-1">{{ tokenReady ? t('loader.tokenReady') : t('loader.tokenMissing') }}</span>
          <router-link v-if="canEditRechecker" class="btn btn-secondary px-3 py-1 text-xs" to="/ops/number-rechecking/settings">
            {{ t('loader.openTokenSettings') }}
          </router-link>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <div>
            <label class="label" for="cust-noncod">{{ t('loader.custIdNonCod') }}</label>
            <input id="cust-noncod" v-model="custIdNonCod" class="input" inputmode="numeric" maxlength="15" autocomplete="off" required :disabled="busy" />
          </div>
          <div>
            <label class="label" for="cust-cod">{{ t('loader.custIdCod') }}</label>
            <input id="cust-cod" v-model="custIdCod" class="input" inputmode="numeric" maxlength="15" autocomplete="off" required :disabled="busy" />
          </div>
          <div>
            <label class="label" for="loader-wilayah">{{ t('loader.wilayah') }}</label>
            <select id="loader-wilayah" v-model="wilayah" class="input" :disabled="busy">
              <option value="">{{ t('loader.wilayahAuto') }}</option>
              <option v-for="w in summary?.wilayah || []" :key="w.wilayah || ''" :value="w.wilayah || ''">{{ w.wilayah }}</option>
            </select>
          </div>
        </div>
        <p class="-mt-2 text-xs text-slate-400">{{ t('loader.custIdHint') }} {{ t('loader.wilayahHint') }}</p>

        <!-- Rule 4 switch: Berat from Berat Asli -->
        <div class="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
          <button
            id="convert-weight"
            type="button"
            role="switch"
            class="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50"
            :class="convertWeight ? 'bg-indigo-600' : 'bg-slate-300'"
            :aria-checked="convertWeight"
            :disabled="busy"
            @click="convertWeight = !convertWeight"
          >
            <span class="inline-block h-4 w-4 rounded-full bg-white shadow transition" :class="convertWeight ? 'translate-x-4' : 'translate-x-0.5'"></span>
          </button>
          <label for="convert-weight" class="cursor-pointer text-sm">
            <span class="font-medium text-slate-700">{{ t('loader.convertWeight') }}</span>
            <span class="block text-xs text-slate-400">{{ convertWeight ? t('loader.convertWeightOnHint') : t('loader.convertWeightOffHint') }}</span>
          </label>
        </div>

        <p v-if="formError || serverError" class="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle :size="16" class="mt-0.5 shrink-0" /> {{ formError ? t(formError) : serverError }}
        </p>

        <!-- Pre-check result (API mode) -->
        <div v-if="precheckResult" class="space-y-2 rounded-xl border p-3" :class="precheckResult.ok ? 'border-amber-200 bg-amber-50/60' : 'border-rose-200 bg-rose-50'">
          <p class="text-sm font-semibold" :class="precheckResult.ok ? 'text-amber-800' : 'text-rose-700'">
            {{ precheckResult.ok ? t('loader.pcWarningsTitle') : t('loader.pcErrorsTitle') }}
          </p>
          <p v-for="e in precheckResult.errors" :key="e.code" class="text-sm text-rose-700">
            {{ t(precheckLabel(e.code), { count: formatNumber(e.columns?.length || 0) }) }}<span v-if="e.columns">: {{ e.columns.join(', ') }}</span>
          </p>
          <details v-for="w in precheckResult.warnings" :key="w.code" class="rounded-lg bg-white/70 px-3 py-2">
            <summary class="cursor-pointer text-sm font-medium text-amber-800">{{ t(precheckLabel(w.code), { count: formatNumber(w.count) }) }}</summary>
            <ul class="mt-2 max-h-40 space-y-0.5 overflow-auto font-mono text-xs text-slate-700">
              <li v-for="(item, i) in w.items" :key="i">{{ precheckItem(item) }}</li>
            </ul>
          </details>
          <p v-if="precheckResult.ok" class="text-xs text-slate-600">
            {{ t('loader.pcCounts', { rows: formatNumber(precheckResult.counts.rows), awb: formatNumber(precheckResult.counts.uniqueResi) }) }}
          </p>
          <div v-if="precheckResult.ok" class="flex gap-2">
            <LoadingButton class="btn btn-primary px-3 py-1.5 text-xs" :loading-text="t('loader.starting')" :loading="startAction.pending" @click="startAction.run(true)">
              <Play :size="14" /> {{ t('loader.pcContinue') }}
            </LoadingButton>
            <button type="button" class="btn btn-ghost px-3 py-1.5 text-xs" :disabled="startAction.pending" @click="precheckResult = null">{{ t('common.cancel') }}</button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <LoadingButton
            v-if="mode === 'file'"
            class="btn btn-primary"
            :loading-text="t('loader.processing')"
            :loading="processAction.pending"
            :disabled="!canRun || busy"
            @click="processAction.run()"
          >
            <Wand2 :size="16" /> {{ t('loader.process') }}
          </LoadingButton>
          <LoadingButton
            v-else
            class="btn btn-primary"
            :loading-text="t('loader.prechecking')"
            :loading="startAction.pending"
            :disabled="!canRun || !canRecheck || busy || Boolean(precheckResult)"
            @click="startAction.run(false)"
          >
            <Wand2 :size="16" /> {{ t('loader.startApi') }}
          </LoadingButton>
          <LoadingButton
            v-if="download"
            class="btn btn-secondary"
            :loading-text="t('loader.downloading')"
            :loading="downloadAction.pending"
            :disabled="busy"
            @click="downloadAction.run()"
          >
            <Download :size="16" /> {{ t('loader.downloadAgain') }}
          </LoadingButton>
        </div>
        <p v-if="download && !downloadError" class="text-xs text-slate-500">
          {{ t('loader.downloadedAs', { name: download.filename, time: formatDateTime(download.expiresAt) }) }}
        </p>
        <p v-if="downloadError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ downloadError }}</p>

        <!-- API job progress -->
        <div v-if="job && mode === 'api'" class="space-y-3 rounded-xl border border-slate-200 p-4" aria-live="polite">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-semibold text-slate-800">{{ t('loader.jobTitle') }}</p>
            <span class="chip" :class="statusChip[job.status]">{{ t(`loader.jobStatus.${job.status}` as MessageKey) }}</span>
          </div>
          <div>
            <div class="mb-1 flex justify-between text-xs text-slate-500">
              <span>{{ t('loader.jobProgress', { done: formatNumber(job.progress.processed), total: formatNumber(job.progress.total) }) }}</span>
              <span>{{ t('loader.jobFound', { success: formatNumber(job.progress.success), failed: formatNumber(job.progress.failed) }) }}</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full bg-indigo-500 transition-all" :style="{ width: `${job.status === 'done' ? 100 : jobPercent}%` }" />
            </div>
          </div>
          <p v-if="job.status === 'processing'" class="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 :size="14" class="animate-spin" /> {{ t('loader.jobBuilding') }}
          </p>
          <div v-if="job.status === 'paused'" class="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p class="flex items-start gap-2"><PauseCircle :size="16" class="mt-0.5 shrink-0" /> {{ t('loader.jobPaused') }}</p>
            <p v-if="job.error" class="text-xs">{{ localizeMessage(job.error.message) }}</p>
          </div>
          <p v-if="job.status === 'failed' && job.error" class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ localizeMessage(job.error.message) }}</p>
          <div class="flex flex-wrap gap-2">
            <LoadingButton
              v-if="job.status === 'paused'"
              class="btn btn-primary px-3 py-1.5 text-xs"
              :loading-text="t('loader.resuming')"
              :loading="resumeAction.pending"
              @click="resumeAction.run()"
            >
              <Play :size="14" /> {{ t('loader.resume') }}
            </LoadingButton>
            <LoadingButton
              v-if="job.status === 'running' || job.status === 'paused'"
              class="btn btn-secondary px-3 py-1.5 text-xs"
              :loading-text="t('loader.cancelling')"
              :loading="cancelAction.pending"
              @click="cancelAction.run()"
            >
              <Square :size="14" /> {{ t('loader.cancelJob') }}
            </LoadingButton>
          </div>
        </div>
      </section>

      <!-- Reference -->
      <section class="card space-y-4 p-5">
        <h2 class="section-title flex items-center gap-2"><Database :size="18" class="text-indigo-600" /> {{ t('loader.referenceCard') }}</h2>
        <p v-if="summaryError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ summaryError }}</p>
        <template v-else-if="summary">
          <p v-if="!summary.total" class="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{{ t('loader.referenceEmpty') }}</p>
          <template v-else>
            <p class="text-sm font-medium text-slate-700">{{ t('loader.referenceTotal', { count: formatNumber(summary.total) }) }}</p>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="w in summary.wilayah" :key="w.wilayah || ''" class="chip bg-slate-100 text-slate-600">
                {{ w.wilayah || '—' }} · {{ formatNumber(w.count) }}
              </span>
            </div>
          </template>
        </template>
        <div v-else class="flex justify-center py-4 text-slate-400"><Loader2 :size="20" class="animate-spin" /></div>

        <template v-if="canManage">
          <LoadingButton
            class="btn btn-secondary w-full"
            :loading-text="t('loader.importing')"
            :loading="importAction.pending"
            @click="masterInput?.click()"
          >
            <Upload :size="16" /> {{ t('loader.importMaster') }}
          </LoadingButton>
          <input ref="masterInput" type="file" accept=".xlsx,.xls" class="hidden" @change="pickMaster" />
          <p class="text-xs text-slate-400">{{ t('loader.importHint') }}</p>
          <p v-if="importMessage" class="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <CheckCircle2 :size="16" class="mt-0.5 shrink-0" /> {{ importMessage }}
          </p>
          <p v-if="importError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ importError }}</p>
          <div v-if="Object.keys(foundCustIds).length" class="rounded-xl border border-slate-200 p-3">
            <p class="mb-2 text-xs font-semibold text-slate-500">{{ t('loader.custIdsFound') }}</p>
            <div v-for="(ids, w) in foundCustIds" :key="w" class="flex items-center justify-between gap-2 py-1 text-xs">
              <span class="font-medium text-slate-700">{{ w }}</span>
              <span class="font-mono text-slate-500">{{ `N ${ids.N || '—'} · Y ${ids.Y || '—'}` }}</span>
              <button type="button" class="btn btn-ghost px-2 py-1 text-xs" @click="useCustIds(String(w), ids)">{{ t('loader.useCustIds') }}</button>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- Result -->
    <section v-if="report" class="card space-y-5 p-5">
      <h2 class="section-title">{{ t('loader.resultTitle') }}</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <div v-for="stat in [
          { label: t('loader.statRows'), value: report.rows },
          { label: t('loader.statCod'), value: report.cod },
          { label: t('loader.statNonCod'), value: report.nonCod },
          { label: t('loader.statWeight'), value: report.weight.conversion === false ? t('loader.convertWeightOff') : report.weight.normalized },
          { label: t('loader.statKodepos'), value: `${formatNumber(report.kodepos.filled)} / ${formatNumber(report.rows)}` },
          { label: report.recheck ? t('loader.statPhonesApi') : t('loader.statPhones'), value: `${formatNumber(report.phone.fromRechecked)} / ${formatNumber(report.rows)}` },
        ]" :key="stat.label" class="rounded-xl border border-slate-200 p-3">
          <p class="text-lg font-bold text-slate-900">{{ typeof stat.value === 'number' ? formatNumber(stat.value) : stat.value }}</p>
          <p class="text-xs text-slate-500">{{ stat.label }}</p>
        </div>
      </div>

      <div class="space-y-1 text-xs text-slate-500">
        <p v-if="report.weight.conversion === false" class="flex items-center gap-1.5"><Info :size="13" /> {{ t('loader.convertWeightOffNote') }}</p>
        <p v-if="report.weight.guardSkipped" class="flex items-center gap-1.5"><Info :size="13" /> {{ t('loader.guardNote', { count: formatNumber(report.weight.guardSkipped) }) }}</p>
        <p v-if="report.nilaiBarangDefaulted" class="flex items-center gap-1.5"><Info :size="13" /> {{ t('loader.defaultedNote', { count: formatNumber(report.nilaiBarangDefaulted) }) }}</p>
        <p class="flex items-start gap-1.5"><Info :size="13" class="mt-0.5 shrink-0" /> {{ t('loader.columnsNote', { columns: report.columns.join(' · ') }) }}</p>
      </div>

      <p v-if="!warnings.length" class="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <CheckCircle2 :size="16" /> {{ t('loader.noWarnings') }}
      </p>
      <div v-else class="space-y-2">
        <p class="text-sm font-semibold text-amber-700">{{ t('loader.warningsTitle') }}</p>
        <details v-for="w in warnings" :key="w.key" class="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
          <summary class="cursor-pointer text-sm font-medium text-amber-800">{{ t(w.key, { count: formatNumber(w.count) }) }}</summary>
          <ul class="mt-2 max-h-56 space-y-0.5 overflow-auto font-mono text-xs text-slate-700">
            <li v-for="(item, i) in w.items" :key="i">{{ item }}</li>
          </ul>
        </details>
      </div>
    </section>

    <div class="grid gap-6 xl:grid-cols-3">
      <LoaderJobHistory :key="historyKey" class="xl:col-span-2" @track="(j) => { setMode(j.mode); trackJob(j) }" @download="(d) => downloadAction.run(d)" />
      <KotaWilayahSettings />
    </div>
  </div>
</template>
