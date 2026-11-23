<script setup lang="ts">
/**
 * Gerai / HUB → KOTA PENERIMA (+ NAMA PENGIRIM) — READ-ONLY view for the 3PL
 * Loader (loader.view). Hubs without a label make the Loader JNE sheet fall
 * back to Kota_Tujuan (reported on the result). Changes happen in Master
 * Data (master_data.manage); the link is shown only to users who may make them.
 */
import { computed, onMounted, ref } from 'vue'
import { Building2, Lock, Search, Settings2 } from 'lucide-vue-next'
import axios from 'axios'
import { authStore } from '../../stores/auth'
import { formatNumber, t } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'
import type { HubMapping } from '../../lib/loaderApi'

const hubs = ref<HubMapping[]>([])
const error = ref('')
const search = ref('')
const onlyMissing = ref(false)
const canManage = computed(() => authStore.can('master_data.manage'))

const labelled = computed(() => hubs.value.filter((h) => h.kota_penerima).length)
const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  return hubs.value.filter((h) => {
    if (onlyMissing.value && h.kota_penerima) return false
    if (!q) return true
    return [h.hub, h.city, h.analytic_code, h.kota_penerima].some((v) => String(v || '').toLowerCase().includes(q))
  })
})

async function load(): Promise<void> {
  error.value = ''
  try {
    hubs.value = (await axios.get('/api/loader/settings/hubs')).data.hubs
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.hubLoadFailed')
  }
}

onMounted(load)
</script>

<template>
  <section class="card space-y-3 p-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="section-title flex items-center gap-2"><Building2 :size="18" class="text-indigo-600" /> {{ t('loader.hubTitle') }}</h2>
      <router-link v-if="canManage" class="btn btn-secondary px-3 py-1.5 text-xs" :to="{ name: 'master-data-hubs' }">
        <Settings2 :size="14" /> {{ t('loader.manageInMasterData') }}
      </router-link>
    </div>
    <p class="text-xs text-slate-500">{{ t('loader.hubHint') }}</p>

    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-[200px] flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
        <input v-model="search" type="text" class="input py-2 pl-9" :placeholder="t('loader.hubSearch')" :aria-label="t('loader.hubSearch')" />
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-600">
        <input v-model="onlyMissing" type="checkbox" class="rounded border-slate-300" /> {{ t('loader.hubOnlyMissing') }}
      </label>
      <span class="text-xs text-slate-500">{{ t('loader.hubCount', { labelled: formatNumber(labelled), total: formatNumber(hubs.length) }) }}</span>
    </div>

    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

    <div class="max-h-[28rem] overflow-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-sm">
        <thead class="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th class="px-3 py-2">{{ t('loader.hubColHub') }}</th>
            <th class="px-3 py-2">{{ t('loader.hubColCode') }}</th>
            <th class="px-3 py-2">{{ t('loader.hubColKota') }}</th>
            <th class="px-3 py-2">{{ t('loader.hubColPengirim') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="h in visible" :key="h.id">
            <td class="px-3 py-2">
              <p class="font-medium text-slate-800">{{ h.hub }}</p>
              <p class="text-[11px] text-slate-400">{{ [h.city, h.hub_type].filter(Boolean).join(' · ') }}</p>
            </td>
            <td class="px-3 py-2 font-mono text-xs text-slate-500">{{ h.analytic_code || t('common.dash') }}</td>
            <td class="px-3 py-2">
              <span v-if="h.kota_penerima" class="text-slate-700">{{ h.kota_penerima }}</span>
              <span v-else class="text-xs italic text-amber-700">{{ t('loader.hubNoLabel') }}</span>
            </td>
            <td class="px-3 py-2 text-slate-700">{{ h.nama_pengirim || t('common.dash') }}</td>
          </tr>
          <tr v-if="!visible.length && !error">
            <td colspan="4" class="px-3 py-3 text-sm text-slate-400">{{ t('loader.hubEmpty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="flex items-start gap-1.5 text-xs text-slate-500"><Lock :size="13" class="mt-0.5 shrink-0" /> {{ t('loader.referenceReadOnly') }}</p>
  </section>
</template>
