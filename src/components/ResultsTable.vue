<script setup lang="ts">
import { CheckCircle2, Clock, Loader2, SkipForward, XCircle } from 'lucide-vue-next'
import type { RecordStatus, TrackingRecord } from '../types'
import { t, type MessageKey } from '../i18n'
import { localizeMessage } from '../i18n/systemMessages'

defineProps<{ records: TrackingRecord[] }>()

interface StatusMeta {
  label: MessageKey
  chip: string
  icon: typeof Clock
}

const statusMeta: Record<RecordStatus, StatusMeta> = {
  pending: { label: 'rechecker.status.pending', chip: 'bg-slate-100 text-slate-600', icon: Clock },
  processing: { label: 'rechecker.status.processing', chip: 'bg-sky-100 text-sky-700', icon: Loader2 },
  success: { label: 'rechecker.status.success', chip: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  failed: { label: 'rechecker.status.failed', chip: 'bg-rose-100 text-rose-700', icon: XCircle },
  skipped: { label: 'rechecker.status.skipped', chip: 'bg-amber-100 text-amber-700', icon: SkipForward },
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full min-w-[720px] text-left text-sm">
      <thead>
        <tr class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colAwb') }}</th>
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colRecipient') }}</th>
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colOriginalPhone') }}</th>
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colRetrievedPhone') }}</th>
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colStatus') }}</th>
          <th class="px-3 py-3 font-semibold">{{ t('rechecker.colError') }}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        <tr v-for="r in records" :key="r.id" class="hover:bg-slate-50">
          <td class="px-3 py-2.5 font-mono text-xs text-slate-700">{{ r.awb }}</td>
          <td class="px-3 py-2.5 text-slate-700">{{ r.recipient || '—' }}</td>
          <td class="px-3 py-2.5 font-mono text-xs text-slate-500">{{ r.originalPhone || '—' }}</td>
          <td class="px-3 py-2.5 font-mono text-xs">
            <span v-if="r.status === 'success'" class="font-semibold text-emerald-700">
              {{ r.retrievedPhone }}
            </span>
            <span v-else class="text-slate-400">—</span>
          </td>
          <td class="px-3 py-2.5">
            <span class="chip" :class="statusMeta[r.status].chip">
              <component
                :is="statusMeta[r.status].icon"
                :size="13"
                :class="{ 'animate-spin': r.status === 'processing' }"
              />
              {{ t(statusMeta[r.status].label) }}
            </span>
          </td>
          <td class="px-3 py-2.5 text-xs text-rose-600">{{ r.error ? localizeMessage(r.error) : '—' }}</td>
        </tr>
        <tr v-if="!records.length">
          <td colspan="6" class="px-3 py-10 text-center text-sm text-slate-400">
            {{ t('rechecker.noMatches') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
