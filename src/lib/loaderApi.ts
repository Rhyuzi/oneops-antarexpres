/**
 * Loader API client + shared types (mirror server/loader/*).
 * SiCepat credentials are read from the EXISTING rechecker token settings
 * (src/lib/settings.ts, localStorage) at call time — so a token updated in
 * Rechecker Settings is used by the next start/resume — and forwarded in the
 * same headers the rechecker proxy uses. OneOps never stores them.
 */
import axios from 'axios'
import { loadSettings } from './settings'

export interface ResiValue { resi: string; value?: string | number; issue?: string | null; field?: string }
export interface RecheckFailure { resi: string; code: string; httpStatus?: number; message?: string }
/** Empty-data warnings (row = Excel row of the template). */
export interface EmptyReport {
  cells: number
  rowsWithEmpty: number
  byColumn: Array<{ column: string; count: number }>
  rows: Array<{ row: number; resi: string; columns: string[] }>
  emptyColumns: string[]
  blankRows: number[]
}
export type KotaFallbackReason = 'no_gerai' | 'unknown_hub' | 'no_label'
/** KOTA PENERIMA of the Result 3PL: hub mapping vs Kota_Tujuan fallback. */
export interface KotaPenerimaReport {
  mapped: number
  fallback: number
  fallbackGroups: Array<{ reason: KotaFallbackReason; hub: string | null; kotaTujuan: string; label: string; count: number; rows?: number[] }>
}
export interface LoaderReport {
  rows: number
  cod: number
  nonCod: number
  columns: string[]
  weight: { conversion?: boolean; normalized: number; unchanged: number; belowThreshold: number; guardSkipped: number; invalid: ResiValue[] }
  kodepos: { filled: number; missing: Array<{ kecamatan: string; count: number }>; ambiguous: Array<{ kecamatan: string; options: string[] }> }
  phone: { fromRechecked: number; notInRechecked: string[]; normalized: number; invalid: ResiValue[] }
  nilaiBarangDefaulted: number
  unknownCod: ResiValue[]
  negativeNilaiBarang: ResiValue[]
  invalidNumbers: ResiValue[]
  addressCleaned?: number
  empty?: EmptyReport | null
  kotaPenerima?: KotaPenerimaReport
  sheets?: string[]
  senderPhone?: string
  /** Wilayah / kota picked in the form and the sender columns they produced. */
  sender?: LoaderSender | null
  duplicateResi?: DuplicateResiReport
  resiIssues?: ResiIssuesReport
  rechecked?: { mode: string; name: string; duplicateResi?: DuplicateResiReport } | null
  recheck?: { mode: 'api'; total: number; success: number; failed: number; byCode: Record<string, number>; failures: RecheckFailure[] }
}
/** Resi double: every resi seen more than once, with its Excel rows (server/loader/duplicates.js). */
export interface DuplicateResiReport {
  groups: number
  rows: number
  items: Array<{ resi: string; count: number; rows: number[] }>
  /** Rows painted red in the downloaded file. */
  highlighted?: number
}

/** Why a resi is red (server/loader/resiIssues.js); texts: src/lib/resiIssues.ts. */
export type ResiIssue = { type: 'duplicate'; rows: number[] } | { type: 'invalid'; chars: string[] }
export interface ResiIssueRow { row: number; resi: string; issues: ResiIssue[] }
export interface ResiIssueSummary {
  total: number
  valid: number
  withIssues: number
  duplicateGroups: number
  duplicateRows: number
  invalidRows: number
}
/** Rows WITH an issue (loader pre-check / 409 confirmation / result). */
export interface ResiIssuesReport { summary: ResiIssueSummary; rows: ResiIssueRow[]; truncated: boolean }
/** Grouped duplicates (rechecked file) → one row per occurrence. */
export function duplicatesAsIssueRows(d: DuplicateResiReport): ResiIssueRow[] {
  return d.items
    .flatMap((g) => g.rows.map((row) => ({ row, resi: g.resi, issues: [{ type: 'duplicate', rows: g.rows } as ResiIssue] })))
    .sort((a, b) => a.row - b.row)
}

export interface LoaderSender { wilayah: string; kota: string; kotaPengirim: string; namaPengirim: string }

/** Wilayah master (migration 014) as served by GET /api/loader/wilayah-options. */
/** kotaPengirim: KOTA PENGIRIM already resolved by the server for this kota ("" = empty). */
export interface WilayahKotaOption { id: number; kota: string; aliases: string[]; kotaPengirim: string }
export interface WilayahOption {
  id: number
  name: string
  kodeposWilayah: string | null
  namaPengirimBase: string
  custIdNonCod: string | null
  custIdCod: string | null
  isTasikmalaya: boolean
  kota: WilayahKotaOption[]
}
export async function getWilayahOptions(): Promise<WilayahOption[]> {
  return (await axios.get('/api/loader/wilayah-options')).data.wilayah
}

/**
 * Same rule as the server (server/loader/wilayah.js senderFor) — preview only;
 * the file is always built from the DB values on the server.
 */
export function senderPreview(w: WilayahOption, kota: WilayahKotaOption | null): { kotaPengirim: string; namaPengirim: string } {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  return {
    // Per-kota value from the server (kota_pengirim, else the wilayah rule).
    kotaPengirim: kota ? kota.kotaPengirim : w.isTasikmalaya ? '' : squash(w.name),
    namaPengirim: squash(`${w.namaPengirimBase} ${kota ? kota.kota : ''}`),
  }
}

export interface DownloadInfo { id: string; filename: string; expiresAt: string }
export interface PrecheckWarning { code: string; count: number; items: Array<Record<string, unknown>> }
export interface Precheck {
  ok: boolean
  errors: Array<{ code: string; columns?: string[] }>
  warnings: PrecheckWarning[]
  counts: { rows: number; uniqueResi: number; cod: number; nonCod: number }
  notices?: { empty: EmptyReport | null; kotaPenerima: KotaPenerimaReport | null }
  resiIssues?: ResiIssuesReport
}
/** Gerai / HUB master row (loader_hub_kota). */
export interface HubMapping {
  id: number
  hub: string
  dest_code: string | null
  city: string | null
  analytic_code: string | null
  hub_type: string | null
  kota_penerima: string | null
  nama_pengirim: string | null
  source: string
  updated_by: string | null
}
export type JobStatus = 'running' | 'paused' | 'processing' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export interface LoaderJob {
  id: string
  mode: 'file' | 'api'
  status: JobStatus
  templateName: string
  rechecked: string | null
  wilayah: string | null
  user?: string | null
  totalRows: number
  progress: { total: number; processed: number; success: number; failed: number }
  startedAt: string | null
  finishedAt?: string | null
  error: { code: string; message: string } | null
  report?: LoaderReport | null
  download: DownloadInfo | null
}
export interface FilePayload { name: string; data: string }

export function fileToPayload(file: File): Promise<FilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** True when the rechecker token settings hold both tokens. */
export function hasRecheckerToken(): boolean {
  const s = loadSettings()
  return Boolean(s.bearerToken.trim() && s.permissionToken.trim())
}

/** Headers/body of the existing rechecker token system (read fresh each call). */
function tokenRequest(): { headers: Record<string, string>; sicepatUserId: string } {
  const s = loadSettings()
  return {
    headers: { Authorization: `Bearer ${s.bearerToken.trim()}`, 'x-permission-token': s.permissionToken.trim() },
    sicepatUserId: s.userId.trim(),
  }
}

export async function startApiJob(body: {
  template: FilePayload
  /** Master Data ids — the server resolves Cust IDs / sender columns from them. */
  wilayahId: number
  kotaId: number
  acknowledgeWarnings?: boolean
  /** Language of the issue notes written into the file. */
  locale?: string
  convertWeightFromActual?: boolean
}): Promise<LoaderJob> {
  const tok = tokenRequest()
  const resp = await axios.post('/api/loader/jobs', { ...body, sicepatUserId: tok.sicepatUserId }, { headers: tok.headers })
  return resp.data.job
}

export async function resumeJob(id: string): Promise<LoaderJob> {
  const tok = tokenRequest()
  const resp = await axios.post(`/api/loader/jobs/${id}/resume`, { sicepatUserId: tok.sicepatUserId }, { headers: tok.headers })
  return resp.data.job
}

export async function cancelJob(id: string): Promise<void> {
  await axios.post(`/api/loader/jobs/${id}/cancel`)
}

export async function getJob(id: string): Promise<LoaderJob> {
  return (await axios.get(`/api/loader/jobs/${id}`)).data.job
}

export async function listJobs(all = false): Promise<LoaderJob[]> {
  return (await axios.get('/api/loader/jobs', { params: all ? { scope: 'all' } : {} })).data.jobs
}

export async function precheck(body: { template: FilePayload; wilayahId: number }): Promise<Precheck> {
  return (await axios.post('/api/loader/precheck', body)).data.precheck
}

/** Downloads a stored result and saves it via an object URL. Throws the server message. */
export async function downloadResult(download: DownloadInfo): Promise<void> {
  try {
    const resp = await axios.get(`/api/loader/download/${download.id}`, { responseType: 'blob' })
    const url = URL.createObjectURL(resp.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = download.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (err) {
    // Error bodies arrive as Blob (responseType) — surface the JSON message.
    const e = err as { response?: { data?: unknown } }
    if (e.response?.data instanceof Blob) {
      try {
        const message = (JSON.parse(await e.response.data.text()) as { message?: string }).message
        if (message) throw Object.assign(new Error(message), { response: { data: { message } } })
      } catch (inner) {
        if (inner instanceof Error && 'response' in inner) throw inner
      }
    }
    throw err
  }
}
