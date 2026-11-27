<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ArrowUpDown,
  ChevronRight,
  FileArchive,
  FileSpreadsheet,
  FolderPlus,
  Folder,
  Grid3X3,
  HardDrive,
  List,
  Loader2,
  MoreVertical,
  PackageOpen,
  Pencil,
  FolderInput,
  Shield,
  Trash2,
  Upload,
  Search,
  X,
} from 'lucide-vue-next'
import { storageStore } from '../stores/storage'
import { authStore } from '../stores/auth'
import FolderTree from '../components/storage/FolderTree.vue'
import FileIcon from '../components/storage/FileIcon.vue'
import FilePreviewModal from '../components/storage/FilePreviewModal.vue'
import PermissionModal from '../components/storage/PermissionModal.vue'
import ToastStack from '../components/storage/ToastStack.vue'
import LoadingButton from '../components/LoadingButton.vue'
import BulkFolderDialog from '../components/storage/BulkFolderDialog.vue'
import MoveDialog from '../components/storage/MoveDialog.vue'
import type { MoveContext } from '../lib/folderTree'
import {
  clearSelection,
  clickItem,
  emptySelection,
  modifiersOf,
  moveActive,
  selectAll,
  selectAllState,
  selectedInOrder,
  syncSelection,
  toggleActive,
  toggleAll,
  type NavKey,
  type SelectionState,
} from '../lib/selection'
import { useAsyncAction, useKeyedActions } from '../composables/useAsyncAction'
import { formatNumber, t, tn, type MessageKey } from '../i18n'
import { apiErrorMessage, localizeMessage } from '../i18n/systemMessages'
import {
  deleteFile,
  deleteFolder,
  formatBytes,
  downloadAllUrl,
  formatDate,
  getDownloadAllSummary,
  getSelectionDownloadSummary,
  selectionDownloadUrl,
  getDownloadUrl,
  bulkDelete,
  updateFile,
  updateFolder,
  type StorageFile,
  type StorageFolder,
} from '../lib/storageApi'

const store = storageStore
const auth = authStore

// -- state -------------------------------------------------------------------
const showCreateFolder = ref(false)
const newFolderName = ref('')
const newFolderDesc = ref('')
const renameTarget = ref<StorageFolder | null>(null)
const renameValue = ref('')
const moveTarget = ref<StorageFolder | null>(null)
const fileRenameTarget = ref<StorageFile | null>(null)
const fileRenameValue = ref('')
const fileMoveTarget = ref<StorageFile | null>(null)
const fileDeleteTarget = ref<StorageFile | null>(null)
const folderDeleteTarget = ref<StorageFolder | null>(null)
const previewFile = ref<StorageFile | null>(null)
const permissionFolder = ref<StorageFolder | null>(null)
// Duplicate-action guards: one lock per folder / per file covers every menu,
// dialog and Enter-key path that mutates it; downloads have their own lock so
// they never block (or get blocked by) edits of other items.
const folderOps = useKeyedActions()
const fileOps = useKeyedActions()
const downloadOps = useKeyedActions()
const searchInput = ref('')
const dragOver = ref(false)
const searchDebounce = ref<number>(0)
const openMenuId = ref<string | null>(null)
const mobileTreeOpen = ref(false)

// -- computed ----------------------------------------------------------------
const isRoot = computed(() => store.state.currentFolderId === 'root')
const currentPerms = computed(() => {
  if (isRoot.value) return null
  return store.state.folders.find((f) => f.id === store.state.currentFolderId)?.permissions ?? null
})

const canUpload = computed(() => {
  if (isRoot.value) return false
  return currentPerms.value?.can_upload ?? false
})

const canCreateFolder = computed(() => {
  if (isRoot.value) return auth.isSuperAdmin
  return currentPerms.value?.can_create_folder ?? false
})

const canManagePerms = computed(() => {
  if (isRoot.value) return false
  return currentPerms.value?.can_manage_permissions ?? false
})

const visibleFolders = computed(() => {
  if (isRoot.value) return store.state.folders.filter((f) => f.parent_id === null)
  return store.childrenOf(Number(store.state.currentFolderId))
})

const fileCaps = computed(() => store.state.capabilities)

const totalPages = computed(() =>
  Math.max(1, Math.ceil(store.state.filesTotal / store.state.filesPageSize))
)

const sortOptions: Array<{ value: string; label: MessageKey }> = [
  { value: 'created_at', label: 'storage.sortUploadDate' },
  { value: 'file_name', label: 'storage.sortName' },
  { value: 'file_size', label: 'storage.sortSize' },
  { value: 'uploader', label: 'storage.sortUploader' },
]

// -- lifecycle ---------------------------------------------------------------
onMounted(async () => {
  await Promise.all([store.refreshFolders(), store.navigateTo('root')])
})

watch(searchInput, (q) => {
  window.clearTimeout(searchDebounce.value)
  searchDebounce.value = window.setTimeout(() => {
    store.setSearch(q)
    void store.refreshFiles()
  }, 350)
})

function closeAllMenus(): void {
  openMenuId.value = null
}

// -- multi-select (folders + files of the view; rules in lib/selection.ts) ---------------
const selection = ref<SelectionState>(emptySelection())
const folderKey = (id: number) => `folder:${id}`
const fileKey = (id: number) => `file:${id}`
/** Display order: folders, then files (the same order as on screen, in both views). */
const itemKeys = computed(() => [...visibleFolders.value.map((f) => folderKey(f.id)), ...store.state.files.map((f) => fileKey(f.id))])
watch(itemKeys, (keys) => {
  selection.value = syncSelection(selection.value, keys)
})
watch(
  () => store.state.currentFolderId,
  () => {
    selection.value = emptySelection()
  }
)
const isSelected = (key: string) => selection.value.selected.has(key)
const isActive = (key: string) => selection.value.active !== null && itemKeys.value[selection.value.active] === key
/** Roving tabindex: only the active item (or the first one) is in the Tab order. */
const tabIndexOf = (key: string) => (isActive(key) || (selection.value.active === null && itemKeys.value[0] === key) ? 0 : -1)
const allState = computed(() => selectAllState(selection.value, itemKeys.value))
const selectedKeys = computed(() => selectedInOrder(selection.value, itemKeys.value))
const selectedFolders = computed(() => visibleFolders.value.filter((f) => isSelected(folderKey(f.id))))
const selectedFiles = computed(() => store.state.files.filter((f) => isSelected(fileKey(f.id))))
const selectionCan = (cap: 'can_download' | 'can_move' | 'can_delete') =>
  selectedKeys.value.length > 0 &&
  selectedFolders.value.every((f) => f.permissions[cap]) &&
  (!selectedFiles.value.length || Boolean(fileCaps.value?.[cap]))
const canBulkDownload = computed(() => selectionCan('can_download'))
const canBulkMove = computed(() => selectionCan('can_move'))
const canBulkDelete = computed(() => selectionCan('can_delete'))

function focusActive(): void {
  const i = selection.value.active
  if (i === null) return
  const key = itemKeys.value[i]
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-item-key="${key}"]`)
    el?.focus({ preventScroll: false })
    el?.scrollIntoView({ block: 'nearest' })
  })
}
/** Item click: plain / Ctrl·Cmd / Shift (see lib/selection.ts). */
function onItemClick(e: MouseEvent, key: string): void {
  closeAllMenus()
  if (e.shiftKey) window.getSelection()?.removeAllRanges() // no text selection on Shift+click
  selection.value = clickItem(selection.value, itemKeys.value, itemKeys.value.indexOf(key), modifiersOf(e))
  focusActive()
}
/** Checkbox: toggles (like Ctrl/Cmd+click); Shift+checkbox selects a range. */
function onCheckboxClick(e: MouseEvent, key: string): void {
  const mods = modifiersOf(e)
  selection.value = clickItem(selection.value, itemKeys.value, itemKeys.value.indexOf(key), { shift: mods.shift, ctrl: true })
  focusActive()
}
function openItem(key: string): void {
  const [kind, raw] = key.split(':')
  const id = Number(raw)
  if (kind === 'folder') void store.navigateTo(id)
  else {
    const file = store.state.files.find((f) => f.id === id)
    if (file) previewFile.value = file
  }
}
const NAV_KEYS: NavKey[] = ['ArrowUp', 'ArrowDown', 'Home', 'End']
/** Keyboard on a focused item: arrows (+Shift / Ctrl·Cmd), Space, Enter, Ctrl/Cmd+A, Esc. */
function onItemKeydown(e: KeyboardEvent): void {
  const mods = modifiersOf(e)
  if ((NAV_KEYS as string[]).includes(e.key)) {
    e.preventDefault()
    selection.value = moveActive(selection.value, itemKeys.value, e.key as NavKey, mods)
    focusActive()
  } else if (e.key === ' ') {
    e.preventDefault()
    selection.value = toggleActive(selection.value, itemKeys.value)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const i = selection.value.active
    if (i !== null) openItem(itemKeys.value[i])
  } else if (mods.ctrl && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selection.value = selectAll(selection.value, itemKeys.value)
  } else if (e.key === 'Escape') {
    selection.value = clearSelection(selection.value)
  }
}
function onSelectAll(): void {
  selection.value = toggleAll(selection.value, itemKeys.value)
}
function clearAll(): void {
  selection.value = clearSelection(selection.value)
}

// -- bulk actions on the selection -----------------------------------------------------
const bulkDeleteOpen = ref(false)
const bulkMoveOpen = ref(false)
const bulkBusy = ref(false)

/**
 * Move dialog context (lib/folderTree.ts): what is moved, where it is now.
 * The picker disables the moved folders, their sub-folders, the current
 * location and folders without the needed permission.
 */
function moveCtx(movingFolderIds: number[], movingFiles: boolean, sourceParentIds: Array<number | null>): MoveContext {
  return { folders: store.state.folders, movingFolderIds, movingFiles, sourceParentIds, isSuperAdmin: auth.isSuperAdmin }
}
const currentParentId = computed<number | null>(() => (isRoot.value ? null : Number(store.state.currentFolderId)))
const bulkMoveSubject = computed(() => {
  const names = [...selectedFolders.value.map((f) => f.name), ...selectedFiles.value.map((f) => f.file_name)]
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`
})

const bulkDownloadAction = useAsyncAction(async (): Promise<void> => {
  if (selectedFiles.value.length === 1 && !selectedFolders.value.length) return download(selectedFiles.value[0])
  const folderIds = selectedFolders.value.map((f) => f.id)
  const fileIds = selectedFiles.value.map((f) => f.id)
  const name = currentFolderName.value || t('storage.title')
  try {
    const s = await getSelectionDownloadSummary(folderIds, fileIds, name)
    if (!s.files) return void store.toast('info', t('storage.selNothingToDownload'))
    if (s.tooLarge) return void store.toast('error', t('storage.downloadAllTooLarge', { count: formatNumber(s.files), size: formatBytes(s.bytes) }), 8000)
    const a = document.createElement('a')
    a.href = selectionDownloadUrl(folderIds, fileIds, name)
    a.download = s.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    store.toast('success', t('storage.selDownloadStarted', { count: formatNumber(s.files), size: formatBytes(s.bytes) }), 6000)
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.downloadAllFailed'))
  }
})

async function runBulk(op: (kind: 'folder' | 'file', id: number) => Promise<unknown>): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  bulkBusy.value = true
  try {
    for (const f of selectedFolders.value.slice()) {
      try {
        await op('folder', f.id)
        ok++
      } catch {
        failed++
      }
    }
    for (const f of selectedFiles.value.slice()) {
      try {
        await op('file', f.id)
        ok++
      } catch {
        failed++
      }
    }
  } finally {
    bulkBusy.value = false
  }
  await Promise.all([store.refreshFolders(), store.refreshFiles()])
  selection.value = clearSelection(selection.value)
  return { ok, failed }
}
/** One request: folders (with every sub-folder and file) + files; R2 purged in one batch. */
const bulkDeleteAction = useAsyncAction(async (): Promise<void> => {
  bulkBusy.value = true
  try {
    const r = await bulkDelete(selectedFolders.value.map((f) => f.id), selectedFiles.value.map((f) => f.id))
    bulkDeleteOpen.value = false
    if (r.deleted.items) store.toast('success', t('storage.selDeleteDone', { count: formatNumber(r.deleted.items) }))
    if (r.skipped.length) store.toast('error', t('storage.selDeleteFailed', { count: formatNumber(r.skipped.length) }), 8000)
    if (r.r2.failed) store.toast('info', t('storage.r2Queued', { count: formatNumber(r.r2.failed) }), 8000)
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.deleteFailed'))
  } finally {
    bulkBusy.value = false
    await Promise.all([store.refreshFolders(), store.refreshFiles()])
    selection.value = clearSelection(selection.value)
  }
})
const bulkMoveAction = useAsyncAction(async (target: number | null): Promise<void> => {
  const r = await runBulk((kind, id) => (kind === 'folder' ? updateFolder(id, { parentId: target }) : updateFile(id, { folderId: target as number })))
  bulkMoveOpen.value = false
  if (r.ok) store.toast('success', t('storage.selMoveDone', { count: formatNumber(r.ok) }))
  if (r.failed) store.toast('error', t('storage.selMoveFailed', { count: formatNumber(r.failed) }), 8000)
})

// -- folder: download all (zip) / bulk create from Excel ---------------------------------
const showBulkFolders = ref(false)
const zipOps = useKeyedActions()

/** Summary first (empty / too large → message), then the browser downloads the zip. */
async function downloadAll(folderId: number): Promise<void> {
  closeAllMenus()
  try {
    const s = await getDownloadAllSummary(folderId)
    if (!s.files) return void store.toast('info', t('storage.downloadAllEmpty', { name: s.folder }))
    if (s.tooLarge) {
      return void store.toast('error', t('storage.downloadAllTooLarge', { count: formatNumber(s.files), size: formatBytes(s.bytes) }), 8000)
    }
    const a = document.createElement('a')
    a.href = downloadAllUrl(folderId)
    a.download = s.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    store.toast('success', t('storage.downloadAllStarted', { name: s.folder, count: formatNumber(s.files), size: formatBytes(s.bytes) }), 6000)
    if (s.skippedFolders) store.toast('info', t('storage.downloadAllSkipped', { count: formatNumber(s.skippedFolders) }), 6000)
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.downloadAllFailed'))
  }
}
const currentFolderName = computed(() =>
  isRoot.value ? '' : store.state.folders.find((f) => f.id === store.state.currentFolderId)?.name ?? ''
)

// -- actions -----------------------------------------------------------------
const createFolderAction = useAsyncAction(async (): Promise<void> => {
  if (!newFolderName.value.trim()) return
  const ok = await store.createFolder(newFolderName.value.trim(), newFolderDesc.value.trim())
  if (ok) {
    showCreateFolder.value = false
    newFolderName.value = ''
    newFolderDesc.value = ''
  }
})

function doRenameFolder(): void {
  const target = renameTarget.value
  const name = renameValue.value.trim()
  if (!target || !name) return
  void folderOps.run(target.id, 'rename', async () => {
    if (await store.renameFolder(target.id, name)) renameTarget.value = null
  })
}

function doMoveFolder(parentId: number | null): void {
  const target = moveTarget.value
  if (!target) return
  void folderOps.run(target.id, 'move', async () => {
    if (await store.moveFolder(target.id, parentId)) moveTarget.value = null
  })
}

function doDeleteFolder(): void {
  const target = folderDeleteTarget.value
  if (!target) return
  void folderOps.run(target.id, 'delete', async () => {
    if (await store.removeFolder(target.id)) folderDeleteTarget.value = null
  })
}

function doRenameFile(): void {
  const target = fileRenameTarget.value
  const name = fileRenameValue.value.trim()
  if (!target || !name) return
  void fileOps.run(target.id, 'rename', () => renameFile(target, name))
}

async function renameFile(target: StorageFile, name: string): Promise<void> {
  try {
    await updateFile(target.id, { name })
    store.toast('success', t('storage.fileRenamed'))
    fileRenameTarget.value = null
    await store.refreshFiles()
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.renameFailed'))
  }
}

function doMoveFile(folderId: number | null): void {
  const target = fileMoveTarget.value
  if (!target || !folderId) return
  void fileOps.run(target.id, 'move', () => moveFile(target, folderId))
}

async function moveFile(target: StorageFile, folderId: number): Promise<void> {
  try {
    await updateFile(target.id, { folderId })
    store.toast('success', t('storage.fileMoved'))
    fileMoveTarget.value = null
    await Promise.all([store.refreshFiles(), store.refreshFolders()])
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.moveFailed'))
  }
}

function doDeleteFile(): void {
  const target = fileDeleteTarget.value
  if (!target) return
  void fileOps.run(target.id, 'delete', () => removeFile(target))
}

async function removeFile(target: StorageFile): Promise<void> {
  try {
    await deleteFile(target.id)
    store.toast('success', t('storage.fileDeleted'))
    fileDeleteTarget.value = null
    await Promise.all([store.refreshFiles(), store.refreshFolders()])
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.deleteFailed'))
  }
}

function download(file: StorageFile): void {
  void downloadOps.run(file.id, 'download', () => startDownload(file))
}

async function startDownload(file: StorageFile): Promise<void> {
  try {
    const url = await getDownloadUrl(file.id)
    const a = document.createElement('a')
    a.href = url
    a.download = file.file_name
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    store.toast('error', apiErrorMessage(err, 'storage.downloadFailed'))
  }
}

function openFilePicker(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.onchange = () => {
    if (input.files?.length) void store.uploadFiles(Array.from(input.files))
  }
  input.click()
}

function onDrop(ev: DragEvent): void {
  dragOver.value = false
  const files = ev.dataTransfer?.files
  if (files?.length) void store.uploadFiles(Array.from(files))
}

function folderMenuId(f: StorageFolder): string {
  return `folder-${f.id}`
}
</script>

<template>
  <div class="flex min-h-[calc(100vh-3.5rem)] flex-col" @click="closeAllMenus">
    <!-- Header -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">{{ t('storage.title') }}</h1>
        <p class="text-sm text-slate-500">{{ t('storage.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn btn-secondary lg:hidden" @click="mobileTreeOpen = !mobileTreeOpen">
          <Folder :size="16" /> {{ t('storage.folders') }}
        </button>
        <button
          v-if="canCreateFolder"
          class="btn btn-secondary"
          @click="showCreateFolder = true"
        >
          <FolderPlus :size="16" /> {{ t('storage.newFolder') }}
        </button>
        <button
          v-if="canCreateFolder"
          class="btn btn-secondary"
          data-testid="bulk-folders"
          @click="showBulkFolders = true"
        >
          <FileSpreadsheet :size="16" /> {{ t('storage.bulkFolders') }}
        </button>
        <LoadingButton
          v-if="!isRoot && currentPerms?.can_download"
          class="btn btn-secondary"
          data-testid="download-all-current"
          :loading="zipOps.isPending(Number(store.state.currentFolderId), 'zip')"
          @click="zipOps.run(Number(store.state.currentFolderId), 'zip', () => downloadAll(Number(store.state.currentFolderId)))"
        >
          <FileArchive :size="16" /> {{ t('storage.downloadAll') }}
        </LoadingButton>
        <LoadingButton
          v-if="canUpload"
          class="btn btn-primary"
          :loading-text="t('storage.uploading')"
          :loading="store.uploading"
          @click="openFilePicker"
        >
          <Upload :size="16" /> {{ t('storage.upload') }}
        </LoadingButton>
      </div>
    </div>

    <div class="flex flex-1 gap-4">
      <!-- Sidebar tree (desktop) -->
      <aside
        class="hidden w-64 shrink-0 lg:block"
      >
        <div class="card sticky top-[4.5rem] max-h-[calc(100vh-7rem)] overflow-auto p-3">
          <p class="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            {{ t('storage.folders') }}
          </p>
          <FolderTree :folders="store.rootFolders" />
        </div>
      </aside>

      <!-- Mobile tree drawer -->
      <Teleport to="body">
        <div v-if="mobileTreeOpen" class="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" @click="mobileTreeOpen = false" />
        <div
          v-if="mobileTreeOpen"
          class="fixed bottom-0 left-0 right-0 top-16 z-40 overflow-auto bg-white p-4 lg:hidden"
        >
          <div class="mb-3 flex items-center justify-between">
            <p class="font-semibold text-slate-800">{{ t('storage.folders') }}</p>
            <button class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" :aria-label="t('common.close')" @click="mobileTreeOpen = false">
              <X :size="18" />
            </button>
          </div>
          <FolderTree :folders="store.rootFolders" />
        </div>
      </Teleport>

      <!-- Main panel -->
      <div class="min-w-0 flex-1">
        <div
          class="card flex min-h-[400px] flex-col p-4 sm:p-5"
          :class="{ 'ring-2 ring-indigo-400': dragOver }"
          @dragover.prevent="dragOver = canUpload"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <!-- Toolbar -->
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <!-- Breadcrumb -->
            <nav class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
              <button
                class="flex shrink-0 items-center gap-1.5 font-medium"
                :class="isRoot ? 'text-indigo-700' : 'text-slate-500 hover:text-slate-800'"
                @click="store.navigateTo('root')"
              >
                <HardDrive :size="15" /> {{ t('storage.root') }}
              </button>
              <template v-for="crumb in store.state.breadcrumb" :key="crumb.id">
                <ChevronRight :size="14" class="shrink-0 text-slate-300" />
                <button
                  class="shrink-0 font-medium"
                  :class="
                    crumb.id === store.state.currentFolderId
                      ? 'text-indigo-700'
                      : 'text-slate-500 hover:text-slate-800'
                  "
                  @click="store.navigateTo(crumb.id)"
                >
                  {{ crumb.name }}
                </button>
              </template>
            </nav>

            <!-- Search -->
            <div class="relative">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
              <input
                v-model="searchInput"
                type="text"
                class="input w-48 py-2 pl-9 sm:w-64"
                :placeholder="t('storage.searchFiles')"
              />
            </div>

            <!-- Sort -->
            <div class="flex items-center gap-1">
              <ArrowUpDown :size="15" class="text-slate-400" />
              <select
                class="rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm"
                :value="store.state.sort"
                @change="store.setSorting(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">
                  {{ t(opt.label) }}
                </option>
              </select>
              <button
                class="rounded-xl border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"
                :title="store.state.order === 'asc' ? t('storage.ascending') : t('storage.descending')"
                :aria-label="store.state.order === 'asc' ? t('storage.ascending') : t('storage.descending')"
                @click="store.setSorting(store.state.sort, store.state.order === 'asc' ? 'desc' : 'asc')"
              >
                <ArrowUpDown :size="15" :class="store.state.order === 'asc' ? 'rotate-180' : ''" />
              </button>
            </div>

            <!-- View mode -->
            <div class="flex overflow-hidden rounded-xl border border-slate-300">
              <button
                class="p-2 transition"
                :class="store.state.viewMode === 'grid' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-400 hover:bg-slate-50'"
                :title="t('storage.gridView')"
                :aria-label="t('storage.gridView')"
                @click="store.setViewMode('grid')"
              >
                <Grid3X3 :size="15" />
              </button>
              <button
                class="p-2 transition"
                :class="store.state.viewMode === 'list' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-400 hover:bg-slate-50'"
                :title="t('storage.listView')"
                :aria-label="t('storage.listView')"
                @click="store.setViewMode('list')"
              >
                <List :size="15" />
              </button>
            </div>
          </div>

          <!-- Permission bar -->
          <div
            v-if="canManagePerms"
            class="mb-4 flex items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5"
          >
            <p class="text-sm text-indigo-800">
              {{ t('storage.youManagePermissions') }}
            </p>
            <button
              class="btn btn-secondary"
              @click="permissionFolder = store.state.folders.find((f) => f.id === store.state.currentFolderId) ?? null"
            >
              <Shield :size="15" /> {{ t('storage.permissions') }}
            </button>
          </div>

          <!-- Loading / empty / content -->
          <div v-if="store.state.filesLoading && !store.state.files.length && !visibleFolders.length" class="flex flex-1 flex-col items-center justify-center py-16 text-slate-400">
            <Loader2 :size="30" class="animate-spin" />
            <p class="mt-3 text-sm">{{ t('common.loading') }}</p>
          </div>

          <div v-else-if="store.state.foldersError" class="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">
            {{ localizeMessage(store.state.foldersError) }}
          </div>

          <div v-else-if="store.state.filesError" class="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">
            {{ localizeMessage(store.state.filesError) }}
          </div>

          <div v-else-if="!visibleFolders.length && !store.state.files.length" class="flex flex-1 flex-col items-center justify-center py-16 text-center">
            <PackageOpen :size="40" class="text-slate-300" />
            <p class="mt-3 text-sm text-slate-500">
              {{ store.state.search ? t('storage.noSearchResults') : t('storage.emptyFolder') }}
            </p>
            <p v-if="canUpload && !store.state.search" class="mt-1 text-xs text-slate-400">
              {{ t('storage.dropHint') }}
            </p>
          </div>

          <template v-else>
            <!-- Select all + bulk action bar (multi-select) -->
            <div class="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2" :class="selectedKeys.length ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'" data-testid="selection-bar">
              <label class="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  data-testid="select-all"
                  :checked="allState === 'all'"
                  :indeterminate="allState === 'some'"
                  :aria-checked="allState === 'some' ? 'mixed' : allState === 'all'"
                  @change="onSelectAll"
                />
                {{ t('storage.selAll') }}
              </label>
              <span v-if="selectedKeys.length" class="text-sm font-semibold text-indigo-800" data-testid="selected-count">
                {{ t('storage.selCount', { count: formatNumber(selectedKeys.length) }) }}
              </span>
              <span v-else class="hidden text-xs text-slate-400 md:inline">{{ t('storage.selHint') }}</span>
              <div v-if="selectedKeys.length" class="ml-auto flex flex-wrap items-center gap-2" data-testid="bulk-actions">
                <LoadingButton
                  class="btn btn-secondary px-3 py-1.5 text-sm"
                  :loading="bulkDownloadAction.pending"
                  :disabled="!canBulkDownload || bulkBusy"
                  :title="canBulkDownload ? undefined : t('storage.selNotAllowed')"
                  data-testid="bulk-download"
                  @click="bulkDownloadAction.run()"
                >
                  <FileArchive :size="15" /> {{ t('storage.download') }}
                </LoadingButton>
                <button
                  type="button"
                  class="btn btn-secondary px-3 py-1.5 text-sm"
                  :disabled="!canBulkMove || bulkBusy"
                  :title="canBulkMove ? undefined : t('storage.selNotAllowed')"
                  data-testid="bulk-move"
                  @click="bulkMoveOpen = true"
                >
                  <FolderInput :size="15" /> {{ t('common.move') }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary px-3 py-1.5 text-sm text-rose-600"
                  :disabled="!canBulkDelete || bulkBusy"
                  :title="canBulkDelete ? undefined : t('storage.selNotAllowed')"
                  data-testid="bulk-delete"
                  @click="bulkDeleteOpen = true"
                >
                  <Trash2 :size="15" /> {{ t('common.delete') }}
                </button>
                <button type="button" class="btn btn-ghost px-3 py-1.5 text-sm" data-testid="bulk-clear" @click="clearAll">
                  <X :size="15" /> {{ t('storage.selClear') }}
                </button>
              </div>
            </div>

            <!-- Folders section -->
            <div v-if="visibleFolders.length" class="mb-5">
              <p class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('storage.foldersCount', { count: formatNumber(visibleFolders.length) }) }}
              </p>

              <!-- Grid -->
              <div v-if="store.state.viewMode === 'grid'" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                <div
                  v-for="folder in visibleFolders"
                  :key="folder.id"
                  class="group relative flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 transition hover:border-indigo-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 select-none"
                  :class="isSelected(folderKey(folder.id)) ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300' : 'border-slate-200 bg-white'"
                  :data-item-key="folderKey(folder.id)"
                  :data-selected="isSelected(folderKey(folder.id)) ? 'true' : undefined"
                  :aria-selected="isSelected(folderKey(folder.id))"
                  role="option"
                  :tabindex="tabIndexOf(folderKey(folder.id))"
                  @click="onItemClick($event, folderKey(folder.id))"
                  @dblclick="store.navigateTo(folder.id)"
                  @keydown="onItemKeydown"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600"
                    tabindex="-1"
                    :checked="isSelected(folderKey(folder.id))"
                    :aria-label="t('storage.selItem', { name: folder.name })"
                    @click.stop="onCheckboxClick($event, folderKey(folder.id))"
                    @dblclick.stop
                  />
                  <Folder :size="26" class="shrink-0 text-amber-500" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-semibold text-slate-800">{{ folder.name }}</p>
                    <p class="text-xs text-slate-400">
                      {{ tn(folder.child_count, 'storage.folderCountOne', 'storage.folderCountOther') }} ·
                      {{ tn(folder.file_count, 'storage.fileCountOne', 'storage.fileCountOther') }}
                    </p>
                  </div>
                  <button
                    class="absolute right-2 top-2 rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
                    @click.stop="openMenuId = openMenuId === folderMenuId(folder) ? null : folderMenuId(folder)"
                  >
                    <MoreVertical :size="16" />
                  </button>

                  <!-- Folder context menu -->
                  <div
                    v-if="openMenuId === folderMenuId(folder)"
                    class="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
                    @click.stop
                  >
                    <button
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                      @click="store.navigateTo(folder.id)"
                    >
                      <Folder :size="15" /> {{ t('common.open') }}
                    </button>
                    <LoadingButton
                      v-if="folder.permissions.can_download"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      :spinner-size="15"
                      :loading="zipOps.isPending(folder.id, 'zip')"
                      data-testid="download-all"
                      @click="zipOps.run(folder.id, 'zip', () => downloadAll(folder.id))"
                    >
                      <FileArchive :size="15" /> {{ t('storage.downloadAll') }}
                    </LoadingButton>
                    <button
                      v-if="folder.permissions.can_rename"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                      :disabled="folderOps.isBusy(folder.id)"
                      @click="renameTarget = folder; renameValue = folder.name"
                    >
                      <Pencil :size="15" /> {{ t('common.rename') }}
                    </button>
                    <button
                      v-if="folder.permissions.can_move"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                      :disabled="folderOps.isBusy(folder.id)"
                      @click="moveTarget = folder"
                    >
                      <FolderInput :size="15" /> {{ t('common.move') }}
                    </button>
                    <button
                      v-if="folder.permissions.can_manage_permissions"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                      @click="permissionFolder = folder"
                    >
                      <Shield :size="15" /> {{ t('storage.permissions') }}
                    </button>
                    <LoadingButton
                      v-if="folder.permissions.can_delete"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-rose-600 hover:bg-rose-50"
                      :spinner-size="15"
                      :loading="folderOps.isPending(folder.id, 'delete')"
                      :disabled="folderOps.isBusy(folder.id)"
                      @click="folderDeleteTarget = folder"
                    >
                      <Trash2 :size="15" /> {{ t('common.delete') }}
                    </LoadingButton>
                  </div>
                </div>
              </div>

              <!-- List -->
              <div v-else class="overflow-hidden rounded-xl border border-slate-200">
                <div
                  v-for="folder in visibleFolders"
                  :key="folder.id"
                  class="group flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 select-none"
                  :class="isSelected(folderKey(folder.id)) ? 'bg-indigo-50' : 'hover:bg-slate-50'"
                  :data-item-key="folderKey(folder.id)"
                  :data-selected="isSelected(folderKey(folder.id)) ? 'true' : undefined"
                  :aria-selected="isSelected(folderKey(folder.id))"
                  role="option"
                  :tabindex="tabIndexOf(folderKey(folder.id))"
                  @click="onItemClick($event, folderKey(folder.id))"
                  @dblclick="store.navigateTo(folder.id)"
                  @keydown="onItemKeydown"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600"
                    tabindex="-1"
                    :checked="isSelected(folderKey(folder.id))"
                    :aria-label="t('storage.selItem', { name: folder.name })"
                    @click.stop="onCheckboxClick($event, folderKey(folder.id))"
                    @dblclick.stop
                  />
                  <Folder :size="20" class="shrink-0 text-amber-500" />
                  <p class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{{ folder.name }}</p>
                  <p class="hidden text-xs text-slate-400 sm:block">{{ formatDate(folder.created_at) }}</p>
                  <button
                    class="rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
                    @click.stop="openMenuId = openMenuId === folderMenuId(folder) ? null : folderMenuId(folder)"
                  >
                    <MoreVertical :size="16" />
                  </button>
                </div>
              </div>
            </div>

            <!-- Files section -->
            <div v-if="store.state.files.length">
              <p class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {{ t('storage.filesCount', { count: formatNumber(store.state.filesTotal) }) }}
              </p>

              <!-- Grid -->
              <div v-if="store.state.viewMode === 'grid'" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                <div
                  v-for="file in store.state.files"
                  :key="file.id"
                  class="group relative flex cursor-pointer flex-col gap-2 rounded-xl border p-3.5 transition hover:border-indigo-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 select-none"
                  :class="isSelected(fileKey(file.id)) ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300' : 'border-slate-200 bg-white'"
                  :data-item-key="fileKey(file.id)"
                  :data-selected="isSelected(fileKey(file.id)) ? 'true' : undefined"
                  :aria-selected="isSelected(fileKey(file.id))"
                  role="option"
                  :tabindex="tabIndexOf(fileKey(file.id))"
                  @click="onItemClick($event, fileKey(file.id))"
                  @dblclick="previewFile = file"
                  @keydown="onItemKeydown"
                >
                  <div class="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      class="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600"
                      tabindex="-1"
                      :checked="isSelected(fileKey(file.id))"
                      :aria-label="t('storage.selItem', { name: file.file_name })"
                      @click.stop="onCheckboxClick($event, fileKey(file.id))"
                      @dblclick.stop
                    />
                    <FileIcon :extension="file.file_extension" :size="24" />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-semibold text-slate-800" :title="file.file_name">
                        {{ file.file_name }}
                      </p>
                      <p class="text-xs text-slate-400">{{ formatBytes(file.file_size) }}</p>
                    </div>
                  </div>
                  <p class="truncate text-xs text-slate-400">
                    {{ file.uploaded_by_name || '—' }} · {{ formatDate(file.created_at) }}
                  </p>
                  <button
                    class="absolute right-2 top-2 rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
                    @click.stop="openMenuId = openMenuId === `file-${file.id}` ? null : `file-${file.id}`"
                  >
                    <MoreVertical :size="16" />
                  </button>

                  <!-- File context menu -->
                  <div
                    v-if="openMenuId === `file-${file.id}`"
                    class="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
                    @click.stop
                  >
                    <button
                      v-if="fileCaps?.can_preview"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                      @click="previewFile = file"
                    >
                      <FileIcon :extension="file.file_extension" :size="15" /> {{ t('storage.preview') }}
                    </button>
                    <LoadingButton
                      v-if="fileCaps?.can_download"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                      :spinner-size="15"
                      :loading-text="t('common.preparing')"
                      :loading="downloadOps.isPending(file.id, 'download')"
                      @click="download(file)"
                    >
                      <Upload :size="15" class="rotate-180" /> {{ t('storage.download') }}
                    </LoadingButton>
                    <button
                      v-if="fileCaps?.can_rename"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                      :disabled="fileOps.isBusy(file.id)"
                      @click="fileRenameTarget = file; fileRenameValue = file.file_name"
                    >
                      <Pencil :size="15" /> {{ t('common.rename') }}
                    </button>
                    <button
                      v-if="fileCaps?.can_move"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                      :disabled="fileOps.isBusy(file.id)"
                      @click="fileMoveTarget = file"
                    >
                      <FolderInput :size="15" /> {{ t('common.move') }}
                    </button>
                    <LoadingButton
                      v-if="fileCaps?.can_delete"
                      class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-rose-600 hover:bg-rose-50"
                      :spinner-size="15"
                      :loading="fileOps.isPending(file.id, 'delete')"
                      :disabled="fileOps.isBusy(file.id)"
                      @click="fileDeleteTarget = file"
                    >
                      <Trash2 :size="15" /> {{ t('common.delete') }}
                    </LoadingButton>
                  </div>
                </div>
              </div>

              <!-- List -->
              <div v-else class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th class="px-4 py-2.5 font-semibold">{{ t('storage.colName') }}</th>
                      <th class="px-4 py-2.5 font-semibold">{{ t('storage.colSize') }}</th>
                      <th class="hidden px-4 py-2.5 font-semibold sm:table-cell">{{ t('storage.colUploader') }}</th>
                      <th class="hidden px-4 py-2.5 font-semibold md:table-cell">{{ t('storage.colUploaded') }}</th>
                      <th class="w-24 px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="file in store.state.files"
                      :key="file.id"
                      class="group cursor-pointer border-b border-slate-100 last:border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 select-none"
                      :class="isSelected(fileKey(file.id)) ? 'bg-indigo-50' : 'hover:bg-slate-50'"
                      :data-item-key="fileKey(file.id)"
                      :data-selected="isSelected(fileKey(file.id)) ? 'true' : undefined"
                      :aria-selected="isSelected(fileKey(file.id))"
                      role="option"
                      :tabindex="tabIndexOf(fileKey(file.id))"
                      @click="onItemClick($event, fileKey(file.id))"
                      @dblclick="previewFile = file"
                      @keydown="onItemKeydown"
                    >
                      <td class="px-4 py-2.5">
                        <div class="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            class="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600"
                            tabindex="-1"
                            :checked="isSelected(fileKey(file.id))"
                            :aria-label="t('storage.selItem', { name: file.file_name })"
                            @click.stop="onCheckboxClick($event, fileKey(file.id))"
                            @dblclick.stop
                          />
                          <FileIcon :extension="file.file_extension" />
                          <span class="max-w-[280px] truncate font-medium text-slate-800" :title="file.file_name">
                            {{ file.file_name }}
                          </span>
                        </div>
                      </td>
                      <td class="px-4 py-2.5 text-slate-500">{{ formatBytes(file.file_size) }}</td>
                      <td class="hidden px-4 py-2.5 text-slate-500 sm:table-cell">
                        {{ file.uploaded_by_name || '—' }}
                      </td>
                      <td class="hidden px-4 py-2.5 text-slate-400 md:table-cell">
                        {{ formatDate(file.created_at) }}
                      </td>
                      <td class="relative px-4 py-2.5 text-right">
                        <button
                          class="rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
                          @click.stop="openMenuId = openMenuId === `file-${file.id}` ? null : `file-${file.id}`"
                        >
                          <MoreVertical :size="16" />
                        </button>
                        <div
                          v-if="openMenuId === `file-${file.id}`"
                          class="absolute right-4 top-10 z-20 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-left shadow-lg"
                          @click.stop
                        >
                          <button
                            v-if="fileCaps?.can_preview"
                            class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            @click="previewFile = file"
                          >
                            {{ t('storage.preview') }}
                          </button>
                          <LoadingButton
                            v-if="fileCaps?.can_download"
                            class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                            :spinner-size="15"
                            :loading-text="t('common.preparing')"
                            :loading="downloadOps.isPending(file.id, 'download')"
                            @click="download(file)"
                          >
                            {{ t('storage.download') }}
                          </LoadingButton>
                          <button
                            v-if="fileCaps?.can_rename"
                            class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                            :disabled="fileOps.isBusy(file.id)"
                            @click="fileRenameTarget = file; fileRenameValue = file.file_name"
                          >
                            {{ t('common.rename') }}
                          </button>
                          <button
                            v-if="fileCaps?.can_move"
                            class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-slate-700 hover:bg-slate-50"
                            :disabled="fileOps.isBusy(file.id)"
                            @click="fileMoveTarget = file"
                          >
                            {{ t('common.move') }}
                          </button>
                          <LoadingButton
                            v-if="fileCaps?.can_delete"
                            class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 text-rose-600 hover:bg-rose-50"
                            :spinner-size="15"
                            :loading="fileOps.isPending(file.id, 'delete')"
                            :disabled="fileOps.isBusy(file.id)"
                            @click="fileDeleteTarget = file"
                          >
                            {{ t('common.delete') }}
                          </LoadingButton>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Pagination -->
              <div v-if="totalPages > 1" class="mt-4 flex items-center justify-between text-sm">
                <span class="text-slate-500">
                  {{ t('storage.paginationSummary', { page: formatNumber(store.state.filesPage), pages: formatNumber(totalPages), total: formatNumber(store.state.filesTotal) }) }}
                </span>
                <div class="flex gap-2">
                  <button
                    class="btn btn-secondary px-3 py-1.5"
                    :disabled="store.state.filesPage <= 1 || store.state.filesLoading"
                    @click="store.setPage(store.state.filesPage - 1)"
                  >
                    {{ t('common.prev') }}
                  </button>
                  <button
                    class="btn btn-secondary px-3 py-1.5"
                    :disabled="store.state.filesPage >= totalPages || store.state.filesLoading"
                    @click="store.setPage(store.state.filesPage + 1)"
                  >
                    {{ t('common.next') }}
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- Upload progress -->
          <div v-if="store.state.uploads.length" class="mt-5 space-y-2 border-t border-slate-100 pt-4">
            <div v-for="up in store.state.uploads" :key="up.id" class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-1 flex items-center justify-between text-xs">
                  <span class="truncate font-medium text-slate-700">{{ up.name }}</span>
                  <span
                    :class="{
                      'text-emerald-600': up.status === 'done',
                      'text-rose-600': up.status === 'error',
                      'text-slate-400': up.status !== 'done' && up.status !== 'error',
                    }"
                  >
                    {{
                      up.status === 'done' ? t('storage.uploadDone')
                      : up.status === 'error' ? t('storage.uploadFailed')
                      : up.status === 'finalizing' ? t('storage.uploadFinalizing')
                      : `${formatNumber(up.progress)}%`
                    }}
                  </span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="up.status === 'error' ? 'bg-rose-500' : up.status === 'done' ? 'bg-emerald-500' : 'bg-indigo-500'"
                    :style="{ width: (up.status === 'done' ? 100 : up.progress) + '%' }"
                  />
                </div>
                <p v-if="up.error" class="mt-0.5 truncate text-xs text-rose-500">{{ localizeMessage(up.error) }}</p>
              </div>
              <button
                v-if="up.status === 'error'"
                class="rounded p-1 text-slate-400 hover:text-slate-700"
                :aria-label="t('storage.dismiss')"
                @click="store.dismissUpload(up.id)"
              >
                <X :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Toasts -->
    <ToastStack />

    <!-- ===== Dialogs ===== -->

    <!-- Create folder -->
    <Teleport to="body">
      <div
        v-if="showCreateFolder"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
        @click.self="showCreateFolder = false"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('storage.newFolder') }}</h3>
          <div class="space-y-4">
            <div>
              <label class="label" for="new-folder-name">{{ t('storage.folderName') }}</label>
              <input
                id="new-folder-name"
                v-model="newFolderName"
                class="input"
                type="text"
                maxlength="191"
                autofocus
                @keyup.enter="createFolderAction.run()"
              />
            </div>
            <div>
              <label class="label" for="new-folder-desc">{{ t('storage.descriptionOptional') }}</label>
              <input id="new-folder-desc" v-model="newFolderDesc" class="input" type="text" maxlength="500" />
            </div>
            <div class="flex justify-end gap-3">
              <button class="btn btn-secondary" @click="showCreateFolder = false">{{ t('common.cancel') }}</button>
              <LoadingButton
                class="btn btn-primary"
                :loading-text="t('common.creating')"
                :loading="createFolderAction.pending"
                :disabled="!newFolderName.trim()"
                @click="createFolderAction.run()"
              >
                {{ t('common.create') }}
              </LoadingButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bulk delete (selection) -->
    <Teleport to="body">
      <div v-if="bulkDeleteOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="bulkDeleteOpen = false">
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" data-testid="bulk-delete-dialog">
          <h3 class="section-title mb-2">{{ t('storage.selDeleteTitle', { count: formatNumber(selectedKeys.length) }) }}</h3>
          <p class="mb-4 text-sm text-slate-600">{{ t('storage.selDeleteBody') }}</p>
          <div class="flex justify-end gap-3">
            <button class="btn btn-secondary" :disabled="bulkDeleteAction.pending" @click="bulkDeleteOpen = false">{{ t('common.cancel') }}</button>
            <LoadingButton class="btn bg-rose-600 text-white hover:bg-rose-700" :loading="bulkDeleteAction.pending" data-testid="bulk-delete-confirm" @click="bulkDeleteAction.run()">
              {{ t('common.delete') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bulk move (selection) -->
    <MoveDialog
      v-if="bulkMoveOpen"
      :title="t('storage.selMoveTitle', { count: formatNumber(selectedKeys.length) })"
      :subject="bulkMoveSubject"
      :ctx="moveCtx(selectedFolders.map((f) => f.id), selectedFiles.length > 0, [currentParentId])"
      :busy="bulkMoveAction.pending"
      @close="bulkMoveOpen = false"
      @confirm="(target) => bulkMoveAction.run(target)"
    />

    <!-- Bulk create folders from Excel -->
    <BulkFolderDialog
      v-if="showBulkFolders"
      :parent-id="isRoot ? null : Number(store.state.currentFolderId)"
      :parent-name="currentFolderName"
      @close="showBulkFolders = false"
      @done="store.refreshFolders()"
    />

    <!-- Rename folder -->
    <Teleport to="body">
      <div
        v-if="renameTarget"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
        @click.self="renameTarget = null"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('storage.renameFolder') }}</h3>
          <input v-model="renameValue" class="input" type="text" maxlength="191" autofocus @keyup.enter="doRenameFolder" />
          <div class="mt-4 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="renameTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-primary"
              :loading-text="t('common.renaming')"
              :loading="folderOps.isPending(renameTarget.id, 'rename')"
              :disabled="!renameValue.trim() || folderOps.isBusy(renameTarget.id)"
              @click="doRenameFolder"
            >
              {{ t('common.rename') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Move folder -->
    <MoveDialog
      v-if="moveTarget"
      :title="t('storage.moveFolder')"
      :subject="moveTarget.name"
      :ctx="moveCtx([moveTarget.id], false, [moveTarget.parent_id])"
      :busy="folderOps.isPending(moveTarget.id, 'move')"
      @close="moveTarget = null"
      @confirm="doMoveFolder"
    />

    <!-- Delete folder confirm -->
    <Teleport to="body">
      <div
        v-if="folderDeleteTarget"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
        @click.self="folderDeleteTarget = null"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-rose-700">{{ t('storage.deleteFolderTitle') }}</h3>
          <p class="text-sm text-slate-600">
            "<strong>{{ folderDeleteTarget.name }}</strong>"
            {{ t('storage.deleteFolderBody', { folders: formatNumber(folderDeleteTarget.child_count), files: formatNumber(folderDeleteTarget.file_count) }) }}
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="folderDeleteTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-danger"
              :loading-text="t('common.deleting')"
              :loading="folderOps.isPending(folderDeleteTarget.id, 'delete')"
              :disabled="folderOps.isBusy(folderDeleteTarget.id)"
              @click="doDeleteFolder"
            >
              {{ t('common.delete') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Rename file -->
    <Teleport to="body">
      <div
        v-if="fileRenameTarget"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
        @click.self="fileRenameTarget = null"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="section-title mb-4">{{ t('storage.renameFile') }}</h3>
          <input v-model="fileRenameValue" class="input" type="text" maxlength="255" autofocus @keyup.enter="doRenameFile" />
          <div class="mt-4 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="fileRenameTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-primary"
              :loading-text="t('common.renaming')"
              :loading="fileOps.isPending(fileRenameTarget.id, 'rename')"
              :disabled="!fileRenameValue.trim() || fileOps.isBusy(fileRenameTarget.id)"
              @click="doRenameFile"
            >
              {{ t('common.rename') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Move file -->
    <MoveDialog
      v-if="fileMoveTarget"
      :title="t('storage.moveFile')"
      :subject="fileMoveTarget.file_name"
      :ctx="moveCtx([], true, [fileMoveTarget.folder_id])"
      :busy="fileOps.isPending(fileMoveTarget.id, 'move')"
      @close="fileMoveTarget = null"
      @confirm="doMoveFile"
    />

    <!-- Delete file confirm -->
    <Teleport to="body">
      <div
        v-if="fileDeleteTarget"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
        @click.self="fileDeleteTarget = null"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h3 class="mb-2 text-base font-semibold text-rose-700">{{ t('storage.deleteFileTitle') }}</h3>
          <p class="text-sm text-slate-600">
            "<strong>{{ fileDeleteTarget.file_name }}</strong>"
            {{ tn(fileDeleteTarget.version_count, 'storage.deleteFileBodyOne', 'storage.deleteFileBodyOther') }}
          </p>
          <div class="mt-5 flex justify-end gap-3">
            <button class="btn btn-secondary" @click="fileDeleteTarget = null">{{ t('common.cancel') }}</button>
            <LoadingButton
              class="btn btn-danger"
              :loading-text="t('common.deleting')"
              :loading="fileOps.isPending(fileDeleteTarget.id, 'delete')"
              :disabled="fileOps.isBusy(fileDeleteTarget.id)"
              @click="doDeleteFile"
            >
              {{ t('common.delete') }}
            </LoadingButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Preview -->
    <FilePreviewModal :file="previewFile" @close="previewFile = null" />

    <!-- Permissions -->
    <PermissionModal
      v-if="permissionFolder"
      :folder-id="permissionFolder.id"
      :folder-name="permissionFolder.name"
      @close="permissionFolder = null"
      @saved="store.refreshFolders()"
    />
  </div>
</template>
