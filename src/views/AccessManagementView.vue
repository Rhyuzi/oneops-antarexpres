<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-vue-next'
import axios from 'axios'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import { useAsyncAction, useKeyedActions } from '../composables/useAsyncAction'
import { formatNumber, hasKey, t, tn, type MessageKey } from '../i18n'
import { apiErrorMessage, localizeRoleDescription } from '../i18n/systemMessages'

// --- types -----------------------------------------------------------------
interface Role {
  id: number
  name: string
  description: string | null
  is_active: number | boolean
  user_count: number
  permission_count: number
  is_system: boolean
  created_at: string
}

interface RegistryPermission {
  key: string
  module: string
  module_label: string
  feature: string
  action: string
  description: string
}

interface AmUser {
  id: number
  username: string
  full_name: string
  email: string | null
  is_active: number | boolean
  roles: string[]
}

interface FolderRow {
  id: number
  parent_id: number | null
  name: string
}

interface FolderPerms {
  can_view: boolean
  can_create_folder: boolean
  can_upload: boolean
  can_download: boolean
  can_preview: boolean
  can_rename: boolean
  can_move: boolean
  can_delete: boolean
  can_manage_permissions: boolean
}

const FOLDER_CAPS: Array<{ key: keyof FolderPerms; label: MessageKey }> = [
  { key: 'can_view', label: 'caps.can_view' },
  { key: 'can_create_folder', label: 'caps.can_create_folder' },
  { key: 'can_upload', label: 'caps.can_upload' },
  { key: 'can_download', label: 'caps.can_download' },
  { key: 'can_preview', label: 'caps.can_preview' },
  { key: 'can_rename', label: 'caps.can_rename' },
  { key: 'can_move', label: 'caps.can_move' },
  { key: 'can_delete', label: 'caps.can_delete' },
  { key: 'can_manage_permissions', label: 'caps.can_manage_permissions' },
]

const TABS: Array<{ key: 'modules' | 'folders' | 'users'; label: MessageKey }> = [
  { key: 'modules', label: 'access.tabModules' },
  { key: 'folders', label: 'access.tabFolders' },
  { key: 'users', label: 'access.tabUsers' },
]

// Registry labels are system-defined: translate by permission key / module /
// action, falling back to the server's English text for unknown entries.
function permText(perm: RegistryPermission, field: 'feature' | 'description'): string {
  const key = `permissions.keys.${perm.key}.${field}`
  return hasKey(key) ? t(key) : perm[field]
}
function moduleText(module: string, fallback: string): string {
  const key = `permissions.modules.${module}`
  return hasKey(key) ? t(key) : fallback
}
function actionText(action: string): string {
  const key = `permissions.actions.${action}`
  return hasKey(key) ? t(key) : action
}

// --- state -----------------------------------------------------------------
const roles = ref<Role[]>([])
const rolesLoading = ref(true)
const selectedRoleId = ref<number | null>(null)
const tab = ref<'modules' | 'folders' | 'users'>('modules')

const registry = ref<RegistryPermission[]>([])
const granted = ref<Set<string>>(new Set())
const draftPerms = ref<Set<string>>(new Set())
const permsDirty = ref(false)
const permsLoading = ref(false)

const folders = ref<FolderRow[]>([])
const foldersExpanded = ref<Set<number>>(new Set())
const modulesExpanded = ref<Set<string>>(new Set(['data_warrior', 'number_rechecking', 'access_management']))
const selectedFolderId = ref<number | null>(null)
const folderExplicit = ref<Record<number, FolderPerms>>({})
const folderInherited = ref<Record<number, Partial<FolderPerms>>>({})
const folderDraft = ref<FolderPerms | null>(null)
const folderDirty = ref(false)

const users = ref<AmUser[]>([])
const usersSearch = ref('')
const usersLoading = ref(false)
const editUser = ref<AmUser | null>(null)
const editUserRoles = ref<string[]>([])
const userRolesDirty = ref(false)

const showCreateRole = ref(false)
const newRoleName = ref('')
const newRoleDesc = ref('')
const editRole = ref<Role | null>(null)
const editRoleName = ref('')
const editRoleDesc = ref('')
const editRoleActive = ref(true)
const deleteRoleTarget = ref<Role | null>(null)

// Duplicate-action guards. Keyed locks serialize mutations per entity
// (role / user / role+folder) across every button and dialog that can
// trigger them; different entities never block each other.
const roleOps = useKeyedActions()
const userOps = useKeyedActions()
const folderOps = useKeyedActions()

const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
let toastTimer = 0

function notify(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = null), 4000)
}

// --- computed ---------------------------------------------------------------
const selectedRole = computed(() => roles.value.find((r) => r.id === selectedRoleId.value) ?? null)
const isSuperAdminRole = computed(() => selectedRole.value?.name === 'super_admin')

const modules = computed(() => {
  const byModule = new Map<string, RegistryPermission[]>()
  for (const p of registry.value) {
    if (!byModule.has(p.module)) byModule.set(p.module, [])
    byModule.get(p.module)!.push(p)
  }
  return [...byModule.entries()].map(([module, perms]) => ({
    module,
    label: perms[0]?.module_label || module,
    perms,
  }))
})

const rootFolders = computed(() => folders.value.filter((f) => f.parent_id === null))
const selectedFolder = computed(() => folders.value.find((f) => f.id === selectedFolderId.value) ?? null)

const usersWithRole = computed(() => {
  if (!selectedRole.value) return []
  return users.value.filter((u) => u.roles.includes(selectedRole.value!.name))
})

function childrenOf(parentId: number | null): FolderRow[] {
  return folders.value.filter((f) => f.parent_id === parentId)
}

function folderChain(id: number): FolderRow[] {
  const chain: FolderRow[] = []
  let cur = folders.value.find((f) => f.id === id)
  while (cur) {
    chain.unshift(cur)
    cur = cur.parent_id ? folders.value.find((f) => f.id === cur!.parent_id) : undefined
  }
  return chain
}

// --- data loading -----------------------------------------------------------
async function loadRoles(): Promise<void> {
  rolesLoading.value = true
  try {
    const resp = await axios.get('/api/access-management/roles')
    roles.value = resp.data.roles
    if (!selectedRoleId.value && roles.value.length) {
      selectedRoleId.value = roles.value[0].id
    }
  } catch (err) {
    notify('error', errMsg(err, 'access.loadRolesFailed'))
  } finally {
    rolesLoading.value = false
  }
}

async function loadRolePermissions(): Promise<void> {
  if (!selectedRoleId.value) return
  permsLoading.value = true
  permsDirty.value = false
  try {
    const resp = await axios.get(`/api/access-management/roles/${selectedRoleId.value}/permissions`)
    registry.value = resp.data.registry
    granted.value = new Set(resp.data.permissions)
    draftPerms.value = new Set(resp.data.permissions)
  } catch (err) {
    notify('error', errMsg(err, 'access.loadPermissionsFailed'))
  } finally {
    permsLoading.value = false
  }
}

async function loadFolders(): Promise<void> {
  try {
    const resp = await axios.get('/api/storage/folders')
    folders.value = resp.data.folders.map((f: { id: number; parent_id: number | null; name: string }) => ({
      id: f.id,
      parent_id: f.parent_id,
      name: f.name,
    }))
    // Fetch explicit permission rows for the selected role across all folders.
    if (selectedRoleId.value) {
      const detail = await axios.get(`/api/access-management/roles/${selectedRoleId.value}/folder-permissions`)
      folderExplicit.value = detail.data.permissions || {}
    }
  } catch (err) {
    notify('error', errMsg(err, 'access.loadFoldersFailed'))
  }
}

function computeInherited(folderId: number): Partial<FolderPerms> {
  // Effective perms inherited from ancestors (nearest explicit row upward).
  const chain = folderChain(folderId)
  for (let i = chain.length - 2; i >= 0; i--) {
    const row = folderExplicit.value[chain[i].id]
    if (row) return row
  }
  return {}
}

async function loadUsers(): Promise<void> {
  usersLoading.value = true
  try {
    const resp = await axios.get('/api/access-management/users', { params: { search: usersSearch.value } })
    users.value = resp.data.users
  } catch (err) {
    notify('error', errMsg(err, 'access.loadUsersFailed'))
  } finally {
    usersLoading.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadRoles(), loadUsers()])
  if (selectedRoleId.value) await Promise.all([loadRolePermissions(), loadFolders()])
})

watch(selectedRoleId, async () => {
  tab.value = 'modules'
  await Promise.all([loadRolePermissions(), loadFolders()])
  selectedFolderId.value = null
  folderDraft.value = null
})

watch(selectedFolderId, () => {
  if (!selectedFolderId.value || !selectedRoleId.value) {
    folderDraft.value = null
    return
  }
  const explicit = folderExplicit.value[selectedFolderId.value]
  if (explicit) {
    folderDraft.value = { ...explicit }
  } else {
    const inherited = computeInherited(selectedFolderId.value)
    folderDraft.value = {
      can_view: false, can_create_folder: false, can_upload: false, can_download: false,
      can_preview: false, can_rename: false, can_move: false, can_delete: false,
      can_manage_permissions: false,
      ...inherited,
    }
  }
  folderDirty.value = false
})

// --- actions ----------------------------------------------------------------
function togglePerm(key: string): void {
  if (isSuperAdminRole.value) return
  if (draftPerms.value.has(key)) draftPerms.value.delete(key)
  else draftPerms.value.add(key)
  permsDirty.value = !setsEqual(draftPerms.value, granted.value)
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function moduleAllChecked(module: string): boolean {
  return modules.value.find((m) => m.module === module)!.perms.every((p) => draftPerms.value.has(p.key))
}

function toggleModuleAll(module: string): void {
  const mods = modules.value.find((m) => m.module === module)!
  if (moduleAllChecked(module)) mods.perms.forEach((p) => draftPerms.value.delete(p.key))
  else mods.perms.forEach((p) => draftPerms.value.add(p.key))
  permsDirty.value = !setsEqual(draftPerms.value, granted.value)
}

const savePermsAction = useAsyncAction(async (): Promise<void> => {
  if (!selectedRoleId.value) return
  try {
    await axios.put(`/api/access-management/roles/${selectedRoleId.value}/permissions`, {
      permissions: [...draftPerms.value],
    })
    granted.value = new Set(draftPerms.value)
    permsDirty.value = false
    await loadRoles()
    notify('success', t('access.permissionsSaved', { role: selectedRole.value?.name ?? '' }))
  } catch (err) {
    notify('error', errMsg(err, 'access.saveFailed'))
  }
})

function discardPermissions(): void {
  draftPerms.value = new Set(granted.value)
  permsDirty.value = false
}

function toggleFolderCap(key: keyof FolderPerms): void {
  if (!folderDraft.value) return
  folderDraft.value[key] = !folderDraft.value[key] as never
  folderDirty.value = true
}

function folderKey(): string {
  return `${selectedRoleId.value}:${selectedFolderId.value}`
}

async function saveFolderPermissions(): Promise<void> {
  if (!selectedFolderId.value || !selectedRoleId.value || !folderDraft.value) return
  try {
    const payload: Record<string, unknown> = { role_id: selectedRoleId.value }
    for (const cap of FOLDER_CAPS) payload[cap.key] = folderDraft.value[cap.key]
    await axios.put(`/api/storage/folders/${selectedFolderId.value}/permissions`, { permissions: [payload] })
    folderExplicit.value = { ...folderExplicit.value, [selectedFolderId.value]: { ...folderDraft.value } }
    folderDirty.value = false
    notify('success', t('access.folderPermissionsSaved', { folder: selectedFolder.value?.name ?? '' }))
  } catch (err) {
    notify('error', errMsg(err, 'access.saveFailed'))
  }
}

async function resetFolderOverride(): Promise<void> {
  if (!selectedFolderId.value) return
  try {
    const payload: Record<string, unknown> = { role_id: selectedRoleId.value }
    for (const cap of FOLDER_CAPS) payload[cap.key] = false
    await axios.put(`/api/storage/folders/${selectedFolderId.value}/permissions`, { permissions: [payload] })
    delete folderExplicit.value[selectedFolderId.value]
    const inherited = computeInherited(selectedFolderId.value)
    folderDraft.value = {
      can_view: false, can_create_folder: false, can_upload: false, can_download: false,
      can_preview: false, can_rename: false, can_move: false, can_delete: false,
      can_manage_permissions: false,
      ...inherited,
    }
    folderDirty.value = false
    notify('success', t('access.overrideRemoved'))
  } catch (err) {
    notify('error', errMsg(err, 'access.resetFailed'))
  }
}

const createRoleAction = useAsyncAction(async (): Promise<void> => {
  if (!newRoleName.value.trim()) return
  try {
    const resp = await axios.post('/api/access-management/roles', {
      name: newRoleName.value.trim(),
      description: newRoleDesc.value.trim() || null,
    })
    showCreateRole.value = false
    newRoleName.value = ''
    newRoleDesc.value = ''
    await loadRoles()
    selectedRoleId.value = resp.data.role.id
    notify('success', t('access.roleCreated'))
  } catch (err) {
    notify('error', errMsg(err, 'access.createFailed'))
  }
})

async function saveRoleEdit(target: Role): Promise<void> {
  try {
    await axios.put(`/api/access-management/roles/${target.id}`, {
      name: editRoleName.value,
      description: editRoleDesc.value || null,
      is_active: editRoleActive.value,
    })
    editRole.value = null
    await loadRoles()
    notify('success', t('access.roleUpdated'))
  } catch (err) {
    notify('error', errMsg(err, 'access.updateFailed'))
  }
}

async function doDeleteRole(target: Role): Promise<void> {
  try {
    await axios.delete(`/api/access-management/roles/${target.id}`)
    if (selectedRoleId.value === target.id) selectedRoleId.value = null
    deleteRoleTarget.value = null
    await loadRoles()
    notify('success', t('access.roleDeleted'))
  } catch (err) {
    notify('error', errMsg(err, 'access.deleteFailed'))
  }
}

async function saveUserRoles(target: AmUser): Promise<void> {
  try {
    await axios.put(`/api/access-management/users/${target.id}/roles`, { roles: editUserRoles.value })
    await loadUsers()
    userRolesDirty.value = false
    editUser.value = null
    notify('success', t('access.userRolesUpdated'))
  } catch (err) {
    notify('error', errMsg(err, 'access.updateFailed'))
  }
}

async function toggleUserActive(user: AmUser): Promise<void> {
  try {
    await axios.put(`/api/access-management/users/${user.id}/active`, { is_active: !user.is_active })
    await loadUsers()
    notify('success', user.is_active ? t('access.userDeactivated') : t('access.userActivated'))
  } catch (err) {
    notify('error', errMsg(err, 'access.updateFailed'))
  }
}

function toggleRoleInEdit(name: string): void {
  const idx = editUserRoles.value.indexOf(name)
  if (idx >= 0) editUserRoles.value.splice(idx, 1)
  else editUserRoles.value.push(name)
  userRolesDirty.value = true
}

function moduleExpanded(module: string): boolean {
  return modulesExpanded.value.has(module)
}

function foldersExpandedToggle(module: string): void {
  if (modulesExpanded.value.has(module)) modulesExpanded.value.delete(module)
  else modulesExpanded.value.add(module)
}

function errMsg(err: unknown, fallback: MessageKey): string {
  return apiErrorMessage(err, fallback)
}

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  if (permsDirty.value || folderDirty.value || userRolesDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
window.addEventListener('beforeunload', beforeUnloadGuard)
</script>

<template>
  <div class="flex min-h-[calc(100vh-3.5rem)] flex-col">
    <!-- Header -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">{{ t('access.title') }}</h1>
        <p class="text-sm text-slate-500">{{ t('access.subtitle') }}</p>
      </div>
      <button class="btn btn-primary" @click="showCreateRole = true">
        <Plus :size="16" /> {{ t('access.newRole') }}
      </button>
    </div>

    <!-- Toast -->
    <Teleport to="body">
      <div
        v-if="toast"
        class="fixed bottom-4 right-4 z-[70] flex max-w-sm items-center gap-2.5 rounded-xl border p-3.5 shadow-lg"
        :class="toast.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'"
      >
        <Check v-if="toast.kind === 'success'" :size="18" />
        <AlertTriangle v-else :size="18" />
        <p class="text-sm">{{ toast.message }}</p>
      </div>
    </Teleport>

    <div class="flex flex-1 flex-col gap-4 lg:flex-row">
      <!-- Left: roles list -->
      <aside class="w-full shrink-0 lg:w-72">
        <div class="card p-3">
          <p class="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            {{ t('access.rolesCount', { count: formatNumber(roles.length) }) }}
          </p>
          <div v-if="rolesLoading" class="flex justify-center py-6 text-slate-400">
            <Loader2 :size="22" class="animate-spin" />
          </div>
          <ul v-else class="space-y-1">
            <li v-for="role in roles" :key="role.id">
              <button
                class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition"
                :class="
                  selectedRoleId === role.id
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100'
                "
                @click="selectedRoleId = role.id"
              >
                <ShieldCheck :size="16" class="shrink-0" :class="role.is_active ? 'text-indigo-500' : 'text-slate-300'" />
                <div class="min-w-0 flex-1">
                  <p class="truncate font-semibold capitalize">{{ role.name.replace(/_/g, ' ') }}</p>
                  <p class="text-xs text-slate-400">
                    {{ tn(role.user_count, 'access.usersOne', 'access.usersOther') }} ·
                    {{ tn(role.permission_count, 'access.permsOne', 'access.permsOther') }}
                    <span v-if="!role.is_active" class="font-semibold text-rose-400">· {{ t('access.inactive') }}</span>
                  </p>
                </div>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <!-- Right: detail panel -->
      <div class="min-w-0 flex-1">
        <div v-if="!selectedRole" class="card flex items-center justify-center p-16 text-sm text-slate-400">
          {{ t('access.selectRole') }}
        </div>

        <div v-else class="card p-4 sm:p-5">
          <!-- Role header -->
          <div class="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 class="flex items-center gap-2 text-base font-bold capitalize text-slate-900">
                {{ selectedRole.name.replace(/_/g, ' ') }}
                <span v-if="selectedRole.is_system" class="chip bg-amber-100 text-amber-700">{{ t('access.system') }}</span>
                <span v-if="!selectedRole.is_active" class="chip bg-rose-100 text-rose-700">{{ t('access.inactive') }}</span>
              </h2>
              <p v-if="selectedRole.description" class="text-xs text-slate-500">{{ localizeRoleDescription(selectedRole.description) }}</p>
            </div>
            <div class="flex gap-2">
              <button class="btn btn-secondary px-3 py-1.5" :disabled="roleOps.isBusy(selectedRole.id)" @click="editRole = selectedRole; editRoleName = selectedRole.name; editRoleDesc = selectedRole.description || ''; editRoleActive = !!selectedRole.is_active">
                <Pencil :size="14" /> {{ t('common.edit') }}
              </button>
              <LoadingButton
                v-if="!selectedRole.is_system"
                class="btn btn-secondary px-3 py-1.5 text-rose-600 hover:bg-rose-50"
                :spinner-size="14"
                :loading-text="t('common.deleting')"
                :loading="roleOps.isPending(selectedRole.id, 'delete')"
                :disabled="roleOps.isBusy(selectedRole.id)"
                @click="deleteRoleTarget = selectedRole"
              >
                <Trash2 :size="14" /> {{ t('common.delete') }}
              </LoadingButton>
            </div>
          </div>

          <!-- Tabs -->
          <div class="mb-4 flex gap-1 border-b border-slate-200">
            <button
              v-for="tabItem in TABS"
              :key="tabItem.key"
              class="-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition"
              :class="tab === tabItem.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'"
              @click="tab = tabItem.key"
            >
              {{ t(tabItem.label) }}
            </button>
          </div>

          <!-- TAB: module permissions -->
          <div v-if="tab === 'modules'">
            <div v-if="isSuperAdminRole" class="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
              <strong>super_admin</strong> {{ t('access.superAdminNoteAfter') }}
            </div>
            <div v-else-if="permsLoading" class="flex justify-center py-10 text-slate-400">
              <Loader2 :size="24" class="animate-spin" />
            </div>
            <div v-else>
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p class="text-xs text-slate-500">
                  {{ t('access.grantedSummary', { granted: formatNumber(draftPerms.size), total: formatNumber(registry.length) }) }}
                </p>
                <div class="flex gap-2">
                  <button v-if="permsDirty" class="btn btn-ghost px-3 py-1.5 text-xs" :disabled="savePermsAction.pending" @click="discardPermissions">
                    {{ t('access.discardChanges') }}
                  </button>
                  <LoadingButton
                    class="btn btn-primary px-4 py-1.5"
                    :spinner-size="14"
                    :loading-text="t('common.saving')"
                    :loading="savePermsAction.pending"
                    :disabled="!permsDirty"
                    @click="savePermsAction.run()"
                  >
                    {{ t('access.savePermissions') }}
                  </LoadingButton>
                </div>
              </div>
              <p v-if="permsDirty" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {{ t('access.unsavedChanges') }}
              </p>

              <div v-for="mod in modules" :key="mod.module" class="mb-3 overflow-hidden rounded-xl border border-slate-200">
                <div class="flex items-center justify-between bg-slate-50 px-4 py-2.5">
                  <button class="flex items-center gap-2 text-sm font-bold text-slate-700" @click="foldersExpandedToggle(mod.module)">
                    <component :is="moduleExpanded(mod.module) ? ChevronDown : ChevronRight" :size="15" />
                    {{ moduleText(mod.module, mod.label) }}
                  </button>
                  <label class="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-500">
                    <input
                      type="checkbox"
                      class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                      :checked="moduleAllChecked(mod.module)"
                      @change="toggleModuleAll(mod.module)"
                    />
                    {{ t('common.all') }}
                  </label>
                </div>
                <div v-if="moduleExpanded(mod.module)">
                  <label
                    v-for="perm in mod.perms"
                    :key="perm.key"
                    class="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      class="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600"
                      :checked="draftPerms.has(perm.key)"
                      @change="togglePerm(perm.key)"
                    />
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-medium text-slate-800">{{ permText(perm, 'feature') }}</p>
                      <p class="text-xs text-slate-400">{{ permText(perm, 'description') }}</p>
                    </div>
                    <span class="chip shrink-0 bg-slate-100 text-slate-500">{{ actionText(perm.action) }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: folder permissions -->
          <div v-if="tab === 'folders'">
            <p class="mb-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
              {{ t('access.folderInfo') }}
            </p>
            <div class="flex flex-col gap-4 sm:flex-row">
              <!-- Folder tree -->
              <div class="w-full overflow-auto rounded-xl border border-slate-200 p-2 sm:max-h-[420px] sm:w-64">
                <p class="px-2 py-1 text-xs font-bold uppercase tracking-wide text-slate-400">{{ t('access.folders') }}</p>
                <button
                  v-for="f in rootFolders"
                  :key="f.id"
                  class="w-full"
                  :style="{ paddingLeft: '4px' }"
                  @click="selectedFolderId = f.id"
                >
                  <div
                    class="my-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm"
                    :class="selectedFolderId === f.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'"
                  >
                    <Folder :size="15" class="shrink-0 text-amber-500" />
                    <span class="truncate">{{ f.name }}</span>
                    <span v-if="folderExplicit[f.id]" class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" :title="t('access.explicitOverrideTitle')" />
                  </div>
                </button>
              </div>

              <!-- Folder detail -->
              <div class="min-w-0 flex-1">
                <div v-if="!selectedFolderId" class="py-12 text-center text-sm text-slate-400">
                  {{ t('access.selectFolder', { role: selectedRole.name }) }}
                </div>
                <div v-else-if="!folderDraft">
                  <Loader2 :size="22" class="mx-auto animate-spin text-slate-400" />
                </div>
                <div v-else>
                  <div class="mb-3 flex items-center gap-2">
                    <FolderOpen :size="18" class="text-amber-500" />
                    <p class="font-semibold text-slate-800">{{ selectedFolder?.name }}</p>
                    <span v-if="folderExplicit[selectedFolderId]" class="chip bg-indigo-100 text-indigo-700">{{ t('access.explicitOverride') }}</span>
                    <span v-else class="chip bg-slate-100 text-slate-500">{{ t('access.inheriting') }}</span>
                  </div>

                  <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <label
                      v-for="cap in FOLDER_CAPS"
                      :key="cap.key"
                      class="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm"
                      :class="folderDraft[cap.key] ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600'"
                    >
                      <input
                        type="checkbox"
                        class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                        :checked="folderDraft[cap.key]"
                        @change="toggleFolderCap(cap.key)"
                      />
                      {{ t(cap.label) }}
                    </label>
                  </div>

                  <div class="mt-4 flex flex-wrap gap-2">
                    <LoadingButton
                      class="btn btn-primary px-4 py-1.5"
                      :spinner-size="14"
                      :loading-text="t('common.saving')"
                      :loading="folderOps.isPending(folderKey(), 'save')"
                      :disabled="!folderDirty || folderOps.isBusy(folderKey())"
                      @click="folderOps.run(folderKey(), 'save', saveFolderPermissions)"
                    >
                      {{ t('access.saveFolderPermissions') }}
                    </LoadingButton>
                    <LoadingButton
                      v-if="folderExplicit[selectedFolderId]"
                      class="btn btn-secondary px-4 py-1.5"
                      :spinner-size="14"
                      :loading-text="t('common.resetting')"
                      :loading="folderOps.isPending(folderKey(), 'reset')"
                      :disabled="folderOps.isBusy(folderKey())"
                      @click="folderOps.run(folderKey(), 'reset', resetFolderOverride)"
                    >
                      <RefreshCw :size="14" /> {{ t('access.resetToInherit') }}
                    </LoadingButton>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: assigned users -->
          <div v-if="tab === 'users'">
            <div class="mb-3 flex items-center justify-between gap-2">
              <p class="text-xs text-slate-500">{{ t('access.usersWithRole', { count: formatNumber(usersWithRole.length) }) }}</p>
              <button class="btn btn-secondary px-3 py-1.5 text-xs" :disabled="usersLoading" :aria-busy="usersLoading ? 'true' : undefined" @click="loadUsers()">
                <RefreshCw :size="13" :class="{ 'animate-spin': usersLoading }" /> {{ t('common.refresh') }}
              </button>
            </div>
            <div v-if="usersLoading" class="flex justify-center py-8 text-slate-400">
              <Loader2 :size="22" class="animate-spin" />
            </div>
            <div v-else-if="!usersWithRole.length" class="py-8 text-center text-sm text-slate-400">
              {{ t('access.noUsersWithRole') }}
            </div>
            <ul v-else class="divide-y divide-slate-100 rounded-xl border border-slate-200">
              <li v-for="u in usersWithRole" :key="u.id" class="flex items-center gap-3 px-4 py-3">
                <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                  {{ u.full_name.split(' ').slice(0, 2).map((p: string) => p[0]).join('').toUpperCase() }}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold text-slate-800">{{ u.full_name }}</p>
                  <p class="truncate text-xs text-slate-400">@{{ u.username }} · {{ u.roles.join(', ') || t('access.noRoles') }}</p>
                </div>
                <button class="btn btn-ghost px-2.5 py-1 text-xs" :disabled="userOps.isBusy(u.id)" @click="editUser = u; editUserRoles = [...u.roles]; userRolesDirty = false">
                  <Users :size="13" /> {{ t('accounts.roles') }}
                </button>
                <LoadingButton
                  class="btn px-2.5 py-1 text-xs"
                  :class="u.is_active ? 'btn-ghost text-amber-600' : 'btn-ghost text-emerald-600'"
                  :spinner-size="13"
                  :loading-text="u.is_active ? t('accounts.deactivating') : t('accounts.activating')"
                  :loading="userOps.isPending(u.id, 'active')"
                  :disabled="u.id === authStore.state.user?.id || userOps.isBusy(u.id)"
                  @click="userOps.run(u.id, 'active', () => toggleUserActive(u))"
                >
                  {{ u.is_active ? t('accounts.deactivate') : t('accounts.activate') }}
                </LoadingButton>
              </li>
            </ul>

            <!-- All users quick search for assignment -->
            <div class="mt-5 border-t border-slate-100 pt-4">
              <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{{ t('access.assignUsers') }}</p>
              <div class="relative mb-3">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
                <input v-model="usersSearch" class="input py-2 pl-9 text-sm" :placeholder="t('access.searchUsers')" @keyup.enter="!usersLoading && loadUsers()" />
              </div>
              <ul class="max-h-56 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200">
                <li v-for="u in users" :key="u.id" class="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-medium text-slate-700">{{ u.full_name }} <span class="text-xs text-slate-400">@{{ u.username }}</span></p>
                  </div>
                  <button
                    v-if="!u.roles.includes(selectedRole.name)"
                    class="btn btn-secondary px-2.5 py-1 text-xs"
                    :disabled="userOps.isBusy(u.id)"
                    @click="editUser = u; editUserRoles = [...u.roles, selectedRole.name]; userRolesDirty = true"
                  >
                    <UserPlus :size="13" /> {{ t('access.assign') }}
                  </button>
                  <span v-else class="text-xs font-semibold text-emerald-600">{{ t('access.hasRole') }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Dialogs -->
    <!-- Create role -->
    <Teleport to="body">
      <div v-if="showCreateRole" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="showCreateRole = false">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('access.newRole') }}</h3>
          <div class="space-y-4">
            <div>
              <label class="label" for="role-name">{{ t('access.roleName') }}</label>
              <input id="role-name" v-model="newRoleName" class="input" :placeholder="t('access.roleNamePlaceholder')" maxlength="49" autofocus />
              <p class="mt-1 text-xs text-slate-400">{{ t('access.roleNameHint') }}</p>
            </div>
            <div>
              <label class="label" for="role-desc">{{ t('access.descriptionOptional') }}</label>
              <input id="role-desc" v-model="newRoleDesc" class="input" maxlength="200" />
            </div>
            <p class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {{ t('access.newRoleNoteBefore') }} <strong>{{ t('access.newRoleNoteStrong') }}</strong>{{ t('access.newRoleNoteAfter') }}
            </p>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="showCreateRole = false">{{ t('common.cancel') }}</button>
              <LoadingButton
                class="btn btn-primary"
                :loading-text="t('common.creating')"
                :loading="createRoleAction.pending"
                :disabled="!newRoleName.trim()"
                @click="createRoleAction.run()"
              >
                {{ t('common.create') }}
              </LoadingButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit role -->
    <Teleport to="body">
      <div v-if="editRole" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="editRole = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('access.editRole') }}</h3>
          <div class="space-y-4">
            <div>
              <label class="label" for="edit-role-name">{{ t('access.roleName') }}</label>
              <input id="edit-role-name" v-model="editRoleName" class="input" :disabled="editRole.is_system" maxlength="49" />
            </div>
            <div>
              <label class="label" for="edit-role-desc">{{ t('access.description') }}</label>
              <input id="edit-role-desc" v-model="editRoleDesc" class="input" maxlength="200" />
            </div>
            <label v-if="!editRole.is_system" class="flex items-center gap-2.5 text-sm text-slate-700">
              <input v-model="editRoleActive" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-indigo-600" />
              {{ t('access.activeRoleLabel') }}
            </label>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="editRole = null">{{ t('common.cancel') }}</button>
              <LoadingButton
                class="btn btn-primary"
                :loading-text="t('common.saving')"
                :loading="roleOps.isPending(editRole.id, 'edit')"
                :disabled="roleOps.isBusy(editRole.id)"
                @click="roleOps.run(editRole.id, 'edit', () => saveRoleEdit(editRole!))"
              >
                {{ t('common.save') }}
              </LoadingButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete role confirm -->
    <Teleport to="body">
      <div v-if="deleteRoleTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="deleteRoleTarget = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-rose-700">{{ t('access.deleteRoleTitle') }}</h3>
          <p class="text-sm text-slate-600">
            "<strong class="capitalize">{{ deleteRoleTarget.name.replace(/_/g, ' ') }}</strong>"
            <template v-if="deleteRoleTarget.user_count > 0">
              {{ t('access.deleteRoleStillAssigned', { count: formatNumber(deleteRoleTarget.user_count) }) }}
            </template>
            <template v-else>{{ t('access.deleteRoleWillRemove') }}</template>
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="deleteRoleTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-danger"
              :loading-text="t('common.deleting')"
              :loading="roleOps.isPending(deleteRoleTarget.id, 'delete')"
              :disabled="deleteRoleTarget.user_count > 0 || roleOps.isBusy(deleteRoleTarget.id)"
              @click="roleOps.run(deleteRoleTarget.id, 'delete', () => doDeleteRole(deleteRoleTarget!))"
            >
              {{ t('common.delete') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit user roles -->
    <Teleport to="body">
      <div v-if="editUser" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="editUser = null">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-1">{{ t('access.userRoles') }}</h3>
          <p class="mb-4 text-sm text-slate-500">{{ editUser.full_name }} (@{{ editUser.username }})</p>
          <div class="space-y-2">
            <label
              v-for="role in roles"
              :key="role.id"
              class="flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm"
              :class="editUserRoles.includes(role.name) ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600'"
            >
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                :checked="editUserRoles.includes(role.name)"
                :disabled="role.name === 'super_admin' && editUser.roles.includes('super_admin')"
                @change="toggleRoleInEdit(role.name)"
              />
              <span class="font-medium capitalize">{{ role.name.replace(/_/g, ' ') }}</span>
            </label>
          </div>
          <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {{ t('access.userRolesNote') }}
          </p>
          <div class="mt-4 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="editUser = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-primary"
              :loading-text="t('common.saving')"
              :loading="userOps.isPending(editUser.id, 'roles')"
              :disabled="userOps.isBusy(editUser.id)"
              @click="userOps.run(editUser.id, 'roles', () => saveUserRoles(editUser!))"
            >
              {{ t('accounts.saveRoles') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* helpers used by the module accordion */
</style>
