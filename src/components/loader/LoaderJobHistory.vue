<script setup lang="ts">
/** Recent loader runs (table loader_jobs). Counts only — no phone numbers. */
import { computed, onMounted, ref } from 'vue'
import { Download, Eye, History, Loader2, RefreshCw } from 'lucide-vue-next'
import { authStore } from '../../stores/auth'
import { formatDateTime, formatNumber, t, type MessageKey } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'
import { listJobs, type DownloadInfo, type LoaderJob } from '../../lib/loaderApi'

const emit = defineEmits<{ (e: 'track', job: LoaderJob): void; (e: 'download', d: DownloadInfo): void }>()

const jobs = ref<LoaderJob[]>([])
const loading = ref(true)
const error = ref('')
const showAll = ref(false)
const canSeeAll = computed(() => authStore.can('loader.manage_settings'))

const statusChip: Record<string, string> = {
  running: 'bg-sky-100 text-sky-700',
  processing: 'bg-sky-100 text-sky-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-slate-200 text-slate-600',
  interrupted: 'bg-slate-200 text-slate-600',
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    jobs.value = await listJobs(showAll.value)
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.historyLoadFailed')
  } finally {
    loading.value = false
  }
}

function toggleAll(): void {
  showAll.value = !showAll.value
  void load()
}

onMounted(load)
</script>

<template>
  <section class="card space-y-3 p-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="section-title flex items-center gap-2"><History :size="18" class="text-indigo-600" /> {{ t('loader.historyTitle') }}</h2>
      <div class="flex items-center gap-2">
        <button v-if="canSeeAll" type="button" class="btn btn-ghost px-2.5 py-1 text-xs" @click="toggleAll">
          {{ showAll ? t('loader.historyMine') : t('loader.historyAll') }}
        </button>
        <button type="button" class="btn btn-ghost px-2.5 py-1 text-xs" :disabled="loading" :aria-label="t('common.refresh')" @click="load">
          <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
    </div>
    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>
    <div v-else-if="loading && !jobs.length" class="flex justify-center py-6 text-slate-400"><Loader2 :size="20" class="animate-spin" /></div>
    <p v-else-if="!jobs.length" class="py-4 text-sm text-slate-400">{{ t('loader.historyEmpty') }}</p>
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[640px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th class="px-2 py-2 font-semibold">{{ t('loader.historyWhen') }}</th>
            <th class="px-2 py-2 font-semibold">{{ t('loader.historyFile') }}</th>
            <th class="px-2 py-2 font-semibold">{{ t('loader.historyMode') }}</th>
            <th class="px-2 py-2 font-semibold">{{ t('loader.historyStatus') }}</th>
            <th class="px-2 py-2 font-semibold">{{ t('loader.historyResult') }}</th>
            <th class="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id" class="border-b border-slate-100 align-top last:border-0">
            <td class="whitespace-nowrap px-2 py-2 text-xs text-slate-500">
              {{ formatDateTime(j.startedAt) }}
              <span v-if="j.user && showAll" class="block text-slate-400">@{{ j.user }}</span>
            </td>
            <td class="max-w-[220px] truncate px-2 py-2 text-slate-700" :title="j.templateName">{{ j.templateName }}</td>
            <td class="px-2 py-2 text-xs text-slate-600">{{ j.mode === 'api' ? t('loader.modeApi') : t('loader.modeFile') }}</td>
            <td class="px-2 py-2"><span class="chip" :class="statusChip[j.status]">{{ t(`loader.jobStatus.${j.status}` as MessageKey) }}</span></td>
            <td class="px-2 py-2 text-xs text-slate-600">
              {{ t('loader.rowsCount', { count: formatNumber(j.totalRows) }) }}
              <span v-if="j.mode === 'api'" class="block text-slate-400">
                {{ t('loader.jobFound', { success: formatNumber(j.progress.success), failed: formatNumber(j.progress.failed) }) }}
              </span>
            </td>
            <td class="whitespace-nowrap px-2 py-2 text-right">
              <button
                v-if="j.mode === 'api' && ['running', 'processing', 'paused', 'done'].includes(j.status)"
                type="button"
                class="btn btn-ghost px-2 py-1 text-xs"
                @click="emit('track', j)"
              >
                <Eye :size="13" /> {{ t('loader.historyView') }}
              </button>
              <button v-if="j.download" type="button" class="btn btn-ghost px-2 py-1 text-xs" @click="emit('download', j.download)">
                <Download :size="13" /> {{ t('storage.download') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-xs text-slate-400">{{ t('loader.historyNote') }}</p>
  </section>
</template>
