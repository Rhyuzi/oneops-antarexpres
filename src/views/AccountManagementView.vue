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
const createBusy = ref(false)
const createWarning = ref('')
const editTarget = ref<Account | null>(null)
const editName = ref('')
const editEmail = ref('')
const editBusy = ref(false)
const rolesTarget = ref<Account | null>(null)
const rolesDraft = ref<string[]>([])
const rolesBusy = ref(false)
const resetTarget = ref<Account | null>(null)
const deleteTarget = ref<Account | null>(null)
const detail = ref<Account | null>(null)

const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
let toastTimer = 0
function notify(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = null), 4000)
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending_activation: { label: 'Pending activation', cls: 'bg-amber-100 text-amber-700' },
  active: { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' },
  inactive: { label: 'Inactive', cls: 'bg-slate-200 text-slate-600' },
  suspended: { label: 'Suspended', cls: 'bg-rose-100 text-rose-700' },
}

function statusMeta(s: string) {
  return STATUS_META[s] || { label: s, cls: 'bg-slate-100 text-slate-600' }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'))
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
    const e = err as { response?: { data?: { message?: string } } }
    error.value = e.response?.data?.message || 'Could not load accounts.'
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
async function doCreate(): Promise<void> {
  if (createBusy.value) return
  createBusy.value = true
  createWarning.value = ''
  try {
    const resp = await axios.post('/api/accounts', {
      full_name: createForm.value.full_name.trim(),
      email: createForm.value.email.trim(),
      username: createForm.value.username.trim(),
      roles: createForm.value.roles,
    })
    notify('success', resp.data.invitationSent ? `Account created — invitation emailed to ${resp.data.account.email}.` : 'Account created.')
    if (resp.data.warning) createWarning.value = resp.data.warning
    showCreate.value = false
    createForm.value = { full_name: '', email: '', username: '', roles: [], invite: true }
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Create failed.')
  } finally {
    createBusy.value = false
  }
}

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
async function doEdit(): Promise<void> {
  if (!editTarget.value || editBusy.value) return
  editBusy.value = true
  try {
    await axios.put(`/api/accounts/${editTarget.value.id}`, {
      full_name: editName.value,
      email: editEmail.value,
    })
    notify('success', 'Profile updated.')
    editTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Update failed.')
  } finally {
    editBusy.value = false
  }
}

async function doRoles(): Promise<void> {
  if (!rolesTarget.value || rolesBusy.value) return
  rolesBusy.value = true
  try {
    await axios.patch(`/api/accounts/${rolesTarget.value.id}/roles`, { roles: rolesDraft.value })
    notify('success', 'Roles updated.')
    rolesTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Update failed.')
  } finally {
    rolesBusy.value = false
  }
}

async function setStatus(account: Account, status: string): Promise<void> {
  try {
    await axios.patch(`/api/accounts/${account.id}/status`, { status })
    notify('success', `${account.full_name}: ${statusMeta(status).label.toLowerCase()}.`)
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Status change failed.')
  }
}

async function resendInvitation(account: Account): Promise<void> {
  try {
    const resp = await axios.post(`/api/accounts/${account.id}/resend-invitation`)
    notify('success', resp.data.message)
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Resend failed.')
  }
}

async function revokeInvitation(account: Account): Promise<void> {
  try {
    await axios.post(`/api/accounts/${account.id}/revoke-invitation`)
    notify('success', 'Invitation revoked.')
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Revoke failed.')
  }
}

async function triggerReset(account: Account): Promise<void> {
  try {
    const resp = await axios.post(`/api/accounts/${account.id}/reset-password`)
    notify('success', resp.data.message)
    resetTarget.value = null
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Reset trigger failed.')
  }
}

async function doDelete(): Promise<void> {
  if (!deleteTarget.value) return
  try {
    await axios.delete(`/api/accounts/${deleteTarget.value.id}`)
    notify('success', 'Account deleted.')
    deleteTarget.value = null
    await loadAccounts()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    notify('error', e.response?.data?.message || 'Delete failed.')
  }
}

async function openDetail(account: Account): Promise<void> {
  try {
    const resp = await axios.get(`/api/accounts/${account.id}`)
    detail.value = resp.data.account
  } catch {
    detail.value = account
  }
}

const selfId = computed(() => authStore.state.user?.id)
</script>

<template>
  <div class="min-h-[calc(100vh-3.5rem)] space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">Account Management</h1>
        <p class="text-sm text-slate-500">User accounts, invitations &amp; lifecycle</p>
      </div>
      <button v-if="canCreate" class="btn btn-primary" @click="showCreate = true; createWarning = ''">
        <UserPlus :size="16" /> New account
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
        <input v-model="search" class="input py-2 pl-9" placeholder="Search name, email, username…" />
      </div>
      <select v-model="roleFilter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
        <option value="">All roles</option>
        <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name.replace(/_/g, ' ') }}</option>
      </select>
      <select v-model="statusFilter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
        <option value="">All statuses</option>
        <option value="pending_activation">Pending activation</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
        <option value="suspended">Suspended</option>
      </select>
      <button class="btn btn-ghost px-3 py-2" @click="loadAccounts">
        <RefreshCw :size="15" />
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
        <p class="mt-3 text-sm text-slate-500">No accounts match your filters.</p>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-sm">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th class="px-4 py-2.5 font-semibold">User</th>
              <th class="px-4 py-2.5 font-semibold">Roles</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              <th class="hidden px-4 py-2.5 font-semibold lg:table-cell">Last login</th>
              <th class="px-4 py-2.5 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in accounts"
              :key="a.id"
              class="group border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td class="cursor-pointer px-4 py-3" @click="openDetail(a)">
                <div class="flex items-center gap-3">
                  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                    {{ initials(a.full_name) }}
                  </div>
                  <div class="min-w-0">
                    <p class="truncate font-semibold text-slate-800">
                      {{ a.full_name }}
                      <span v-if="a.id === selfId" class="ml-1 text-xs font-medium text-indigo-500">(you)</span>
                    </p>
                    <p class="truncate text-xs text-slate-400">@{{ a.username }} · {{ a.email || 'no email' }}</p>
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
                  <span v-if="!a.roles.length" class="text-xs text-slate-300">none</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="chip" :class="statusMeta(a.status).cls">{{ statusMeta(a.status).label }}</span>
                <span v-if="a.has_pending_invitation" class="mt-1 block text-[11px] text-amber-600">
                  invitation pending
                </span>
              </td>
              <td class="hidden px-4 py-3 text-slate-500 lg:table-cell">
                <p>{{ formatDate(a.last_login_at) }}</p>
                <p class="text-xs text-slate-400">joined {{ formatDate(a.created_at) }}</p>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap items-center gap-1">
                  <template v-if="a.status === 'pending_activation'">
                    <button v-if="canInvite" class="btn btn-ghost px-2 py-1 text-xs" title="Resend invitation" @click="resendInvitation(a)">
                      <Mail :size="13" /> Resend
                    </button>
                    <button v-if="canInvite" class="btn btn-ghost px-2 py-1 text-xs text-rose-600" title="Revoke invitation" @click="revokeInvitation(a)">
                      <MailX :size="13" /> Revoke
                    </button>
                  </template>
                  <template v-else>
                    <button v-if="canEdit" class="btn btn-ghost px-2 py-1 text-xs" title="Edit profile" @click="editTarget = a; editName = a.full_name; editEmail = a.email || ''">
                      <Pencil :size="13" /> Edit
                    </button>
                    <button v-if="canAssign && a.id !== selfId" class="btn btn-ghost px-2 py-1 text-xs" title="Change roles" @click="rolesTarget = a; rolesDraft = [...a.roles]">
                      <ShieldCheck :size="13" /> Roles
                    </button>
                    <button v-if="canStatus && a.id !== selfId" class="btn btn-ghost px-2 py-1 text-xs" :class="a.status === 'active' ? 'text-amber-600' : 'text-emerald-600'" @click="setStatus(a, a.status === 'active' ? 'inactive' : 'active')">
                      <UserCheck :size="13" /> {{ a.status === 'active' ? 'Deactivate' : 'Activate' }}
                    </button>
                    <button v-if="canReset" class="btn btn-ghost px-2 py-1 text-xs" title="Send password reset email" @click="resetTarget = a">
                      <KeyRound :size="13" /> Reset
                    </button>
                    <button v-if="canDelete && a.id !== selfId" class="btn btn-ghost px-2 py-1 text-xs text-rose-600" @click="deleteTarget = a">
                      <Trash2 :size="13" />
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="totalPages > 1" class="mt-4 flex items-center justify-between text-sm">
          <span class="text-slate-500">Page {{ page }} of {{ totalPages }} · {{ total }} accounts</span>
          <div class="flex gap-2">
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page <= 1" @click="page--; loadAccounts()">
              <ChevronLeft :size="14" /> Prev
            </button>
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page >= totalPages" @click="page++; loadAccounts()">
              Next <ChevronRight :size="14" />
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
          <h3 class="section-title mb-4">New account</h3>
          <div class="space-y-4">
            <div>
              <label class="label" for="na-name">Full name</label>
              <input id="na-name" v-model="createForm.full_name" class="input" maxlength="150" />
            </div>
            <div>
              <label class="label" for="na-email">Email</label>
              <input id="na-email" v-model="createForm.email" class="input" type="email" />
              <p class="mt-1 text-xs text-slate-400">The invitation is sent here.</p>
            </div>
            <div>
              <label class="label" for="na-username">Username</label>
              <input id="na-username" v-model="createForm.username" class="input" maxlength="64" placeholder="lowercase, digits, . _ -" />
            </div>
            <div>
              <label class="label">Roles</label>
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
              The account is created as <strong>Pending Activation</strong> and an invitation email with an
              activation link (valid 24 h, single-use) is sent. The user sets their own password — you never see it.
            </p>
            <p v-if="createWarning" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{{ createWarning }}</p>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="showCreate = false">Cancel</button>
              <button class="btn btn-primary" :disabled="createBusy || !createForm.full_name || !createForm.email || !createForm.username || !createForm.roles.length" @click="doCreate">
                <Loader2 v-if="createBusy" :size="16" class="animate-spin" /> Create &amp; invite
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit profile -->
    <Teleport to="body">
      <div v-if="editTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="editTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">Edit profile</h3>
          <div class="space-y-4">
            <div>
              <label class="label">Full name</label>
              <input v-model="editName" class="input" maxlength="150" />
            </div>
            <div>
              <label class="label">Email</label>
              <input v-model="editEmail" class="input" type="email" />
            </div>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="editTarget = null">Cancel</button>
              <button class="btn btn-primary" :disabled="editBusy" @click="doEdit">Save</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Change roles -->
    <Teleport to="body">
      <div v-if="rolesTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="rolesTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-1">Roles</h3>
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
            You cannot change your own roles. Only Super Admins can assign super_admin.
          </p>
          <div class="mt-4 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="rolesTarget = null">Cancel</button>
            <button class="btn btn-primary" :disabled="rolesBusy || !rolesDraft.length" @click="doRoles">
              <Loader2 v-if="rolesBusy" :size="16" class="animate-spin" /> Save roles
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Trigger password reset confirm -->
    <Teleport to="body">
      <div v-if="resetTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="resetTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-slate-900">Send password reset?</h3>
          <p class="text-sm text-slate-600">
            A single-use reset link (valid 30 minutes) will be emailed to
            <strong>{{ resetTarget.email }}</strong>. Their current password keeps working until they use it.
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="resetTarget = null">Cancel</button>
            <button class="btn btn-primary" @click="triggerReset(resetTarget)">
              <KeyRound :size="15" /> Send reset email
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirm -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="deleteTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-rose-700">Delete account?</h3>
          <p class="text-sm text-slate-600">
            <strong>{{ deleteTarget.full_name }}</strong> (@{{ deleteTarget.username }}) will be permanently
            removed, along with their role assignments. Their audit history remains.
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="deleteTarget = null">Cancel</button>
            <button class="btn btn-danger" @click="doDelete">Delete</button>
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
            <button class="rounded-lg p-2 text-slate-400 hover:bg-slate-100" @click="detail = null">
              <X :size="18" />
            </button>
          </div>

          <dl class="space-y-3 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Email</dt>
              <dd class="text-right text-slate-800">{{ detail.email || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Status</dt>
              <dd><span class="chip" :class="statusMeta(detail.status).cls">{{ statusMeta(detail.status).label }}</span></dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Roles</dt>
              <dd class="text-right capitalize text-slate-800">{{ detail.roles.join(', ').replace(/_/g, ' ') || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Created</dt>
              <dd class="text-slate-800">{{ formatDate(detail.created_at) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Activated</dt>
              <dd class="text-slate-800">{{ formatDate(detail.activated_at) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">Last login</dt>
              <dd class="text-slate-800">{{ formatDate(detail.last_login_at) }}</dd>
            </div>
          </dl>

          <p class="mt-6 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
            <Clock :size="13" /> Invitation {{ detail.has_pending_invitation ? 'pending — link still valid' : 'not pending' }}
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>
