import axios from 'axios'
import { formatBytes as formatBytesLocalized, formatDateTime } from '../i18n'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderPermissions {
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

export interface StorageFolder {
  id: number
  parent_id: number | null
  name: string
  description: string | null
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
  created_by_name: string | null
  child_count: number
  file_count: number
  permissions: FolderPermissions
}

export interface StorageFile {
  id: number
  folder_id: number
  file_name: string
  original_name: string
  mime_type: string
  file_extension: string
  file_size: number
  storage_provider: string
  bucket_name: string
  object_key: string
  file_url: string | null
  uploaded_by: number | null
  created_at: string
  updated_at: string
  uploaded_by_name: string | null
  folder_name: string | null
  version_count: number
}

export interface FileVersion {
  id: number
  version_number: number
  object_key: string
  file_size: number
  mime_type: string
  created_at: string
  uploaded_by_name: string | null
}

export interface FileCapabilities {
  can_download: boolean
  can_preview: boolean
  can_rename: boolean
  can_move: boolean
  can_delete: boolean
  can_upload: boolean
  can_view?: boolean
  can_create_folder?: boolean
  can_manage_permissions?: boolean
}

export interface RoleRow {
  id: number
  name: string
  description: string | null
}

export interface PermissionRow {
  role_id: number
  role_name: string
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

export interface AuditLog {
  id: number
  user_id: number | null
  action: string
  entity_type: string
  entity_id: number | null
  metadata: string | null
  ip_address: string | null
  created_at: string
  user_name: string | null
  user_username: string | null
}

export interface UploadProgressItem {
  id: string
  name: string
  size: number
  progress: number
  status: 'uploading' | 'finalizing' | 'done' | 'error'
  error?: string
}

export interface FilesResponse {
  ok: boolean
  files: StorageFile[]
  total: number
  page: number
  pageSize: number
  capabilities: FileCapabilities | null
}

// ---------------------------------------------------------------------------
// API helpers — every call relies on the session cookie for auth
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<StorageFolder[]> {
  const resp = await axios.get('/api/storage/folders')
  return resp.data.folders ?? []
}

export interface CreateFolderPayload {
  name: string
  description?: string
  parentId: number | null
}

export async function createFolder(payload: CreateFolderPayload): Promise<StorageFolder> {
  const resp = await axios.post('/api/storage/folders', payload)
  return resp.data.folder
}

export async function getFolder(id: number): Promise<{ folder: StorageFolder; breadcrumb: Array<{ id: number; name: string }> }> {
  const resp = await axios.get(`/api/storage/folders/${id}`)
  return resp.data
}

export async function updateFolder(
  id: number,
  payload: { name?: string; description?: string; parentId?: number | null }
): Promise<StorageFolder> {
  const resp = await axios.put(`/api/storage/folders/${id}`, payload)
  return resp.data.folder
}

export async function deleteFolder(id: number): Promise<void> {
  await axios.delete(`/api/storage/folders/${id}`)
}

export async function listFiles(params: {
  folderId?: number | 'root'
  search?: string
  page?: number
  pageSize?: number
  sort?: string
  order?: 'asc' | 'desc'
}): Promise<FilesResponse> {
  const resp = await axios.get('/api/storage/files', { params })
  return resp.data
}

export async function getFileDetail(
  id: number
): Promise<{ file: StorageFile; versions: FileVersion[]; capabilities: FolderPermissions }> {
  const resp = await axios.get(`/api/storage/files/${id}`)
  return resp.data
}

export async function requestUploadUrl(payload: {
  folderId: number
  fileName: string
  fileSize: number
  mimeType: string
}): Promise<{ uploadUrl: string; objectKey: string; uploadToken: string; expiresIn: number }> {
  const resp = await axios.post('/api/storage/files/upload-url', payload)
  return resp.data
}

/** Direct PUT to R2 with progress reporting via XHR (axios has no upload progress in browsers). */
export function putFileToR2(
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Storage rejected the upload (HTTP ${xhr.status}).`))
    }
    xhr.onerror = () =>
      reject(
        new Error(
          'Network error during upload. Check R2 CORS rules for your origin (PUT allowed).'
        )
      )
    xhr.send(file)
  })
}

export async function completeUpload(uploadToken: string): Promise<StorageFile> {
  const resp = await axios.post('/api/storage/files/complete-upload', { uploadToken })
  return resp.data.file
}

export async function getDownloadUrl(id: number): Promise<string> {
  const resp = await axios.get(`/api/storage/files/${id}/download-url`)
  return resp.data.url
}

export async function getPreviewUrl(id: number): Promise<string> {
  const resp = await axios.get(`/api/storage/files/${id}/preview-url`)
  return resp.data.url
}

export async function updateFile(
  id: number,
  payload: { name?: string; folderId?: number }
): Promise<StorageFile> {
  const resp = await axios.put(`/api/storage/files/${id}`, payload)
  return resp.data.file
}

export async function deleteFile(id: number): Promise<void> {
  await axios.delete(`/api/storage/files/${id}`)
}

export async function getFolderPermissions(
  id: number
): Promise<{ permissions: PermissionRow[]; roles: RoleRow[] }> {
  const resp = await axios.get(`/api/storage/folders/${id}/permissions`)
  return resp.data
}

export async function putFolderPermissions(
  id: number,
  permissions: Array<Partial<PermissionRow> & { role_id: number }>
): Promise<void> {
  await axios.put(`/api/storage/folders/${id}/permissions`, { permissions })
}

export async function listAuditLogs(params: {
  page?: number
  pageSize?: number
  search?: string
  action?: string
}): Promise<{ logs: AuditLog[]; total: number; page: number; pageSize: number }> {
  const resp = await axios.get('/api/storage/audit-logs', { params })
  return resp.data
}

export function errorMessage(err: unknown, fallback = 'Request failed.'): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string }
  return e.response?.data?.message || e.message || fallback
}

// ---------------------------------------------------------------------------
// Shared display helpers
// ---------------------------------------------------------------------------

/** Locale-aware size ("1.5 MB" / "1,5 MB"). */
export function formatBytes(bytes: number): string {
  return formatBytesLocalized(bytes)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'))
  if (Number.isNaN(d.getTime())) return String(iso)
  return formatDateTime(d) // locale-aware; parsing above is unchanged
}

// --- Folder actions: download all (zip) + bulk create from Excel --------------------------

export interface DownloadAllSummary {
  folder: string
  files: number
  bytes: number
  folders: number
  skippedFolders: number
  tooLarge: boolean
  filename: string
}
/** What "Download all" would put in the zip (permission-filtered, incl. sub-folders). */
export async function getDownloadAllSummary(folderId: number): Promise<DownloadAllSummary> {
  return (await axios.get(`/api/storage/folders/${folderId}/download-all/summary`)).data
}
/** Same-origin GET (session cookie): the browser streams the zip to disk. */
export function downloadAllUrl(folderId: number): string {
  return `/api/storage/folders/${folderId}/download-all`
}

export type BulkSkipReason = 'duplicate_in_file' | 'exists' | 'invalid'
export interface BulkFolderResult {
  sheet: string
  total: number
  created: Array<{ id: number; row: number; name: string }>
  skipped: Array<{ row: number; name: string; reason: BulkSkipReason; firstRow?: number }>
}
/** Creates one folder per Excel row in `parentId` (null = root); duplicates are skipped. */
export async function bulkCreateFolders(parentId: number | null, file: { name: string; data: string }): Promise<BulkFolderResult> {
  return (await axios.post('/api/storage/folders/bulk', { parentId, file })).data
}

// --- Multi-selection download (folders + files of one view) -------------------------------

export interface SelectionDownloadSummary { files: number; bytes: number; skippedFolders: number; tooLarge: boolean; filename: string }
function selectionQuery(folderIds: number[], fileIds: number[], name: string): string {
  const q = new URLSearchParams()
  if (folderIds.length) q.set('folders', folderIds.join(','))
  if (fileIds.length) q.set('files', fileIds.join(','))
  if (name) q.set('name', name)
  return q.toString()
}
export async function getSelectionDownloadSummary(folderIds: number[], fileIds: number[], name: string): Promise<SelectionDownloadSummary> {
  return (await axios.get(`/api/storage/download-selection/summary?${selectionQuery(folderIds, fileIds, name)}`)).data
}
/** Same-origin GET (session cookie): the browser streams the zip to disk. */
export function selectionDownloadUrl(folderIds: number[], fileIds: number[], name: string): string {
  return `/api/storage/download-selection?${selectionQuery(folderIds, fileIds, name)}`
}
