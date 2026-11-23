<script setup lang="ts">
/**
 * Kota_Tujuan → wilayah mapping — READ-ONLY view for the 3PL Loader
 * (loader.view). Changes happen in Master Data (master_data.manage); the
 * link is shown only to users who may make them.
 */
import { computed, onMounted, ref } from 'vue'
import { Lock, MapPinned, Settings2 } from 'lucide-vue-next'
import axios from 'axios'
import { authStore } from '../../stores/auth'
import { t } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'

interface Mapping { id: number; kota: string; wilayah: string; source: string; updated_by: string | null }

const mappings = ref<Mapping[]>([])
const error = ref('')
const canManage = computed(() => authStore.can('master_data.manage'))

async function load(): Promise<void> {
  error.value = ''
  try {
    mappings.value = (await axios.get('/api/loader/settings/kota-wilayah')).data.mappings
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.settingsLoadFailed')
  }
}

onMounted(load)
</script>

<template>
  <section class="card space-y-3 p-5">
    <h2 class="section-title flex items-center gap-2"><MapPinned :size="18" class="text-indigo-600" /> {{ t('loader.settingsTitle') }}</h2>
    <p class="text-xs text-slate-500">{{ t('loader.settingsHint') }}</p>

    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

    <ul class="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200">
      <li v-for="m in mappings" :key="m.id" class="flex items-center gap-2 px-3 py-2 text-sm">
        <span class="min-w-0 flex-1 truncate text-slate-700">{{ m.kota }}</span>
        <span class="chip bg-slate-100 text-slate-600">{{ m.wilayah }}</span>
        <span class="text-[11px] text-slate-400">{{ m.source === 'seed' ? t('loader.mappingSeed') : t('loader.mappingManual') }}</span>
      </li>
      <li v-if="!mappings.length && !error" class="px-3 py-3 text-sm text-slate-400">{{ t('loader.mappingEmpty') }}</li>
    </ul>

    <p class="flex items-start gap-1.5 text-xs text-slate-500"><Lock :size="13" class="mt-0.5 shrink-0" /> {{ t('loader.referenceReadOnly') }}</p>
    <router-link v-if="canManage" class="btn btn-secondary w-full" :to="{ name: 'master-data-kota-wilayah' }">
      <Settings2 :size="16" /> {{ t('loader.manageInMasterData') }}
    </router-link>
  </section>
</template>
