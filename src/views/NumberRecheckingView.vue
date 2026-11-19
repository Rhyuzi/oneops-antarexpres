<script setup lang="ts">
import { computed, ref } from 'vue'
import { store } from '../store'
import StatCard from '../components/StatCard.vue'
import UploadZone from '../components/UploadZone.vue'
import ResultsTable from '../components/ResultsTable.vue'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  Inbox,
  Pause,
  Play,
  Search,
  Settings,
  Settings2,
  SkipForward,
  Square,
  XCircle,
} from 'lucide-vue-next'
import type { RecordStatus } from '../types'
import LoadingButton from '../components/LoadingButton.vue'
import { nextFrame, useAsyncAction } from '../composables/useAsyncAction'

const search = ref('')
const statusFilter = ref<RecordStatus | 'all'>('all')
const uploadError = ref('')

// One Excel import at a time (a second pick/drop while parsing is ignored).
const importAction = useAsyncAction(async (file: File): Promise<void> => {
  uploadError.value = ''
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    uploadError.value = 'Unsupported file type. Please upload an .xlsx or .xls file.'
    return
  }
  try {
    await store.uploadFile(file)
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : 'Failed to parse the Excel file.'
  }
})

// Writing the workbook is synchronous CPU work: yield a frame first so the
// spinner paints, and one after so clicks queued while the main thread was
// busy hit the still-disabled button instead of starting a second export.
const exportAction = useAsyncAction(async (): Promise<void> => {
  await nextFrame()
  store.downloadResult()
  await nextFrame()
})

const stats = computed(() => {
  const rs = store.state.records
  return {
    total: rs.length,
    success: rs.filter((r) => r.status === 'success').length,
    failed: rs.filter((r) => r.status === 'failed').length,
    pending: rs.filter((r) => r.status === 'pending' || r.status === 'processing').length,
    skipped: rs.filter((r) => r.status === 'skipped').length,
  }
})

const processed = computed(() => stats.value.total - stats.value.pending)
const percent = computed(() =>
  stats.value.total ? Math.round((processed.value / stats.value.total) * 100) : 0
)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return store.state.records.filter((r) => {
    if (statusFilter.value !== 'all' && r.status !== statusFilter.value) return false
    if (!q) return true
    return r.awb.toLowerCase().includes(q) || r.recipient.toLowerCase().includes(q)
  })
})

const hasCredentials = computed(() => store.hasCredentials())
const canStart = computed(
  () => store.state.records.length > 0 && hasCredentials.value && !store.state.running
)

const statusOptions: Array<{ value: RecordStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
]
</script>

<template>
  <div class="space-y-6">
    <!-- Page header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">Number Rechecking</h1>
        <p class="text-sm text-slate-500">
          Recheck recipient phone numbers from SiCepat AWB data
          <span v-if="hasCredentials" class="ml-1 font-medium text-emerald-600">· credentials configured</span>
        </p>
      </div>
      <router-link class="btn btn-secondary" to="/ops/number-rechecking/settings">
        <Settings :size="16" /> Settings
      </router-link>
    </div>

    <!-- Statistics -->
    <section class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      <StatCard label="Total AWB" :value="stats.total" :icon="FileSpreadsheet" tone="info" />
      <StatCard
        label="Successfully Rechecked"
        :value="stats.success"
        :icon="CheckCircle2"
        tone="success"
      />
      <StatCard label="Failed" :value="stats.failed" :icon="XCircle" tone="error" />
      <StatCard label="Pending" :value="stats.pending" :icon="Clock" tone="warning" />
      <StatCard label="Skipped" :value="stats.skipped" :icon="SkipForward" tone="default" />
    </section>

    <!-- Missing credentials notice -->
    <div
      v-if="!hasCredentials"
      class="flex items-center justify-between gap-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4"
    >
      <div class="flex items-center gap-3 text-sm text-indigo-800">
        <Settings2 :size="20" />
        <span>Configure your Bearer Token, X-Permission-Token and User ID before processing.</span>
      </div>
      <router-link class="btn btn-secondary shrink-0" to="/ops/number-rechecking/settings">
        Open Settings
      </router-link>
    </div>

    <!-- Upload -->
    <section class="card p-5">
      <h2 class="section-title">Upload</h2>
      <UploadZone :busy="importAction.pending" @select="importAction.run" />
      <p v-if="uploadError" class="mt-3 text-sm text-rose-600">{{ uploadError }}</p>
      <div
        v-if="store.state.fileName"
        class="mt-4 flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-3 text-sm"
      >
        <FileSpreadsheet :size="18" class="text-indigo-600" />
        <span class="font-medium text-slate-700">{{ store.state.fileName }}</span>
        <span class="text-slate-400">·</span>
        <span class="text-slate-500">{{ stats.total }} records detected</span>
      </div>
    </section>

    <!-- Processing -->
    <section class="card p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="section-title">Processing</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button v-if="!store.state.running" class="btn btn-primary" :disabled="!canStart" @click="store.startProcessing()">
            <Play :size="18" /> Start Processing
          </button>
          <template v-else>
            <button class="btn btn-secondary" :disabled="store.state.stopRequested" @click="store.togglePause()">
              <Pause v-if="!store.state.paused" :size="18" />
              <Play v-else :size="18" />
              {{ store.state.paused ? 'Resume' : 'Pause' }}
            </button>
            <!-- Stop is a request; workers finish their in-flight lookups first. -->
            <LoadingButton
              class="btn btn-danger"
              loading-text="Stopping…"
              :spinner-size="18"
              :loading="store.state.stopRequested"
              @click="store.stopProcessing()"
            >
              <Square :size="18" /> Stop
            </LoadingButton>
          </template>
        </div>
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="label" for="delay-ms">Delay between requests (ms)</label>
          <input
            id="delay-ms"
            v-model.number="store.state.config.delayMs"
            type="number"
            min="0"
            max="60000"
            step="50"
            class="input"
          />
        </div>
        <div>
          <label class="label" for="concurrency">Concurrency</label>
          <select
            id="concurrency"
            v-model.number="store.state.config.concurrency"
            class="input"
          >
            <option :value="1">1 request at a time (default)</option>
            <option :value="2">2 concurrent</option>
            <option :value="3">3 concurrent</option>
          </select>
        </div>
      </div>

      <div v-if="store.state.authError" class="mt-4 flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3.5">
        <AlertTriangle class="mt-0.5 shrink-0 text-rose-600" :size="18" />
        <p class="text-sm text-rose-700">{{ store.state.authError }}</p>
      </div>

      <div v-if="store.state.records.length" class="mt-5">
        <div class="mb-1.5 flex items-center justify-between text-sm">
          <span class="font-medium text-slate-600">
            {{ processed }} / {{ stats.total }} processed
          </span>
          <span class="font-semibold text-slate-900">{{ percent }}%</span>
        </div>
        <div class="h-2.5 overflow-hidden rounded-full bg-slate-100">
          <div
            class="h-full rounded-full bg-indigo-500 transition-all duration-300"
            :style="{ width: percent + '%' }"
          ></div>
        </div>
        <p v-if="store.state.running && store.state.currentAwb" class="mt-2 text-xs text-slate-500">
          Current AWB: <span class="font-mono font-semibold text-slate-700">{{ store.state.currentAwb }}</span>
        </p>
      </div>
    </section>

    <!-- Results -->
    <section class="card p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="section-title">Results</h2>
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="16" />
            <input
              v-model="search"
              type="text"
              class="input w-56 pl-9"
              placeholder="Search AWB or recipient"
            />
          </div>
          <select v-model="statusFilter" class="input w-44">
            <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <LoadingButton
            class="btn btn-primary"
            loading-text="Exporting…"
            :spinner-size="18"
            :loading="exportAction.pending"
            :disabled="stats.success === 0"
            @click="exportAction.run()"
          >
            <Download :size="18" /> Download Excel
          </LoadingButton>
        </div>
      </div>

      <div v-if="!store.state.records.length" class="mt-6 flex flex-col items-center justify-center py-14 text-center">
        <Inbox :size="40" class="text-slate-300" />
        <p class="mt-3 text-sm text-slate-500">Upload an Excel file to see the results here.</p>
      </div>
      <div v-else class="mt-4">
        <ResultsTable :records="filtered" />
      </div>
    </section>
  </div>
</template>
