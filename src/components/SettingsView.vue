<script setup lang="ts">
import { reactive, ref } from 'vue'
import { store } from '../store'
import { ArrowLeft, Eye, EyeOff, Save, ShieldAlert, Trash2 } from 'lucide-vue-next'

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
    <div class="flex items-center justify-between">
      <h2 class="section-title">API Credentials</h2>
      <button class="btn btn-ghost" @click="store.goTo('dashboard')">
        <ArrowLeft :size="18" /> Back to Dashboard
      </button>
    </div>

    <div class="card p-6">
      <div class="space-y-5">
        <div>
          <label class="label" for="bearer-token">Bearer Token</label>
          <div class="relative">
            <input
              id="bearer-token"
              v-model="form.bearerToken"
              :type="show.bearer ? 'text' : 'password'"
              class="input pr-11"
              autocomplete="off"
              spellcheck="false"
              placeholder="SiCepat authorization token"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              @click="show.bearer = !show.bearer"
            >
              <EyeOff v-if="show.bearer" :size="18" />
              <Eye v-else :size="18" />
            </button>
          </div>
        </div>

        <div>
          <label class="label" for="permission-token">X-Permission-Token</label>
          <div class="relative">
            <input
              id="permission-token"
              v-model="form.permissionToken"
              :type="show.permission ? 'text' : 'password'"
              class="input pr-11"
              autocomplete="off"
              spellcheck="false"
              placeholder="SiCepat permission token"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              @click="show.permission = !show.permission"
            >
              <EyeOff v-if="show.permission" :size="18" />
              <Eye v-else :size="18" />
            </button>
          </div>
        </div>

        <div>
          <label class="label" for="user-id">User ID</label>
          <input
            id="user-id"
            v-model="form.userId"
            type="text"
            class="input"
            autocomplete="off"
            spellcheck="false"
            placeholder="Your SiCepat user ID (sent as user_id)"
          />
          <p class="mt-1.5 text-xs text-slate-400">
            This is your own account identifier. It is never hardcoded or shared.
          </p>
        </div>
      </div>

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <button class="btn btn-primary" @click="save">
          <Save :size="18" /> Save Changes
        </button>
        <button class="btn btn-secondary" @click="clear">
          <Trash2 :size="18" /> Clear Credentials
        </button>
        <span v-if="saved" class="text-sm font-medium text-emerald-600">Saved ✓</span>
      </div>
    </div>

    <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div class="flex gap-3">
        <ShieldAlert class="mt-0.5 shrink-0 text-amber-600" :size="20" />
        <div class="text-sm text-amber-800">
          <p class="font-semibold">Security notice</p>
          <p class="mt-1">
            These credentials are stored in your browser's <code>localStorage</code>, which is
            readable by JavaScript running on this origin. That is an XSS-related risk: avoid
            pasting untrusted scripts into this app. Credentials are never written to logs and
            are only transmitted to the SiCepat API through the local proxy — never to any
            third-party service.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
