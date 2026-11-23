<script setup lang="ts">
/**
 * Master Data — the only place where the 3PL Loader reference data changes:
 * gerai/HUB → KOTA PENERIMA, Kota_Tujuan → wilayah, kodepos reference, plus
 * the Master Data audit trail. One route per tab (sidebar items); the tab
 * comes from route.meta.tab.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Building2, Database, History, MapPinned } from 'lucide-vue-next'
import MasterDataTable from '../components/masterData/MasterDataTable.vue'
import MasterDataAudit from '../components/masterData/MasterDataAudit.vue'
import { authStore } from '../stores/auth'
import { t, type MessageKey } from '../i18n'
import { ENTITIES, type EntityKey } from '../lib/masterData'

const route = useRoute()
const tab = computed(() => String(route.meta.tab || 'hubs'))
const entity = computed(() => (tab.value in ENTITIES ? ENTITIES[tab.value as EntityKey] : null))

const tabs = computed(() => {
  const list: Array<{ name: string; tab: string; label: MessageKey; icon: unknown }> = [
    { name: 'master-data-hubs', tab: 'hubs', label: 'nav.mdHubs', icon: Building2 },
    { name: 'master-data-kota-wilayah', tab: 'kota-wilayah', label: 'nav.mdKotaWilayah', icon: MapPinned },
    { name: 'master-data-kodepos', tab: 'kodepos', label: 'nav.mdKodepos', icon: Database },
  ]
  if (authStore.can('master_data.audit')) list.push({ name: 'master-data-audit', tab: 'audit', label: 'nav.mdAudit', icon: History })
  return list
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-bold text-slate-900">{{ t('masterData.title') }}</h1>
      <p class="text-sm text-slate-500">{{ t('masterData.subtitle') }}</p>
    </div>

    <nav class="flex flex-wrap gap-2" :aria-label="t('masterData.title')">
      <router-link
        v-for="x in tabs"
        :key="x.name"
        :to="{ name: x.name }"
        class="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition"
        :class="tab === x.tab ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
      >
        <component :is="x.icon" :size="16" /> {{ t(x.label) }}
      </router-link>
    </nav>

    <MasterDataAudit v-if="tab === 'audit'" />
    <MasterDataTable v-else-if="entity" :key="entity.key" :entity="entity" />
  </div>
</template>
