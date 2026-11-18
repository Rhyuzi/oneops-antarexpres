import { reactive } from 'vue'
import * as XLSX from 'xlsx'
import type { ParsedSheet, ProcessingConfig, Settings, TrackingRecord } from './types'
import { clearSettings, loadSettings, saveSettings } from './lib/settings'
import { parseExcelFile, writeOutputWorkbook } from './lib/excel'
import { processRecord } from './lib/queue'

type View = 'dashboard' | 'settings'
interface State {
  view: View
  settings: Settings
  fileName: string | null
  sheet: ParsedSheet | null
  workbook: XLSX.WorkBook | null
  records: TrackingRecord[]
  running: boolean
  paused: boolean
  stopRequested: boolean
  authError: string | null
  config: ProcessingConfig
  currentAwb: string
}

const state = reactive<State>({
  view: 'dashboard',
  settings: loadSettings(),
  fileName: null,
  sheet: null,
  workbook: null,
  records: [],
  running: false,
  paused: false,
  stopRequested: false,
  authError: null,
  config: { delayMs: 500, concurrency: 1, maxRetries: 3 },
  currentAwb: '',
})

// AWBs already resolved successfully during this session (for duplicate skipping).
let successfulAwbs = new Set<string>()

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function goTo(view: View): void {
  state.view = view
}

export function hasCredentials(): boolean {
  return Boolean(
    state.settings.bearerToken.trim() &&
      state.settings.permissionToken.trim() &&
      state.settings.userId.trim()
  )
}

export async function uploadFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer()
  const { sheet, workbook } = parseExcelFile(buffer, file.name)

  state.fileName = file.name
  state.sheet = sheet
  state.workbook = workbook
  state.records = sheet.records
  state.authError = null
  state.running = false
  state.paused = false
  state.stopRequested = false
  state.currentAwb = ''
  successfulAwbs = new Set<string>()
}

export function downloadResult(): void {
  if (!state.workbook || !state.sheet) return
  writeOutputWorkbook(
    state.workbook,
    state.sheet.sheetName,
    state.sheet.headerRowIndex,
    state.sheet.phoneColIndex,
    state.records,
    state.fileName || 'result.xlsx'
  )
}

export function setConfig(patch: Partial<ProcessingConfig>): void {
  state.config = { ...state.config, ...patch }
  state.config.delayMs = clamp(Math.round(state.config.delayMs), 0, 60000)
  state.config.concurrency = clamp(Math.round(state.config.concurrency), 1, 5)
  state.config.maxRetries = clamp(Math.round(state.config.maxRetries), 0, 10)
}

export function startProcessing(): void {
  if (state.running) return
  if (!state.records.length) return

  if (!hasCredentials()) {
    state.authError =
      'Missing credentials. Configure Bearer Token, X-Permission-Token and User ID in Settings before processing.'
    return
  }

  setConfig({ delayMs: state.config.delayMs, concurrency: state.config.concurrency })

  for (const record of state.records) {
    if (record.status !== 'success') {
      record.status = 'pending'
      record.error = ''
      record.retrievedPhone = ''
      record.attempts = 0
    }
  }

  successfulAwbs = new Set(
    state.records.filter((r) => r.status === 'success').map((r) => r.awb)
  )

  state.stopRequested = false
  state.paused = false
  state.authError = null
  state.running = true

  void runWorkers()
}

export function togglePause(): void {
  if (!state.running) {
    startProcessing()
    return
  }
  state.paused = !state.paused
}

export function stopProcessing(): void {
  if (!state.running) return
  state.stopRequested = true
  state.paused = false
}

export function updateSettings(settings: Settings): void {
  state.settings = { ...settings }
  saveSettings(settings)
}

export function clearCredentials(): void {
  clearSettings()
  state.settings = { bearerToken: '', permissionToken: '', userId: '' }
}

function claimNext(): TrackingRecord | null {
  for (const record of state.records) {
    if (record.status === 'pending') {
      record.status = 'processing'
      return record
    }
  }
  return null
}

async function runWorkers(): Promise<void> {
  // Snapshot settings so a mid-run change doesn't swap credentials under us.
  const settings: Settings = { ...state.settings }

  const workers: Promise<void>[] = []
  for (let i = 0; i < state.config.concurrency; i++) {
    workers.push(worker(settings))
  }

  await Promise.all(workers)

  state.running = false
  state.paused = false
  state.stopRequested = false
  state.currentAwb = ''
}

async function worker(settings: Settings): Promise<void> {
  while (true) {
    if (state.stopRequested) return
    if (state.paused) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      continue
    }

    const record = claimNext()
    if (!record) return

    state.currentAwb = record.awb

    const outcome = await processRecord(
      record,
      settings,
      state.config,
      successfulAwbs,
      () => state.stopRequested
    )

    if (state.currentAwb === record.awb) state.currentAwb = ''

    if (outcome.action === 'stop') {
      if (outcome.reason === 'auth') state.authError = outcome.message
      state.stopRequested = true
      return
    }

    if (state.stopRequested) return
    if (state.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.config.delayMs))
    }
  }
}

export const store = {
  state,
  goTo,
  hasCredentials,
  uploadFile,
  downloadResult,
  setConfig,
  startProcessing,
  togglePause,
  stopProcessing,
  updateSettings,
  clearCredentials,
}
