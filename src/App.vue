<script setup lang="ts">
import { computed } from 'vue'
import { store } from './store'
import Dashboard from './components/Dashboard.vue'
import SettingsView from './components/SettingsView.vue'
import { LayoutDashboard, PackageSearch, Settings } from 'lucide-vue-next'

const isSettings = computed(() => store.state.view === 'settings')

const status = computed(() => {
  const s = store.state
  if (s.authError) return { text: 'Auth error', cls: 'bg-rose-100 text-rose-700' }
  if (s.running && s.stopRequested) return { text: 'Stopping…', cls: 'bg-amber-100 text-amber-700' }
  if (s.running && s.paused) return { text: 'Paused', cls: 'bg-amber-100 text-amber-700' }
  if (s.running) return { text: 'Processing', cls: 'bg-emerald-100 text-emerald-700' }
  return { text: 'Idle', cls: 'bg-slate-200 text-slate-600' }
})
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div class="flex items-center gap-3">
          <div class="rounded-xl bg-indigo-600 p-2 text-white">
            <PackageSearch :size="22" />
          </div>
          <div>
            <h1 class="text-lg font-bold leading-tight text-slate-900">
              SiCepat Bulk Phone Rechecker
            </h1>
            <p class="text-xs text-slate-500">
              Retrieve unmasked recipient phone numbers from AWB data
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span class="chip" :class="status.cls">{{ status.text }}</span>
          <nav class="flex items-center gap-1">
            <button
              class="btn btn-ghost"
              :class="{ 'bg-indigo-50 text-indigo-700': !isSettings }"
              @click="store.goTo('dashboard')"
            >
              <LayoutDashboard :size="18" />
              <span class="hidden sm:inline">Dashboard</span>
            </button>
            <button
              class="btn btn-ghost"
              :class="{ 'bg-indigo-50 text-indigo-700': isSettings }"
              @click="store.goTo('settings')"
            >
              <Settings :size="18" />
              <span class="hidden sm:inline">Settings</span>
            </button>
          </nav>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Dashboard v-if="!isSettings" />
      <SettingsView v-else />
    </main>

    <footer class="mx-auto max-w-6xl px-4 pb-8 text-xs text-slate-400 sm:px-6">
      Runs fully locally. Credentials are stored in your browser's localStorage and are only
      sent to the SiCepat API through the local proxy.
    </footer>
  </div>
</template>
