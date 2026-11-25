<script setup lang="ts">
/**
 * Sidebar account block: avatar + name + active role. Click → menu with
 * Account Settings and (for accounts with more than one role) Switch Role.
 * Opens upwards (the block sits at the bottom of the sidebar).
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronsUpDown, Settings } from 'lucide-vue-next'
import { authStore } from '../../stores/auth'
import { roleName } from '../../composables/useRoleSwitch'
import { t } from '../../i18n'
import RoleSwitcher from './RoleSwitcher.vue'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

function roleLine(): string {
  const active = authStore.activeRole
  if (active) return roleName(active)
  return authStore.assignedRoles.map(roleName).join(', ')
}
</script>

<template>
  <div ref="root" class="relative min-w-0 flex-1">
    <button
      type="button"
      class="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-100"
      :class="{ 'justify-center': props.compact }"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="t('account.menu')"
      :title="props.compact ? authStore.displayName : undefined"
      @click="open = !open"
    >
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
        {{ authStore.initials || '?' }}
      </span>
      <span v-if="!props.compact" class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-slate-800">{{ authStore.displayName }}</span>
        <span class="block truncate text-xs capitalize text-slate-400" data-testid="active-role">{{ roleLine() }}</span>
      </span>
      <ChevronsUpDown v-if="!props.compact" :size="15" class="shrink-0 text-slate-400" />
    </button>

    <div
      v-if="open"
      class="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-xl"
      role="menu"
    >
      <div class="border-b border-slate-100 px-2 pb-2">
        <p class="truncate text-sm font-semibold text-slate-800">{{ authStore.displayName }}</p>
        <p class="truncate text-xs text-slate-400">@{{ authStore.state.user?.username }}</p>
      </div>
      <router-link
        :to="{ name: 'account-settings' }"
        class="mt-1 flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-100"
        role="menuitem"
        @click="open = false"
      >
        <Settings :size="15" class="text-slate-400" /> {{ t('account.settings') }}
      </router-link>
      <div v-if="authStore.assignedRoles.length > 1" class="mt-1 border-t border-slate-100 pt-2">
        <p class="px-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{{ t('account.switchRole') }}</p>
        <RoleSwitcher dense @switched="open = false" />
      </div>
    </div>
  </div>
</template>
