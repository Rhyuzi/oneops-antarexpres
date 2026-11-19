<script setup lang="ts">
import { reactive, ref } from 'vue'
import { store } from '../store'
import { ArrowLeft, Eye, EyeOff, Save, Settings, ShieldAlert, Trash2 } from 'lucide-vue-next'
import { t } from '../i18n'

const form = reactive({
  bearerToken: store.state.settings.bearerToken,
  permissionToken: store.state.settings.permissionToken,
  userId: store.state.settings.userId,
})

const show = reactive({ bearer: false, permission: false })
const saved = ref(false)

function save(): void {
  store.updateSettings({
    bearerToken: form.bearerToken.trim(),
    permissionToken: form.permissionToken.trim(),
    userId: form.userId.trim(),
  })
  saved.value = true
  window.setTimeout(() => (saved.value = false), 2500)
}

function clear(): void {
  store.clearCredentials()
  form.bearerToken = ''
  form.permissionToken = ''
  form.userId = ''
  saved.value = false
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <!-- Page header -->
    <div>
      <h1 class="flex items-center gap-2 text-xl font-bold text-slate-900">
        <Settings :size="22" class="text-indigo-600" /> {{ t('rechecker.settingsTitle') }}
      </h1>
      <p class="mt-1 text-sm text-slate-500">{{ t('rechecker.settingsSubtitle') }}</p>
    </div>

    <div class="card p-6">
      <div class="space-y-5">
        <div>
          <label class="label" for="bearer-token">{{ t('rechecker.bearerToken') }}</label>
          <div class="relative">
            <input
              id="bearer-token"
              v-model="form.bearerToken"
              :type="show.bearer ? 'text' : 'password'"
              class="input pr-11"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('rechecker.bearerPlaceholder')"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              :aria-label="show.bearer ? t('common.hide') : t('common.show')"
              @click="show.bearer = !show.bearer"
            >
              <Eye v-if="!show.bearer" :size="18" />
              <EyeOff v-else :size="18" />
            </button>
          </div>
        </div>

        <div>
          <label class="label" for="permission-token">{{ t('rechecker.permissionToken') }}</label>
          <div class="relative">
            <input
              id="permission-token"
              v-model="form.permissionToken"
              :type="show.permission ? 'text' : 'password'"
              class="input pr-11"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('rechecker.permissionPlaceholder')"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              :aria-label="show.permission ? t('common.hide') : t('common.show')"
              @click="show.permission = !show.permission"
            >
              <Eye v-if="!show.permission" :size="18" />
              <EyeOff v-else :size="18" />
            </button>
          </div>
        </div>

        <div>
          <label class="label" for="user-id">{{ t('rechecker.userId') }}</label>
          <input
            id="user-id"
            v-model="form.userId"
            class="input"
            autocomplete="off"
            :placeholder="t('rechecker.userIdPlaceholder')"
          />
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button class="btn btn-primary" @click="save">
            <Save :size="18" /> {{ t('common.saveChanges') }}
          </button>
          <router-link class="btn btn-secondary" to="/ops/number-rechecking">
            <ArrowLeft :size="18" /> {{ t('rechecker.backToRechecker') }}
          </router-link>
          <button class="btn btn-ghost" @click="clear">
            <Trash2 :size="18" /> {{ t('common.clear') }}
          </button>
          <span v-if="saved" class="text-sm font-medium text-emerald-600">{{ t('rechecker.saved') }}</span>
        </div>
      </div>
    </div>

    <div class="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <ShieldAlert class="mt-0.5 shrink-0 text-amber-600" :size="18" />
      <p class="text-sm text-amber-800">
        {{ t('rechecker.credentialsWarning') }}
      </p>
    </div>
  </div>
</template>
