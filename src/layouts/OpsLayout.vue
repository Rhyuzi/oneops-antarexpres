<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Building2,
  Database,
  History,
  Mailbox,
  MapPinned,
  ScanSearch,
  ScrollText,
  Wand2,
  ShieldCheck,
  Users,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-vue-next'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { t, type MessageKey } from '../i18n'
import { useAsyncAction } from '../composables/useAsyncAction'

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

interface NavItem {
  name: string
  label: MessageKey
  icon: unknown
  permission?: string
  superAdminOnly?: boolean
}

const navGroups = computed(() => {
  const groups: Array<{ label: MessageKey; items: NavItem[] }> = [
    {
      label: 'nav.dataCenter',
      items: [
        { name: 'data-warrior', label: 'nav.dataWarrior', icon: Database, permission: 'data_warrior.view' },
        { name: 'number-rechecking', label: 'nav.numberRechecking', icon: ScanSearch, permission: 'number_rechecking.view' },
        { name: 'kodepos-loader', label: 'nav.kodeposLoader', icon: Wand2, permission: 'loader.view' },
      ],
    },
  ]

  // MASTER DATA: loader reference data (CRUD needs master_data.manage; the
  // 3PL Loader only reads it). Audit trail needs master_data.audit.
  if (authStore.can('master_data.view')) {
    const mdItems: NavItem[] = [
      { name: 'master-data-hubs', label: 'nav.mdHubs', icon: Building2, permission: 'master_data.view' },
      { name: 'master-data-kota-wilayah', label: 'nav.mdKotaWilayah', icon: MapPinned, permission: 'master_data.view' },
      { name: 'master-data-kodepos', label: 'nav.mdKodepos', icon: Mailbox, permission: 'master_data.view' },
      { name: 'master-data-audit', label: 'nav.mdAudit', icon: History, permission: 'master_data.audit' },
    ]
    groups.push({ label: 'nav.masterData', items: mdItems })
  }

  // ACCESS MANAGEMENT: Roles & Permissions is super-admin only; Account
  // Management is visible to anyone with account_management.view.
  const accessItems: NavItem[] = []
  if (authStore.isSuperAdmin) {
    accessItems.push({ name: 'access-management-roles', label: 'nav.rolesPermissions', icon: ShieldCheck, superAdminOnly: true })
  }
  if (authStore.can('account_management.view')) {
    accessItems.push({ name: 'access-management-accounts', label: 'nav.accountManagement', icon: Users, permission: 'account_management.view' })
  }
  if (authStore.can('audit_trail.view')) {
    accessItems.push({ name: 'audit-trail', label: 'nav.auditTrail', icon: ScrollText, permission: 'audit_trail.view' })
  }
  if (accessItems.length) {
    groups.push({ label: 'nav.accessManagement', items: accessItems })
  }

  return groups
})

function itemVisible(item: NavItem): boolean {
  if (item.superAdminOnly) return authStore.isSuperAdmin
  if (item.permission) return authStore.can(item.permission)
  return true
}

function isActive(name: string): boolean {
  return route.name === name
}

const logoutAction = useAsyncAction(async (): Promise<void> => {
  await authStore.logout()
  await router.push('/login')
})
</script>

<template>
  <div class="flex min-h-screen bg-slate-100">
    <!-- Mobile overlay -->
    <div
      v-if="mobileOpen"
      class="fixed inset-0 z-30 bg-slate-900/50 lg:hidden"
      @click="mobileOpen = false"
    />

    <!-- Sidebar: always exactly one viewport tall (100vh fallback, 100dvh where
         supported). Mobile = fixed drawer; desktop = sticky, so it stays in the
         layout flow (width unchanged) but no longer grows with — and scrolls
         away with — the page content. Inside: brand + account are shrink-0,
         only the nav between them scrolls. -->
    <aside
      class="h-viewport fixed left-0 top-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:sticky lg:translate-x-0"
      :class="[
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        collapsed && isDesktop ? 'lg:w-[76px]' : 'lg:w-64',
      ]"
    >
      <!-- Brand -->
      <div class="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
        <div class="shrink-0 rounded-xl bg-indigo-600 p-2 text-white">
          <Database :size="20" />
        </div>
        <div v-if="!(collapsed && isDesktop)" class="min-w-0">
          <p class="truncate text-sm font-bold text-slate-900">{{ t('common.appName') }}</p>
          <p class="truncate text-xs text-slate-500">{{ t('common.company') }}</p>
        </div>
        <button
          class="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          :aria-label="t('nav.closeMenu')"
          @click="mobileOpen = false"
        >
          <X :size="18" />
        </button>
      </div>

      <!-- Navigation -->
      <nav class="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 py-4">
        <div v-for="group in navGroups" :key="group.label">
          <p
            v-if="!(collapsed && isDesktop)"
            class="mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-slate-400"
          >
            {{ t(group.label) }}
          </p>
          <ul class="space-y-1">
            <li v-for="item in group.items.filter(itemVisible)" :key="item.name">
              <router-link
                :to="{ name: item.name }"
                class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
                :class="
                  isActive(item.name)
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                "
                :title="collapsed && isDesktop ? t(item.label) : undefined"
              >
                <component :is="item.icon" :size="18" class="shrink-0" />
                <span v-if="!(collapsed && isDesktop)">{{ t(item.label) }}</span>
              </router-link>
            </li>
          </ul>
        </div>
      </nav>

      <!-- User + collapse: anchored at the bottom, outside the nav scroll area -->
      <div class="shrink-0 border-t border-slate-200 bg-white p-3">
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
          <LoadingButton
            v-if="!(collapsed && isDesktop)"
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600 disabled:cursor-not-allowed"
            :title="t('nav.signOut')"
            :aria-label="t('nav.signOut')"
            :spinner-size="18"
            :loading="logoutAction.pending"
            @click="logoutAction.run()"
          >
            <LogOut :size="18" />
          </LoadingButton>
        </div>

        <!-- Language: segmented control, or a single toggle when collapsed -->
        <div class="mt-1 px-2">
          <LanguageSwitcher v-if="!(collapsed && isDesktop)" />
          <LanguageSwitcher v-else compact />
        </div>

        <button
          class="mt-2 hidden w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:flex"
          :class="{ 'px-2': collapsed && isDesktop }"
          :title="collapsed ? t('nav.expandSidebar') : undefined"
          :aria-label="collapsed ? t('nav.expandSidebar') : t('nav.collapse')"
          @click="collapsed = !collapsed"
        >
          <PanelLeftClose v-if="!collapsed" :size="16" />
          <PanelLeftOpen v-else :size="16" />
          <span v-if="!collapsed">{{ t('nav.collapse') }}</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Mobile top bar -->
      <header class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
        <button
          class="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          :aria-label="t('nav.openMenu')"
          @click="mobileOpen = true"
        >
          <Menu :size="20" />
        </button>
        <p class="font-bold text-slate-900">{{ t('common.appName') }}</p>
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
