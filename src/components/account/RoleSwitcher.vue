<script setup lang="ts">
/**
 * Switch Role list: "All my roles" + every role assigned to the account.
 * Only roles the account holds are listed; the server re-validates each
 * switch against the DB (a role removed by an admin is refused there).
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Check, Layers, Loader2, UserCog } from 'lucide-vue-next'
import { authStore } from '../../stores/auth'
import { roleName, useRoleSwitch } from '../../composables/useRoleSwitch'
import { t } from '../../i18n'

const props = withDefaults(defineProps<{ dense?: boolean }>(), { dense: false })
const emit = defineEmits<{ (e: 'switched'): void }>()

const router = useRouter()
const { state, switchTo } = useRoleSwitch()

const options = computed(() => [
  { role: null as string | null, label: t('account.allRoles'), hint: t('account.allRolesHint', { count: authStore.assignedRoles.length }) },
  ...authStore.assignedRoles.map((r) => ({ role: r as string | null, label: roleName(r), hint: '' })),
])
const busy = computed(() => state.pendingRole !== undefined)

async function pick(role: string | null): Promise<void> {
  if (await switchTo(role, router)) emit('switched')
}
</script>

<template>
  <div>
    <ul class="space-y-1" role="radiogroup" :aria-label="t('account.switchRole')">
      <li v-for="o in options" :key="o.role ?? '*'">
        <button
          type="button"
          role="radio"
          :aria-checked="authStore.activeRole === o.role"
          :disabled="busy"
          class="flex w-full items-center gap-2.5 rounded-lg text-left text-sm transition disabled:cursor-not-allowed"
          :class="[
            props.dense ? 'px-2 py-1.5' : 'px-3 py-2',
            authStore.activeRole === o.role ? 'bg-indigo-50 font-semibold text-indigo-700' : 'text-slate-700 hover:bg-slate-100',
          ]"
          @click="pick(o.role)"
        >
          <Layers v-if="o.role === null" :size="15" class="shrink-0 text-slate-400" />
          <UserCog v-else :size="15" class="shrink-0 text-slate-400" />
          <span class="min-w-0 flex-1">
            <span class="block truncate" :class="{ capitalize: o.role !== null }">{{ o.label }}</span>
            <span v-if="o.hint && !props.dense" class="block truncate text-xs font-normal text-slate-400">{{ o.hint }}</span>
          </span>
          <Loader2 v-if="state.pendingRole === o.role" :size="15" class="shrink-0 animate-spin text-indigo-500" />
          <Check v-else-if="authStore.activeRole === o.role" :size="15" class="shrink-0" />
        </button>
      </li>
    </ul>
    <p v-if="state.error" class="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700" role="alert">{{ state.error }}</p>
  </div>
</template>
