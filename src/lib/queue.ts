import type { ProcessingConfig, Settings, TrackingRecord } from '../types'
import { fetchPhone } from './api'
import { normalizePhone as normalizePhoneRule } from './phone'

export type ProcessOutcome =
  | { action: 'continue' }
  | { action: 'stop'; reason: 'auth' | 'user'; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function abortableSleep(ms: number, shouldAbort: () => boolean): Promise<boolean> {
  if (ms <= 0) return false
  await sleep(ms)
  return shouldAbort()
}

function backoffDelay(attempt: number, status: number): number {
  const base = status === 429 ? 5000 : 1000
  return Math.min(30000, base * Math.pow(2, attempt - 1))
}

/** Shared rule (src/lib/phone.ts ⇔ server/recheck/phone.js): '' unless a valid 628… number. */
export function normalizePhone(value: string): string {
  const phone = normalizePhoneRule(value)
  return phone.valid ? phone.value : ''
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

export async function processRecord(
  record: TrackingRecord,
  settings: Settings,
  config: ProcessingConfig,
  successfulAwbs: Set<string>,
  shouldAbort: () => boolean
): Promise<ProcessOutcome> {
  if (!record.awb) {
    record.status = 'skipped'
    record.error = 'Empty AWB'
    return { action: 'continue' }
  }

  if (successfulAwbs.has(record.awb)) {
    record.status = 'skipped'
    record.error = 'Duplicate AWB — already processed this session'
    return { action: 'continue' }
  }

  const maxAttempts = Math.max(1, (config.maxRetries ?? 0) + 1)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    record.attempts = attempt

    if (shouldAbort()) {
      record.status = 'pending'
      record.error = ''
      return { action: 'stop', reason: 'user', message: 'Stopped by user.' }
    }

    try {
      const result = await fetchPhone(settings, record.awb)

      if (result.ok) {
        const phone = normalizePhone(result.value ?? '')
        if (phone) {
          record.retrievedPhone = phone
          record.status = 'success'
          record.error = ''
          successfulAwbs.add(record.awb)
          return { action: 'continue' }
        }
        record.status = 'failed'
        record.error = 'Empty or invalid phone number in API response'
        return { action: 'continue' }
      }

      const status = result.status ?? 0

      if (status === 401 || status === 403) {
        record.status = 'failed'
        record.error =
          result.message ||
          (status === 401
            ? 'Authorization failed — token invalid or expired'
            : 'Forbidden — insufficient permission')
        return { action: 'stop', reason: 'auth', message: record.error }
      }

      if (isRetryableStatus(status)) {
        if (attempt < maxAttempts) {
          const aborted = await abortableSleep(backoffDelay(attempt, status), shouldAbort)
          if (aborted) {
            record.status = 'pending'
            record.error = ''
            return { action: 'stop', reason: 'user', message: 'Stopped by user.' }
          }
          continue
        }
        record.status = 'failed'
        record.error = result.message || `Request failed (HTTP ${status})`
        return { action: 'continue' }
      }

      record.status = 'failed'
      record.error = result.message || `Request failed (HTTP ${status})`
      return { action: 'continue' }
    } catch {
      // Network-level failure (no HTTP response).
      if (attempt < maxAttempts) {
        const aborted = await abortableSleep(backoffDelay(attempt, 0), shouldAbort)
        if (aborted) {
          record.status = 'pending'
          record.error = ''
          return { action: 'stop', reason: 'user', message: 'Stopped by user.' }
        }
        continue
      }
      record.status = 'failed'
      record.error = 'Network error — could not reach the proxy/SiCepat'
      return { action: 'continue' }
    }
  }

  return { action: 'continue' }
}
