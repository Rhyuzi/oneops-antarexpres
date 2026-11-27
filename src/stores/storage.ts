import { reactive, computed } from 'vue'
import {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  listFiles,
  requestUploadUrl,
  putFileToR2,
  completeUpload,
  getFolder,
  ensureFolderTree,
  type UploadSource,
  StorageFolder,
  StorageFile,
  FilesResponse,
  UploadProgressItem,
} from '../lib/storageApi'
import { t } from '../i18n'
import { apiErrorMessage, localizeMessage } from '../i18n/systemMessages'
import { dirKey, planLocalUpload, type LocalEntry } from '../lib/localDrop'

/** Result of a drag & drop / paste upload (also shown as notifications). */
export interface LocalUploadSummary {
  created: number
  merged: string[]
  uploaded: number
  failed: number
  skippedRootFiles: number
}

interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

interface StorageState {
  folders: StorageFolder[]
  foldersLoading: boolean
  foldersError: string | null
  expanded: Set<number>
  currentFolderId: number | 'root'
  breadcrumb: Array<{ id: number; name: string }>
  files: StorageFile[]
  filesTotal: number
  filesPage: number
  filesPageSize: number
  filesLoading: boolean
  filesError: string | null
  search: string
  sort: string
  order: 'asc' | 'desc'
  viewMode: 'grid' | 'list'
  capabilities: FilesResponse['capabilities']
  uploads: UploadProgressItem[]
  /** Drag & drop / paste in progress: folders prepared, files done / total. */
  localUpload: { phase: 'folders' | 'files'; done: number; total: number } | null
  toasts: Toast[]
  currentFolder: StorageFolder | null
}

const state = reactive<StorageState>({
  folders: [],
  foldersLoading: false,
  foldersError: null,
  expanded: new Set(),
  currentFolderId: 'root',
  breadcrumb: [],
  files: [],
  filesTotal: 0,
  filesPage: 1,
  filesPageSize: 50,
  filesLoading: false,
  filesError: null,
  search: '',
  sort: 'created_at',
  order: 'desc',
  viewMode: 'grid',
  capabilities: null,
  uploads: [],
  localUpload: null,
  toasts: [],
  currentFolder: null,
})

let toastSeq = 1

// Files currently being uploaded (folder + name + size + mtime). A second
// pick/drop of the same file while its upload is still running is skipped,
// so double-submitting never creates duplicate objects/versions.
const uploadsInFlight = new Set<string>()
function uploadKey(folderId: number, file: File): string {
  return `${folderId}|${file.name}|${file.size}|${file.lastModified}`
}

function isRoot(id: number | 'root'): id is 'root' {
  return id === 'root' || id === 0
}

function folderById(id: number): StorageFolder | undefined {
  return state.folders.find((f) => f.id === id)
}

export const storageStore = {
  state,

  // -- computed helpers -----------------------------------------------------
  get currentCapabilities() {
    if (isRoot(state.currentFolderId)) return null
    return folderById(Number(state.currentFolderId))?.permissions ?? null
  },
  /** True while any upload is transferring or finalizing. */
  get uploading(): boolean {
    return state.uploads.some((u) => u.status === 'uploading' || u.status === 'finalizing')
  },
  get rootFolders(): StorageFolder[] {
    return state.folders.filter((f) => f.parent_id === null)
  },
  childrenOf(parentId: number | null): StorageFolder[] {
    return state.folders.filter((f) => f.parent_id === parentId)
  },

  // -- toasts ---------------------------------------------------------------
  toast(kind: Toast['kind'], message: string, ttl = 4000): void {
    const id = toastSeq++
    state.toasts.push({ id, kind, message })
    window.setTimeout(() => {
      const idx = state.toasts.findIndex((t) => t.id === id)
      if (idx >= 0) state.toasts.splice(idx, 1)
    }, ttl)
  },
  dismissToast(id: number): void {
    const idx = state.toasts.findIndex((t) => t.id === id)
    if (idx >= 0) state.toasts.splice(idx, 1)
  },

  // -- folders --------------------------------------------------------------
  async refreshFolders(): Promise<void> {
    state.foldersLoading = true
    state.foldersError = null
    try {
      state.folders = await listFolders()
      // Keep the current folder visible in the tree.
      if (!isRoot(state.currentFolderId)) {
        const fid = Number(state.currentFolderId)
        let pid = folderById(fid)?.parent_id ?? null
        while (pid) {
          state.expanded.add(pid)
          pid = folderById(pid)?.parent_id ?? null
        }
      }
    } catch (err) {
      state.foldersError = 'Could not load folders.'
    } finally {
      state.foldersLoading = false
    }
  },

  toggleExpand(id: number): void {
    if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(id)
  },

  async navigateTo(folderId: number | 'root'): Promise<void> {
    state.currentFolderId = folderId
    state.filesPage = 1
    if (isRoot(folderId)) {
      state.breadcrumb = []
      state.currentFolder = null
    } else {
      try {
        const { folder, breadcrumb } = await getFolder(Number(folderId))
        state.currentFolder = folder
        state.breadcrumb = breadcrumb
        state.expanded.add(Number(folderId))
        let pid = folder.parent_id
        while (pid) {
          state.expanded.add(pid)
          pid = folderById(pid)?.parent_id ?? null
        }
      } catch {
        state.breadcrumb = []
        state.currentFolder = null
      }
    }
    await this.refreshFiles()
  },

  async createFolder(name: string, description = ''): Promise<StorageFolder | null> {
    try {
      const parentId = isRoot(state.currentFolderId) ? null : Number(state.currentFolderId)
      const folder = await createFolder({ name, description, parentId })
      await this.refreshFolders()
      if (parentId) state.expanded.add(parentId)
      this.toast('success', t('storage.folderCreated', { name }))
      return folder
    } catch (err) {
      this.toast('error', apiErrorMessage(err, 'storage.createFolderFailed'))
      return null
    }
  },

  async renameFolder(id: number, name: string): Promise<boolean> {
    try {
      await updateFolder(id, { name })
      await this.refreshFolders()
      await this.refreshFiles()
      this.toast('success', t('storage.folderRenamed'))
      return true
    } catch (err) {
      this.toast('error', apiErrorMessage(err, 'storage.renameFailed'))
      return false
    }
  },

  async moveFolder(id: number, parentId: number | null): Promise<boolean> {
    try {
      await updateFolder(id, { parentId })
      await this.refreshFolders()
      this.toast('success', t('storage.folderMoved'))
      return true
    } catch (err) {
      this.toast('error', apiErrorMessage(err, 'storage.moveFailed'))
      return false
    }
  },

  async removeFolder(id: number): Promise<boolean> {
    try {
      const out = await deleteFolder(id)
      if (state.currentFolderId === id) await this.navigateTo('root')
      else await Promise.all([this.refreshFolders(), this.refreshFiles()])
      this.toast('success', t('storage.folderDeleted'))
      // R2 objects that could not be removed now are queued (storage_r2_cleanup).
      if (out && out.r2 && out.r2.failed) this.toast('info', t('storage.r2Queued', { count: out.r2.failed }), 8000)
      return true
    } catch (err) {
      this.toast('error', apiErrorMessage(err, 'storage.deleteFailed'))
      return false
    }
  },

  // -- files ------------------------------------------------------------------
  async refreshFiles(): Promise<void> {
    state.filesLoading = true
    state.filesError = null
    try {
      const resp = await listFiles({
        folderId: state.currentFolderId,
        search: state.search,
        page: state.filesPage,
        pageSize: state.filesPageSize,
        sort: state.sort,
        order: state.order,
      })
      state.files = resp.files
      state.filesTotal = resp.total
      state.capabilities = resp.capabilities
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } }
      state.filesError = e.response?.data?.message || 'Could not load files.'
      state.files = []
      state.filesTotal = 0
    } finally {
      state.filesLoading = false
    }
  },

  setSearch(q: string): void {
    state.search = q
    state.filesPage = 1
  },

  setSorting(sort: string, order?: 'asc' | 'desc'): void {
    state.sort = sort
    if (order) state.order = order
    void this.refreshFiles()
  },

  setViewMode(mode: 'grid' | 'list'): void {
    state.viewMode = mode
  },

  setPage(page: number): void {
    state.filesPage = page
    void this.refreshFiles()
  },

  // -- upload flow ------------------------------------------------------------
  async uploadFiles(files: File[], source: UploadSource = 'picker'): Promise<void> {
    if (isRoot(state.currentFolderId)) {
      this.toast('error', t('storage.selectFolderFirst'))
      return
    }
    await this.uploadFilesTo(Number(state.currentFolderId), files, { source })
    await this.refreshFiles()
    await this.refreshFolders() // file counts
  },

  /**
   * Drag & drop / paste from the local file manager into the current folder:
   * the folder tree is created first (a folder whose name already exists is
   * reused = merged, never duplicated), then every file goes to its folder.
   */
  async uploadLocal(entries: LocalEntry[], source: 'drop' | 'paste' = 'drop'): Promise<LocalUploadSummary> {
    const summary: LocalUploadSummary = { created: 0, merged: [], uploaded: 0, failed: 0, skippedRootFiles: 0 }
    const plan = planLocalUpload(entries)
    if (!plan.folderPaths.length && !plan.fileCount) return summary
    const parentId = isRoot(state.currentFolderId) ? null : Number(state.currentFolderId)
    const folderIds = new Map<string, number>()
    try {
      if (plan.folderPaths.length) {
        state.localUpload = { phase: 'folders', done: 0, total: plan.fileCount }
        try {
          const tree = await ensureFolderTree(parentId, plan.folderPaths, source)
          for (const [path, id] of Object.entries(tree.folders)) folderIds.set(dirKey(path), id)
          summary.created = tree.created.length
          summary.merged = tree.merged.map((m) => m.path)
          if (summary.merged.length) {
            const names = summary.merged.slice(0, 5).join(', ') + (summary.merged.length > 5 ? ' …' : '')
            this.toast('info', t('storage.dropMerged', { count: summary.merged.length, names }), 9000)
          }
          await this.refreshFolders()
        } catch (err) {
          this.toast('error', apiErrorMessage(err, 'storage.dropFoldersFailed'), 8000)
          summary.failed = plan.fileCount
          return summary
        }
      }
      state.localUpload = { phase: 'files', done: 0, total: plan.fileCount }
      for (const group of plan.groups) {
        const target = group.dir ? folderIds.get(dirKey(group.dir)) : parentId
        if (target === null || target === undefined) {
          // Loose files dropped on Root: files must live inside a folder.
          summary.skippedRootFiles += group.files.length
          continue
        }
        const r = await this.uploadFilesTo(target, group.files, { source, quiet: true })
        summary.uploaded += r.uploaded
        summary.failed += r.failed
      }
    } finally {
      state.localUpload = null
    }
    if (summary.skippedRootFiles) this.toast('error', t('storage.dropRootFiles', { count: summary.skippedRootFiles }), 8000)
    if (summary.uploaded || summary.created) {
      this.toast('success', t('storage.dropDone', { files: summary.uploaded, folders: summary.created }))
    }
    if (summary.failed) this.toast('error', t('storage.dropFailed', { count: summary.failed }), 8000)
    await this.refreshFiles()
    await this.refreshFolders()
    return summary
  },

  /** Uploads files into folderId (progress rows in state.uploads). */
  async uploadFilesTo(
    folderId: number,
    files: File[],
    opts: { source?: UploadSource; quiet?: boolean } = {}
  ): Promise<{ uploaded: number; failed: number }> {
    const result = { uploaded: 0, failed: 0 }
    const accepted = files.filter((file) => !uploadsInFlight.has(uploadKey(folderId, file)))
    if (accepted.length < files.length) {
      this.toast('error', t('storage.skippedDuplicates'))
    }
    if (!accepted.length) return result
    accepted.forEach((file) => uploadsInFlight.add(uploadKey(folderId, file)))

    for (const file of accepted) {
      const itemId = `up-${toastSeq++}`
      state.uploads.push({
        id: itemId,
        name: file.name,
        size: file.size,
        progress: 0,
        status: 'uploading',
      })
      const item = state.uploads[state.uploads.length - 1]

      try {
        const { uploadUrl, uploadToken } = await requestUploadUrl({
          folderId,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
        })

        await putFileToR2(uploadUrl, file, (pct) => {
          item.progress = pct
        })

        item.status = 'finalizing'
        item.progress = 100
        await completeUpload(uploadToken, opts.source || 'picker')

        item.status = 'done'
        result.uploaded += 1
        window.setTimeout(() => {
          const idx = state.uploads.findIndex((u) => u.id === itemId)
          if (idx >= 0) state.uploads.splice(idx, 1)
        }, 1500)
        if (!opts.quiet) this.toast('success', t('storage.fileUploaded', { name: file.name }))
      } catch (err) {
        const e = err as { response?: { data?: { message?: string } }; message?: string }
        item.status = 'error'
        result.failed += 1
        item.error = e.response?.data?.message || e.message || 'Upload failed.'
        this.toast('error', t('storage.fileUploadError', { name: file.name, error: localizeMessage(item.error) }))
        window.setTimeout(() => {
          const idx = state.uploads.findIndex((u) => u.id === itemId)
          if (idx >= 0) state.uploads.splice(idx, 1)
        }, 6000)
      } finally {
        uploadsInFlight.delete(uploadKey(folderId, file))
        if (state.localUpload && state.localUpload.phase === 'files') state.localUpload.done += 1
      }
    }
    return result
  },

  dismissUpload(id: string): void {
    const idx = state.uploads.findIndex((u) => u.id === id)
    if (idx >= 0) state.uploads.splice(idx, 1)
  },
}
