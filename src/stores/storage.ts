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
  StorageFolder,
  StorageFile,
  FilesResponse,
  UploadProgressItem,
} from '../lib/storageApi'

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
      this.toast('success', `Folder "${name}" created.`)
      return folder
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } }
      this.toast('error', e.response?.data?.message || 'Could not create folder.')
      return null
    }
  },

  async renameFolder(id: number, name: string): Promise<boolean> {
    try {
      await updateFolder(id, { name })
      await this.refreshFolders()
      await this.refreshFiles()
      this.toast('success', 'Folder renamed.')
      return true
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } }
      this.toast('error', e.response?.data?.message || 'Rename failed.')
      return false
    }
  },

  async moveFolder(id: number, parentId: number | null): Promise<boolean> {
    try {
      await updateFolder(id, { parentId })
      await this.refreshFolders()
      this.toast('success', 'Folder moved.')
      return true
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } }
      this.toast('error', e.response?.data?.message || 'Move failed.')
      return false
    }
  },

  async removeFolder(id: number): Promise<boolean> {
    try {
      await deleteFolder(id)
      if (state.currentFolderId === id) await this.navigateTo('root')
      else await Promise.all([this.refreshFolders(), this.refreshFiles()])
      this.toast('success', 'Folder deleted.')
      return true
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } }
      this.toast('error', e.response?.data?.message || 'Delete failed.')
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
  async uploadFiles(files: File[]): Promise<void> {
    if (isRoot(state.currentFolderId)) {
      this.toast('error', 'Select a folder first — files cannot be uploaded to the root.')
      return
    }
    const folderId = Number(state.currentFolderId)

    const accepted = files.filter((file) => !uploadsInFlight.has(uploadKey(folderId, file)))
    if (accepted.length < files.length) {
      this.toast('error', 'Skipped file(s) that are already uploading.')
    }
    if (!accepted.length) return
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
        await completeUpload(uploadToken)

        item.status = 'done'
        window.setTimeout(() => {
          const idx = state.uploads.findIndex((u) => u.id === itemId)
          if (idx >= 0) state.uploads.splice(idx, 1)
        }, 1500)
        this.toast('success', `"${file.name}" uploaded.`)
      } catch (err) {
        const e = err as { response?: { data?: { message?: string } }; message?: string }
        item.status = 'error'
        item.error = e.response?.data?.message || e.message || 'Upload failed.'
        this.toast('error', `"${file.name}": ${item.error}`)
        window.setTimeout(() => {
          const idx = state.uploads.findIndex((u) => u.id === itemId)
          if (idx >= 0) state.uploads.splice(idx, 1)
        }, 6000)
      } finally {
        uploadsInFlight.delete(uploadKey(folderId, file))
      }
    }

    await this.refreshFiles()
    await this.refreshFolders() // file counts
  },

  dismissUpload(id: string): void {
    const idx = state.uploads.findIndex((u) => u.id === id)
    if (idx >= 0) state.uploads.splice(idx, 1)
  },
}
