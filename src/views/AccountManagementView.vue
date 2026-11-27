<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  KeyRound,
  Loader2,
  Mail,
  MailX,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-vue-next'
import axios from 'axios'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import { useAsyncAction, useKeyedActions } from '../composables/useAsyncAction'
import { useUsernameCheck, type UsernameStatus } from '../composables/useUsernameCheck'
import { formatDateTime, formatNumber, hasKey, t, type MessageKey } from '../i18n'
import { apiErrorMessage, localizeMessage } from '../i18n/systemMessages'

interface Account {
  id: number
  username: string
  full_name: string
  email: string | null
  status: string
  roles: string[]
  activated_at: string | null
  last_login_at: string | null
  created_at: string | null
  has_pending_invitation: boolean
}

interface RoleOption {
  id: number
  name: string
  description: string | null
  is_active: number | boolean
  user_count: number
}

const accounts = ref<Account[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(true)
const error = ref('')

const search = ref('')
const roleFilter = ref('')
const statusFilter = ref('')
const searchDebounce = ref(0)

const roles = ref<RoleOption[]>([])

// permissions (frontend affordances only; backend enforces)
const can = (k: string) => authStore.can(k)
const canCreate = computed(() => can('account_management.create'))
const canEdit = computed(() => can('account_management.edit'))
const canAssign = computed(() => can('account_management.assign_roles'))
const canStatus = computed(() => can('account_management.deactivate'))
const canInvite = computed(() => can('account_management.send_invitation'))
const canReset = computed(() => can('account_management.reset_password'))
const canDelete = computed(() => can('account_management.delete'))
const isSuper = computed(() => authStore.isSuperAdmin)

// dialogs
const showCreate = ref(false)
const createForm = ref({ full_name: '', email: '', username: '', roles: [] as string[], invite: true })
const createWarning = ref('')
const editTarget = ref<Account | null>(null)
const editName = ref('')
const editEmail = ref('')
const rolesTarget = ref<Account | null>(null)
const rolesDraft = ref<string[]>([])
const resetTarget = ref<Account | null>(null)
/** Admin reset: the username can be set / changed in the same step. */
const resetUsername = ref('')
const deleteTarget = ref<Account | null>(null)
const detail = ref<Account | null>(null)

// Live "username already exists" checks (server validates again on submit).
const createUsername = computed(() => createForm.value.username)
const createCheck = useUsernameCheck(createUsername)
const resetCheck = useUsernameCheck(resetUsername, {
  excludeId: computed(() => resetTarget.value?.id ?? null),
  current: computed(() => resetTarget.value?.username ?? null),
})
watch(resetTarget, (a) => {
  resetUsername.value = a ? a.username : ''
})
watch(showCreate, (open) => {
  if (open) createCheck.reset()
})
const USERNAME_STATUS: Partial<Record<UsernameStatus, { key: MessageKey; cls: string }>> = {
  checking: { key: 'accounts.usernameChecking', cls: 'text-slate-400' },
  available: { key: 'accounts.usernameAvailable', cls: 'text-emerald-600' },
  taken: { key: 'accounts.usernameExists', cls: 'text-rose-600' },
  invalid: { key: 'accounts.usernameInvalid', cls: 'text-rose-600' },
  error: { key: 'accounts.usernameCheckFailed', cls: 'text-amber-600' },
}

const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
let toastTimer = 0
function notify(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = null), 4000)
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const STATUS_CLS: Record<string, string> = {
  pending_activation: 'bg-amber-100 text-amber-700',
  active: 'bg-emerald-100 text-emerald-700',
  inactive: 'bg-slate-200 text-slate-600',
  suspended: 'bg-rose-100 text-rose-700',
}

function statusMeta(s: string): { label: string; cls: string } {
  const key = `statuses.${s}`
  return {
    label: hasKey(key) ? t(key as MessageKey) : s,
    cls: STATUS_CLS[s] || 'bg-slate-100 text-slate-600',
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'))
  return Number.isNaN(d.getTime()) ? String(iso) : formatDateTime(d) // locale-aware; parsing unchanged
}

async function loadAccounts(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await axios.get('/api/accounts', {
      params: {
        search: search.value,
        role: roleFilter.value,
        status: statusFilter.value,
        page: page.value,
        pageSize,
      },
    })
    accounts.value = resp.data.accounts
    total.value = resp.data.total
  } catch (err: unknown) {
    error.value = apiErrorMessage(err, 'accounts.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadRoles(): Promise<void> {
  try {
    const resp = await axios.get('/api/access-management/roles')
    roles.value = resp.data.roles
  } catch {
    // Access-management endpoint is super-only; fall back to just names from accounts.
    const names = new Set<string>()
    accounts.value.forEach((a) => a.roles.forEach((r) => names.add(r)))
    roles.value = [...names].map((n, i) => ({ id: i, name: n, description: null, is_active: 1, user_count: 0 }))
  }
}

onMounted(async () => {
  await Promise.all([loadAccounts(), loadRoles()])
})

watch(search, () => {
  window.clearTimeout(searchDebounce.value)
  searchDebounce.value = window.setTimeout(() => {
    page.value = 1
    void loadAccounts()
  }, 350)
})
watch([roleFilter, statusFilter], () => {
  page.value = 1
  void loadAccounts()
})

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((p: string) => p.charAt(0).toUpperCase()).join('')
}

// --- create -------------------------------------------------------------------
const createAction = useAsyncAction(async (): Promise<void> => {
  createWarning.value = ''
  try {
    const resp = await axios.post('/api/accounts', {
      full_name: createForm.value.full_name.trim(),
      email: createForm.value.email.trim(),
      username: createForm.value.username.trim(),
      roles: createForm.value.roles,
    })
    notify('success', resp.data.invitationSent ? t('accounts.createdInvited', { email: resp.data.account.email }) : t('accounts.created'))
    if (resp.data.warning) createWarning.value = resp.data.warning // raw; rendered localized
    showCreate.value = false
    createForm.value = { full_name: '', email: '', username: '', roles: [], invite: true }
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.createFailed'))
  }
})

function toggleDraftRole(name: string): void {
  const i = rolesDraft.value.indexOf(name)
  if (i >= 0) rolesDraft.value.splice(i, 1)
  else rolesDraft.value.push(name)
}
function toggleCreateRole(name: string): void {
  const i = createForm.value.roles.indexOf(name)
  if (i >= 0) createForm.value.roles.splice(i, 1)
  else createForm.value.roles.push(name)
}

// --- edit / roles / status ------------------------------------------------------
// One lock per account: while any mutation for an account is in flight, every
// other mutation for that same account (row buttons, confirm dialogs, edit
// dialogs) is rejected. Other accounts' rows stay fully usable.
const accountOps = useKeyedActions()

async function doEdit(target: Account): Promise<void> {
  try {
    await axios.put(`/api/accounts/${target.id}`, {
      full_name: editName.value,
      email: editEmail.value,
    })
    notify('success', t('accounts.profileUpdated'))
    editTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.updateFailed'))
  }
}

async function doRoles(target: Account): Promise<void> {
  try {
    await axios.patch(`/api/accounts/${target.id}/roles`, { roles: rolesDraft.value })
    notify('success', t('accounts.rolesUpdated'))
    rolesTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.updateFailed'))
  }
}

async function setStatus(account: Account, status: string): Promise<void> {
  try {
    await axios.patch(`/api/accounts/${account.id}/status`, { status })
    notify('success', t('accounts.statusChanged', { name: account.full_name, status: statusMeta(status).label.toLowerCase() }))
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.statusChangeFailed'))
  }
}

async function resendInvitation(account: Account): Promise<void> {
  try {
    const resp = await axios.post(`/api/accounts/${account.id}/resend-invitation`)
    notify('success', localizeMessage(resp.data.message))
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.resendFailed'))
  }
}

async function revokeInvitation(account: Account): Promise<void> {
  try {
    await axios.post(`/api/accounts/${account.id}/revoke-invitation`)
    notify('success', t('accounts.invitationRevoked'))
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.revokeFailed'))
  }
}

async function triggerReset(account: Account): Promise<void> {
  try {
    const next = resetUsername.value.trim().toLowerCase()
    const body = next && next !== account.username.toLowerCase() ? { username: next } : {}
    const resp = await axios.post(`/api/accounts/${account.id}/reset-password`, body)
    notify('success', resp.data.usernameChanged
      ? `${localizeMessage(resp.data.message)} ${t('accounts.usernameChanged', { username: resp.data.username })}`
      : localizeMessage(resp.data.message))
    resetTarget.value = null
    if (resp.data.usernameChanged) await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.resetTriggerFailed'))
  }
}

async function doDelete(target: Account): Promise<void> {
  try {
    await axios.delete(`/api/accounts/${target.id}`)
    notify('success', t('accounts.deleted'))
    deleteTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    notify('error', apiErrorMessage(err, 'accounts.deleteFailed'))
  }
}

const detailAction = useAsyncAction(async (account: Account): Promise<void> => {
  try {
    const resp = await axios.get(`/api/accounts/${account.id}`)
    detail.value = resp.data.account
  } catch {
    detail.value = account
  }
})

const selfId = computed(() => authStore.state.user?.id)
</script>

<template>
  <div class="min-h-[calc(100vh-3.5rem)] space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">{{ t('accounts.title') }}</h1>
        <p class="text-sm text-slate-500">{{ t('accounts.subtitle') }}</p>
      </div>
      <button v-if="canCreate" class="btn btn-primary" @click="showCreate = true; createWarning = ''">
        <UserPlus :size="16" /> {{ t('accounts.newAccount') }}
      </button>
    </div>

    <!-- Toast -->
    <Teleport to="body">
      <div
        v-if="toast"
        class="fixed bottom-4 right-4 z-[70] flex max-w-sm items-center gap-2.5 rounded-xl border p-3.5 shadow-lg"
        :class="toast.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'"
      >
        <CheckCircle2 v-if="toast.kind === 'success'" :size="18" />
        <AlertTriangle v-else :size="18" />
        <p class="text-sm">{{ toast.message }}</p>
      </div>
    </Teleport>

    <!-- Filters -->
    <div class="card flex flex-wrap items-center gap-2 p-3">
      <div class="relative min-w-[200px] flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
        <input v-model="search" class="input py-2 pl-9" :placeholder="t('accounts.searchPlaceholder')" />
      </div>
      <select v-model="roleFilter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
        <option value="">{{ t('accounts.allRoles') }}</option>
        <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name.replace(/_/g, ' ') }}</option>
      </select>
      <select v-model="statusFilter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
        <option value="">{{ t('accounts.allStatuses') }}</option>
        <option value="pending_activation">{{ t('statuses.pending_activation') }}</option>
        <option value="active">{{ t('statuses.active') }}</option>
        <option value="inactive">{{ t('statuses.inactive') }}</option>
        <option value="suspended">{{ t('statuses.suspended') }}</option>
      </select>
      <button class="btn btn-ghost px-3 py-2" :title="t('common.refresh')" :aria-label="t('common.refresh')" :disabled="loading" :aria-busy="loading ? 'true' : undefined" @click="loadAccounts">
        <RefreshCw :size="15" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- List -->
    <div class="card p-4 sm:p-5">
      <div v-if="loading" class="flex justify-center py-14 text-slate-400">
        <Loader2 :size="26" class="animate-spin" />
      </div>
      <p v-else-if="error" class="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{{ error }}</p>
      <div v-else-if="!accounts.length" class="flex flex-col items-center justify-center py-14 text-center">
        <Users :size="38" class="text-slate-300" />
        <p class="mt-3 text-sm text-slate-500">{{ t('accounts.empty') }}</p>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-sm">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th class="px-4 py-2.5 font-semibold">{{ t('accounts.colUser') }}</th>
              <th class="px-4 py-2.5 font-semibold">{{ t('accounts.colRoles') }}</th>
              <th class="px-4 py-2.5 font-semibold">{{ t('accounts.colStatus') }}</th>
              <th class="hidden px-4 py-2.5 font-semibold lg:table-cell">{{ t('accounts.colLastLogin') }}</th>
              <th class="px-4 py-2.5 font-semibold">{{ t('accounts.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in accounts"
              :key="a.id"
              class="group border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td class="cursor-pointer px-4 py-3" @click="detailAction.run(a)">
                <div class="flex items-center gap-3">
                  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                    {{ initials(a.full_name) }}
                  </div>
                  <div class="min-w-0">
                    <p class="truncate font-semibold text-slate-800">
                      {{ a.full_name }}
                      <span v-if="a.id === selfId" class="ml-1 text-xs font-medium text-indigo-500">{{ t('common.you') }}</span>
                    </p>
                    <p class="truncate text-xs text-slate-400">@{{ a.username }} · {{ a.email || t('accounts.noEmail') }}</p>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="r in a.roles"
                    :key="r"
                    class="chip capitalize"
                    :class="r === 'super_admin' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'"
                  >
                    {{ r.replace(/_/g, ' ') }}
                  </span>
                  <span v-if="!a.roles.length" class="text-xs text-slate-300">{{ t('common.none') }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="chip" :class="statusMeta(a.status).cls">{{ statusMeta(a.status).label }}</span>
                <span v-if="a.has_pending_invitation" class="mt-1 block text-[11px] text-amber-600">
                  {{ t('accounts.invitationPending') }}
                </span>
              </td>
              <td class="hidden px-4 py-3 text-slate-500 lg:table-cell">
                <p>{{ formatDate(a.last_login_at) }}</p>
                <p class="text-xs text-slate-400">{{ t('accounts.joined', { date: formatDate(a.created_at) }) }}</p>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap items-center gap-1">
                  <template v-if="a.status === 'pending_activation'">
                    <LoadingButton
                      v-if="canInvite"
                      class="btn btn-ghost px-2 py-1 text-xs"
                      :title="t('accounts.resendTitle')"
                      :spinner-size="13"
                      :loading-text="t('common.sending')"
                      :loading="accountOps.isPending(a.id, 'resend')"
                      :disabled="accountOps.isBusy(a.id)"
                      @click="accountOps.run(a.id, 'resend', () => resendInvitation(a))"
                    >
                      <Mail :size="13" /> {{ t('accounts.resend') }}
                    </LoadingButton>
                    <LoadingButton
                      v-if="canInvite"
                      class="btn btn-ghost px-2 py-1 text-xs text-rose-600"
                      :title="t('accounts.revokeTitle')"
                      :spinner-size="13"
                      :loading-text="t('accounts.revoking')"
                      :loading="accountOps.isPending(a.id, 'revoke')"
                      :disabled="accountOps.isBusy(a.id)"
                      @click="accountOps.run(a.id, 'revoke', () => revokeInvitation(a))"
                    >
                      <MailX :size="13" /> {{ t('accounts.revoke') }}
                    </LoadingButton>
                  </template>
                  <template v-else>
                    <button v-if="canEdit" class="btn btn-ghost px-2 py-1 text-xs" :title="t('accounts.editTitle')" :disabled="accountOps.isBusy(a.id)" @click="editTarget = a; editName = a.full_name; editEmail = a.email || ''">
                      <Pencil :size="13" /> {{ t('common.edit') }}
                    </button>
                    <button v-if="canAssign && a.id !== selfId" class="btn btn-ghost px-2 py-1 text-xs" :title="t('accounts.rolesTitle')" :disabled="accountOps.isBusy(a.id)" @click="rolesTarget = a; rolesDraft = [...a.roles]">
                      <ShieldCheck :size="13" /> {{ t('accounts.roles') }}
                    </button>
                    <LoadingButton
                      v-if="canStatus && a.id !== selfId"
                      class="btn btn-ghost px-2 py-1 text-xs"
                      :class="a.status === 'active' ? 'text-amber-600' : 'text-emerald-600'"
                      :spinner-size="13"
                      :loading-text="a.status === 'active' ? t('accounts.deactivating') : t('accounts.activating')"
                      :loading="accountOps.isPending(a.id, 'status')"
                      :disabled="accountOps.isBusy(a.id)"
                      @click="accountOps.run(a.id, 'status', () => setStatus(a, a.status === 'active' ? 'inactive' : 'active'))"
                    >
                      <UserCheck :size="13" /> {{ a.status === 'active' ? t('accounts.deactivate') : t('accounts.activate') }}
                    </LoadingButton>
                    <LoadingButton
                      v-if="canReset"
                      class="btn btn-ghost px-2 py-1 text-xs"
                      :title="t('accounts.resetTitle')"
                      :spinner-size="13"
                      :loading="accountOps.isPending(a.id, 'reset')"
                      :disabled="accountOps.isBusy(a.id)"
                      @click="resetTarget = a"
                    >
                      <KeyRound :size="13" /> {{ t('accounts.reset') }}
                    </LoadingButton>
                    <LoadingButton
                      v-if="canDelete && a.id !== selfId"
                      class="btn btn-ghost px-2 py-1 text-xs text-rose-600"
                      :title="t('accounts.deleteTitle')"
                      :aria-label="t('accounts.deleteTitle')"
                      :spinner-size="13"
                      :loading="accountOps.isPending(a.id, 'delete')"
                      :disabled="accountOps.isBusy(a.id)"
                      @click="deleteTarget = a"
                    >
                      <Trash2 :size="13" />
                    </LoadingButton>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="totalPages > 1" class="mt-4 flex items-center justify-between text-sm">
          <span class="text-slate-500">{{ t('accounts.paginationSummary', { page: formatNumber(page), pages: formatNumber(totalPages), total: formatNumber(total) }) }}</span>
          <div class="flex gap-2">
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page <= 1 || loading" @click="page--; loadAccounts()">
              <ChevronLeft :size="14" /> {{ t('common.prev') }}
            </button>
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page >= totalPages || loading" @click="page++; loadAccounts()">
              {{ t('common.next') }} <ChevronRight :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Dialogs ===== -->

    <!-- Create account -->
    <Teleport to="body">
      <div v-if="showCreate" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="showCreate = false">
        <div class="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('accounts.newAccount') }}</h3>
          <div class="space-y-4">
            <div>
              <label class="label" for="na-name">{{ t('accounts.fullName') }}</label>
              <input id="na-name" v-model="createForm.full_name" class="input" maxlength="150" />
            </div>
            <div>
              <label class="label" for="na-email">{{ t('accounts.email') }}</label>
              <input id="na-email" v-model="createForm.email" class="input" type="email" />
              <p class="mt-1 text-xs text-slate-400">{{ t('accounts.invitationSentHere') }}</p>
            </div>
            <div>
              <label class="label" for="na-username">{{ t('auth.username') }}</label>
              <input
                id="na-username"
                v-model="createForm.username"
                class="input"
                maxlength="64"
                autocapitalize="none"
                spellcheck="false"
                :class="createCheck.status.value === 'taken' || createCheck.status.value === 'invalid' ? 'border-rose-400' : ''"
                :placeholder="t('accounts.usernamePlaceholder')"
              />
              <p v-if="USERNAME_STATUS[createCheck.status.value]" class="mt-1 text-xs" :class="USERNAME_STATUS[createCheck.status.value]!.cls" data-testid="create-username-status" :data-status="createCheck.status.value">
                {{ t(USERNAME_STATUS[createCheck.status.value]!.key) }}
              </p>
            </div>
            <div>
              <label class="label">{{ t('accounts.colRoles') }}</label>
              <div class="space-y-2">
                <label
                  v-for="r in roles.filter((x) => x.is_active && (isSuper || x.name !== 'super_admin'))"
                  :key="r.name"
                  class="flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2 text-sm"
                  :class="createForm.roles.includes(r.name) ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600'"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                    :checked="createForm.roles.includes(r.name)"
                    @change="toggleCreateRole(r.name)"
                  />
                  <span class="font-medium capitalize">{{ r.name.replace(/_/g, ' ') }}</span>
                </label>
              </div>
            </div>
            <p class="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              {{ t('accounts.createInfoBefore') }} <strong>{{ t('statuses.pending_activation') }}</strong>
              {{ t('accounts.createInfoAfter') }}
            </p>
            <p v-if="createWarning" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{{ localizeMessage(createWarning) }}</p>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="showCreate = false">{{ t('common.cancel') }}</button>
              <LoadingButton
                class="btn btn-primary"
                :loading-text="t('common.creating')"
                :loading="createAction.pending"
                :disabled="!createForm.full_name || !createForm.email || !createForm.username || !createForm.roles.length || createCheck.blocks()"
                @click="createAction.run()"
              >
                {{ t('accounts.createAndInvite') }}
              </LoadingButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit profile -->
    <Teleport to="body">
      <div v-if="editTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="editTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('accounts.editTitle') }}</h3>
          <div class="space-y-4">
            <div>
              <label class="label">{{ t('accounts.fullName') }}</label>
              <input v-model="editName" class="input" maxlength="150" />
            </div>
            <div>
              <label class="label">{{ t('accounts.email') }}</label>
              <input v-model="editEmail" class="input" type="email" />
            </div>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="editTarget = null">{{ t('common.cancel') }}</button>
              <LoadingButton
                class="btn btn-primary"
                :loading-text="t('common.saving')"
                :loading="accountOps.isPending(editTarget.id, 'edit')"
                :disabled="accountOps.isBusy(editTarget.id)"
                @click="accountOps.run(editTarget.id, 'edit', () => doEdit(editTarget!))"
              >
                {{ t('common.save') }}
              </LoadingButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Change roles -->
    <Teleport to="body">
      <div v-if="rolesTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="rolesTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-1">{{ t('accounts.roles') }}</h3>
          <p class="mb-4 text-sm text-slate-500">{{ rolesTarget.full_name }} (@{{ rolesTarget.username }})</p>
          <div class="space-y-2">
            <label
              v-for="r in roles.filter((x) => x.is_active && (isSuper || x.name !== 'super_admin'))"
              :key="r.name"
              class="flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2 text-sm"
              :class="rolesDraft.includes(r.name) ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600'"
            >
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                :checked="rolesDraft.includes(r.name)"
                @change="toggleDraftRole(r.name)"
              />
              <span class="font-medium capitalize">{{ r.name.replace(/_/g, ' ') }}</span>
            </label>
          </div>
          <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {{ t('accounts.rolesDialogNote') }}
          </p>
          <div class="mt-4 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="rolesTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-primary"
              :loading-text="t('common.saving')"
              :loading="accountOps.isPending(rolesTarget.id, 'roles')"
              :disabled="!rolesDraft.length || accountOps.isBusy(rolesTarget.id)"
              @click="accountOps.run(rolesTarget.id, 'roles', () => doRoles(rolesTarget!))"
            >
              {{ t('accounts.saveRoles') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Trigger password reset confirm -->
    <Teleport to="body">
      <div v-if="resetTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="resetTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-slate-900">{{ t('accounts.resetConfirmTitle') }}</h3>
          <p class="text-sm text-slate-600">
            {{ t('accounts.resetConfirmBefore') }}
            <strong>{{ resetTarget.email }}</strong>. {{ t('accounts.resetConfirmAfter') }}
          </p>
          <div class="mt-4">
            <label class="label" for="reset-username">{{ t('auth.username') }}</label>
            <input
              id="reset-username"
              v-model="resetUsername"
              class="input"
              maxlength="64"
              autocapitalize="none"
              spellcheck="false"
              :class="resetCheck.status.value === 'taken' || resetCheck.status.value === 'invalid' ? 'border-rose-400' : ''"
              :placeholder="t('accounts.usernamePlaceholder')"
            />
            <p v-if="USERNAME_STATUS[resetCheck.status.value]" class="mt-1 text-xs" :class="USERNAME_STATUS[resetCheck.status.value]!.cls" data-testid="reset-username-status" :data-status="resetCheck.status.value">
              {{ t(USERNAME_STATUS[resetCheck.status.value]!.key) }}
            </p>
            <p v-else class="mt-1 text-xs text-slate-400">{{ t('accounts.resetUsernameHint') }}</p>
          </div>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="resetTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-primary"
              :loading-text="t('common.sending')"
              :loading="accountOps.isPending(resetTarget.id, 'reset')"
              :disabled="accountOps.isBusy(resetTarget.id) || resetCheck.blocks()"
              @click="accountOps.run(resetTarget.id, 'reset', () => triggerReset(resetTarget!))"
            >
              <KeyRound :size="15" /> {{ t('accounts.sendResetEmail') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirm -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="deleteTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-rose-700">{{ t('accounts.deleteConfirmTitle') }}</h3>
          <p class="text-sm text-slate-600">
            <strong>{{ deleteTarget.full_name }}</strong>
            {{ t('accounts.deleteConfirmBody', { username: deleteTarget.username }) }}
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="deleteTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-danger"
              :loading-text="t('common.deleting')"
              :loading="accountOps.isPending(deleteTarget.id, 'delete')"
              :disabled="accountOps.isBusy(deleteTarget.id)"
              @click="accountOps.run(deleteTarget.id, 'delete', () => doDelete(deleteTarget!))"
            >
              {{ t('common.delete') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Detail drawer -->
    <Teleport to="body">
      <div v-if="detail" class="fixed inset-0 z-50 flex justify-end bg-slate-900/60" @click.self="detail = null">
        <div class="h-full w-full max-w-md overflow-auto bg-white p-6 shadow-2xl">
          <div class="mb-4 flex items-start justify-between">
            <div class="flex items-center gap-3">
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-base font-bold text-indigo-700">
                {{ initials(detail.full_name) }}
              </div>
              <div>
                <p class="font-bold text-slate-900">{{ detail.full_name }}</p>
                <p class="text-sm text-slate-400">@{{ detail.username }}</p>
              </div>
            </div>
            <button class="rounded-lg p-2 text-slate-400 hover:bg-slate-100" :aria-label="t('common.close')" @click="detail = null">
              <X :size="18" />
            </button>
          </div>

          <dl class="space-y-3 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.email') }}</dt>
              <dd class="text-right text-slate-800">{{ detail.email || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.colStatus') }}</dt>
              <dd><span class="chip" :class="statusMeta(detail.status).cls">{{ statusMeta(detail.status).label }}</span></dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.colRoles') }}</dt>
              <dd class="text-right capitalize text-slate-800">{{ detail.roles.join(', ').replace(/_/g, ' ') || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.detailCreated') }}</dt>
              <dd class="text-slate-800">{{ formatDate(detail.created_at) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.detailActivated') }}</dt>
              <dd class="text-slate-800">{{ formatDate(detail.activated_at) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('accounts.colLastLogin') }}</dt>
              <dd class="text-slate-800">{{ formatDate(detail.last_login_at) }}</dd>
            </div>
          </dl>

          <p class="mt-6 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
            <Clock :size="13" /> {{ detail.has_pending_invitation ? t('accounts.invitationStillValid') : t('accounts.invitationNotPending') }}
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>
