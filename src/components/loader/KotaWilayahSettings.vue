<script setup lang="ts">
/**
 * Kota_Tujuan → wilayah mapping (table loader_kota_wilayah). Everyone with
 * loader access can read it; loader.manage_settings can add/change/remove.
 * Every change is recorded in the audit trail by the server.
 */
import { computed, onMounted, ref } from 'vue'
import { MapPinned, Plus, Trash2 } from 'lucide-vue-next'
import axios from 'axios'
import LoadingButton from '../LoadingButton.vue'
import { useAsyncAction, useKeyedActions } from '../../composables/useAsyncAction'
import { authStore } from '../../stores/auth'
import { t } from '../../i18n'
import { apiErrorMessage } from '../../i18n/systemMessages'

interface Mapping { id: number; kota: string; wilayah: string; source: string; updated_by: string | null }

const mappings = ref<Mapping[]>([])
const wilayahOptions = ref<string[]>([])
const error = ref('')
const message = ref('')
const kota = ref('')
const wilayah = ref('')
const canEdit = computed(() => authStore.can('loader.manage_settings'))
const rowOps = useKeyedActions()

async function load(): Promise<void> {
  error.value = ''
  try {
    const resp = await axios.get('/api/loader/settings/kota-wilayah')
    mappings.value = resp.data.mappings
    wilayahOptions.value = resp.data.wilayah
    if (!wilayah.value && wilayahOptions.value.length) wilayah.value = wilayahOptions.value[0]
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.settingsLoadFailed')
  }
}

const saveAction = useAsyncAction(async (): Promise<void> => {
  message.value = ''
  error.value = ''
  if (kota.value.trim().length < 3 || !wilayah.value) return void (error.value = t('loader.mappingInvalid'))
  try {
    await axios.post('/api/loader/settings/kota-wilayah', { kota: kota.value.trim(), wilayah: wilayah.value })
    message.value = t('loader.mappingSaved', { kota: kota.value.trim(), wilayah: wilayah.value })
    kota.value = ''
    await load()
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.mappingSaveFailed')
  }
})

function edit(m: Mapping): void {
  kota.value = m.kota
  wilayah.value = m.wilayah
}

async function remove(m: Mapping): Promise<void> {
  message.value = ''
  error.value = ''
  try {
    await axios.delete(`/api/loader/settings/kota-wilayah/${m.id}`)
    await load()
  } catch (err) {
    error.value = apiErrorMessage(err, 'loader.mappingSaveFailed')
  }
}

onMounted(load)
</script>

<template>
  <section class="card space-y-3 p-5">
    <h2 class="section-title flex items-center gap-2"><MapPinned :size="18" class="text-indigo-600" /> {{ t('loader.settingsTitle') }}</h2>
    <p class="text-xs text-slate-500">{{ t('loader.settingsHint') }}</p>

    <form v-if="canEdit" class="flex flex-wrap items-end gap-2" @submit.prevent="saveAction.run()">
      <div class="min-w-[140px] flex-1">
        <label class="label" for="map-kota">{{ t('loader.mappingKota') }}</label>
        <input id="map-kota" v-model="kota" class="input py-2" maxlength="150" :placeholder="t('loader.mappingKotaPlaceholder')" />
      </div>
      <div class="w-32">
        <label class="label" for="map-wilayah">{{ t('loader.wilayah') }}</label>
        <select id="map-wilayah" v-model="wilayah" class="input py-2">
          <option v-for="w in wilayahOptions" :key="w" :value="w">{{ w }}</option>
        </select>
      </div>
      <LoadingButton type="submit" class="btn btn-primary px-3 py-2" :loading="saveAction.pending" :aria-label="t('common.save')">
        <Plus :size="15" /> {{ t('common.save') }}
      </LoadingButton>
    </form>

    <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>
    <p v-if="message" class="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{{ message }}</p>

    <ul class="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200">
      <li v-for="m in mappings" :key="m.id" class="flex items-center gap-2 px-3 py-2 text-sm">
        <button v-if="canEdit" type="button" class="min-w-0 flex-1 truncate text-left text-slate-700 hover:text-indigo-700" @click="edit(m)">{{ m.kota }}</button>
        <span v-else class="min-w-0 flex-1 truncate text-slate-700">{{ m.kota }}</span>
        <span class="chip bg-slate-100 text-slate-600">{{ m.wilayah }}</span>
        <span class="text-[11px] text-slate-400">{{ m.source === 'seed' ? t('loader.mappingSeed') : t('loader.mappingManual') }}</span>
        <LoadingButton
          v-if="canEdit"
          class="rounded p-1 text-slate-400 hover:text-rose-600"
          :spinner-size="14"
          :loading="rowOps.isPending(m.id, 'delete')"
          :aria-label="t('common.delete')"
          @click="rowOps.run(m.id, 'delete', () => remove(m))"
        >
          <Trash2 :size="14" />
        </LoadingButton>
      </li>
      <li v-if="!mappings.length && !error" class="px-3 py-3 text-sm text-slate-400">{{ t('loader.mappingEmpty') }}</li>
    </ul>
  </section>
</template>
