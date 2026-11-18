export type RecordStatus = 'pending' | 'processing' | 'success' | 'failed' | 'skipped'

export interface Settings {
  bearerToken: string
  permissionToken: string
  userId: string
}

export interface ProcessingConfig {
  /** Delay in milliseconds between requests. */
  delayMs: number
  /** Number of concurrent requests (default 1). */
  concurrency: number
  /** Number of retries for temporary failures, on top of the first attempt. */
  maxRetries: number
}

export interface TrackingRecord {
  id: string
  /** 0-based index among the detected data rows (used to map back to the worksheet). */
  rowIndex: number
  awb: string
  recipient: string
  originalPhone: string
  kota: string
  operator: string
  status: RecordStatus
  retrievedPhone: string
  error: string
  attempts: number
}

export interface ParsedSheet {
  fileName: string
  sheetName: string
  /** Row index (relative to the sheet's used range) of the header row. */
  headerRowIndex: number
  resiColIndex: number
  phoneColIndex: number
  records: TrackingRecord[]
}

export interface ApiResult {
  ok: boolean
  value?: string
  status?: number
  message?: string
}
