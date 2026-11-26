<script setup lang="ts">
/**
 * Wilayah master — READ-ONLY view for the 3PL Loader (loader.view):
 * wilayah → Cust ID Non-COD (N) / COD (Y), breakdown kota, NAMA PENGIRIM base,
 * KOTA PENGIRIM rule. Data comes from the parent (same request as the form).
 * Changes happen in Master Data (master_data.manage); the link is shown only
 * to users who may make them.
 */
import { computed } from 'vue'
import { Landmark, Lock, Settings2 } from 'lucide-vue-next'
import { authStore } from '../../stores/auth'
import { t } from '../../i18n'
import type { WilayahOption } from '../../lib/loaderApi'

const props = defineProps<{ options: WilayahOption[]; error: string }>()
const canManage = computed(() => authStore.can('master_data.manage'))
</script>

<template>
  <section class="card space-y-3 p-5" data-testid="wilayah-master">
    <h2 class="section-title flex items-center gap-2"><Landmark :size="18" class="text-indigo-600" /> {{ t('loader.wilayahMasterTitle') }}</h2>
    <p class="text-xs text-slate-500">{{ t('loader.wilayahMasterHint') }}</p>

    <p v-if="props.error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ props.error }}</p>

    <div class="overflow-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th class="px-3 py-2">{{ t('loader.wilayah') }}</th>
            <th class="px-3 py-2">{{ t('loader.custIdNonCod') }}</th>
            <th class="px-3 py-2">{{ t('loader.custIdCod') }}</th>
            <th class="px-3 py-2">{{ t('loader.kotaPengirim') }}</th>
            <th class="px-3 py-2">{{ t('loader.namaPengirimBase') }}</th>
            <th class="px-3 py-2">{{ t('loader.kotaList') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="w in props.options" :key="w.id">
            <td class="px-3 py-2 font-medium text-slate-800">{{ w.name }}</td>
            <td class="px-3 py-2 font-mono text-xs text-slate-600">{{ w.custIdNonCod || t('common.dash') }}</td>
            <td class="px-3 py-2 font-mono text-xs text-slate-600">{{ w.custIdCod || t('common.dash') }}</td>
            <td class="px-3 py-2 text-xs text-slate-600">
              <span v-if="w.kota.some((k) => k.kotaPengirim !== (w.isTasikmalaya ? '' : w.name))" class="italic text-slate-500">{{ t('loader.kotaPengirimPerKota') }}</span>
              <span v-else-if="w.isTasikmalaya" class="italic text-slate-400">{{ t('loader.kotaPengirimEmpty') }}</span>
              <span v-else>{{ w.name }}</span>
            </td>
            <td class="px-3 py-2 text-xs text-slate-600">{{ w.namaPengirimBase }}</td>
            <td class="px-3 py-2">
              <div class="flex flex-wrap gap-1">
                <span v-for="k in w.kota" :key="k.id" class="chip bg-slate-100 text-slate-600" :title="k.aliases.join(', ') || undefined">{{ k.kota }}<template v-if="k.kotaPengirim !== (w.isTasikmalaya ? '' : w.name)"> → {{ k.kotaPengirim || t('loader.kotaPengirimEmpty') }}</template></span>
                <span v-if="!w.kota.length" class="text-xs text-slate-300">{{ t('common.dash') }}</span>
              </div>
            </td>
          </tr>
          <tr v-if="!props.options.length && !props.error">
            <td colspan="6" class="px-3 py-4 text-center text-sm text-slate-400">{{ t('loader.wilayahMasterEmpty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="flex items-start gap-1.5 text-xs text-slate-500"><Lock :size="13" class="mt-0.5 shrink-0" /> {{ t('loader.referenceReadOnly') }}</p>
    <router-link v-if="canManage" class="btn btn-secondary w-full sm:w-auto" :to="{ name: 'master-data-wilayah' }">
      <Settings2 :size="16" /> {{ t('loader.manageInMasterData') }}
    </router-link>
  </section>
</template>
