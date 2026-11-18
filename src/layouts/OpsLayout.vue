<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Database,
  ScanSearch,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-vue-next'
import { authStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()

// Sidebar state: desktop collapse + mobile off-canvas.
const collapsed = ref(false)
const mobileOpen = ref(false)
const isDesktop = ref(true)

function checkWidth(): void {
  isDesktop.value = window.innerWidth >= 1024
  if (isDesktop.value) mobileOpen.value = false
}

onMounted(() => {
  checkWidth()
  window.addEventListener('resize', checkWidth)
})
onUnmounted(() => window.removeEventListener('resize', checkWidth))

// Close the mobile sidebar after navigation (per spec §11).
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  }
)

const navGroups = [
  {
    label: 'DATA CENTER',
    items: [
      { name: 'data-warrior', label: 'Data Warrior', icon: Database },
      { name: 'number-rechecking', label: 'Number Rechecking', icon: ScanSearch },
    ],
  },
]

function isActive(name: string): boolean {
  return route.name === name
}

async function logout(): Promise<void> {
  await authStore.logout()
  router.push('/login')
}
</script>

<template>
  <div class="flex min-h-screen bg-slate-100">
    <!-- Mobile overlay -->
    <div
      v-if="mobileOpen"
      class="fixed inset-0 z-30 bg-slate-900/50 lg:hidden"
      @click="mobileOpen = false"
    />

    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0"
      :class="[
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        collapsed && isDesktop ? 'lg:w-[76px]' : 'lg:w-64',
      ]"
    >
      <!-- Brand -->
      <div class="flex h-16 items-center gap-3 border-b border-slate-200 px-4">
        <div class="shrink-0 rounded-xl bg-indigo-600 p-2 text-white">
          <Database :size="20" />
        </div>
        <div v-if="!(collapsed && isDesktop)" class="min-w-0">
          <p class="truncate text-sm font-bold text-slate-900">OneOps</p>
          <p class="truncate text-xs text-slate-500">AntarXpress</p>
        </div>
        <button
          class="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          @click="mobileOpen = false"
        >
          <X :size="18" />
        </button>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div v-for="group in navGroups" :key="group.label">
          <p
            v-if="!(collapsed && isDesktop)"
            class="mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-slate-400"
          >
            {{ group.label }}
          </p>
          <ul class="space-y-1">
            <li v-for="item in group.items" :key="item.name">
              <router-link
                :to="{ name: item.name }"
                class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
                :class="
                  isActive(item.name)
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                "
                :title="collapsed && isDesktop ? item.label : undefined"
              >
                <component :is="item.icon" :size="18" class="shrink-0" />
                <span v-if="!(collapsed && isDesktop)">{{ item.label }}</span>
              </router-link>
            </li>
          </ul>
        </div>
      </nav>

      <!-- User + collapse -->
      <div class="border-t border-slate-200 p-3">
        <div
          class="flex items-center gap-3 rounded-xl px-2 py-2"
          :class="{ 'justify-center': collapsed && isDesktop }"
        >
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700"
          >
            {{ authStore.initials || '?' }}
          </div>
          <div v-if="!(collapsed && isDesktop)" class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-slate-800">
              {{ authStore.displayName }}
            </p>
            <p class="truncate text-xs capitalize text-slate-400">
              {{ authStore.state.user?.roles.join(', ').replace(/_/g, ' ') || '' }}
            </p>
          </div>
          <button
            v-if="!(collapsed && isDesktop)"
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
            title="Sign out"
            @click="logout"
          >
            <LogOut :size="18" />
          </button>
        </div>

        <button
          class="mt-2 hidden w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:flex"
          :class="{ 'px-2': collapsed && isDesktop }"
          @click="collapsed = !collapsed"
        >
          <PanelLeftClose v-if="!collapsed" :size="16" />
          <PanelLeftOpen v-else :size="16" />
          <span v-if="!collapsed">Collapse</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Mobile top bar -->
      <header class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
        <button
          class="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          @click="mobileOpen = true"
        >
          <Menu :size="20" />
        </button>
        <p class="font-bold text-slate-900">OneOps</p>
        <span class="ml-auto text-xs font-semibold text-slate-400">
          {{ authStore.displayName }}
        </span>
      </header>

      <main class="min-w-0 flex-1 p-4 sm:p-6">
        <router-view />
      </main>
    </div>
  </div>
</template>
