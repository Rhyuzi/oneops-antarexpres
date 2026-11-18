import * as XLSX from 'xlsx'
import type { ParsedSheet, TrackingRecord } from '../types'

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''

  if (typeof value === 'string') return value.trim()

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    return String(value)
  }

  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'

  if (value instanceof Date) return value.toISOString()

  return String(value)
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ')
}

function findHeaderIndex(headers: string[], target: string): number {
  const t = normalizeHeader(target)
  return headers.findIndex((h) => normalizeHeader(h) === t)
}

export function awbFromCell(
  worksheet: XLSX.WorkSheet,
  rowIndex: number,
  colIndex: number
): string {
  const address = XLSX.utils.encode_cell({
    r: rowIndex,
    c: colIndex,
  })

  const cell = worksheet[address]

  if (!cell || cell.v === null || cell.v === undefined) {
    return ''
  }

  if (cell.t === 's' || cell.t === 'str') {
    return String(cell.v).trim().replace(/^'+/, '')
  }

  if (cell.t === 'n') {
    return XLSX.utils.format_cell(cell).trim()
  }

  return cellToText(cell.v).replace(/^'+/, '').trim()
}

export interface ParseResult {
  sheet: ParsedSheet
  workbook: XLSX.WorkBook
}

export function parseExcelFile(
  buffer: ArrayBuffer,
  fileName: string
): ParseResult {
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: false,
    cellNF: true,
  })

  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]

  if (!worksheet) {
    throw new Error('The Excel file contains no worksheets.')
  }

  const grid: unknown[][] = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: true,
  })

  if (!grid.length) {
    throw new Error('The Excel file is empty.')
  }

  const headerRowIndex = grid.findIndex((row) =>
    row.some(
      (cell) => normalizeHeader(cellToText(cell)) === 'resi'
    )
  )

  if (headerRowIndex < 0) {
    throw new Error(
      'Could not find the "Resi" column. The file does not match the expected SiCepat format.'
    )
  }

  const headers = grid[headerRowIndex].map((cell) =>
    cellToText(cell)
  )

  const resiColIndex = findHeaderIndex(headers, 'Resi')
  const phoneColIndex = findHeaderIndex(headers, 'No HP Penerima')

  if (resiColIndex < 0 || phoneColIndex < 0) {
    throw new Error(
      'Missing required columns. Expected at least "Resi" and "No HP Penerima" in the header row.'
    )
  }

  const recipientColIndex = findHeaderIndex(headers, 'Penerima')
  const kotaColIndex = findHeaderIndex(headers, 'Kota_Tujuan')
  const operatorColIndex = findHeaderIndex(
    headers,
    'NAMA YANG MENGERJAKAN'
  )

  const records: TrackingRecord[] = []
  let rowIndex = 0

  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const row = grid[i]

    if (!row || row.every((cell) => cellToText(cell) === '')) {
      continue
    }

    const awb = awbFromCell(worksheet, i, resiColIndex)

    if (!awb) continue

    records.push({
      id: `row-${i}-${awb}-${rowIndex}`,
      rowIndex,
      awb,
      recipient:
        recipientColIndex >= 0
          ? cellToText(row[recipientColIndex])
          : '',
      originalPhone:
        phoneColIndex >= 0
          ? cellToText(row[phoneColIndex])
          : '',
      kota:
        kotaColIndex >= 0
          ? cellToText(row[kotaColIndex])
          : '',
      operator:
        operatorColIndex >= 0
          ? cellToText(row[operatorColIndex])
          : '',
      status: 'pending',
      retrievedPhone: '',
      error: '',
      attempts: 0,
    })

    rowIndex++
  }

  if (!records.length) {
    throw new Error('No AWB records found below the header row.')
  }

  return {
    workbook,
    sheet: {
      fileName,
      sheetName,
      headerRowIndex,
      resiColIndex,
      phoneColIndex,
      records,
    },
  }
}

export function writeOutputWorkbook(
  workbook: XLSX.WorkBook,
  sheetName: string,
  headerRowIndex: number,
  phoneColIndex: number,
  records: TrackingRecord[],
  fileName: string
): void {
  const worksheet = workbook.Sheets[sheetName]

  if (!worksheet) {
    throw new Error(`Worksheet "${sheetName}" not found.`)
  }

  const range = XLSX.utils.decode_range(
    worksheet['!ref'] ?? 'A1'
  )

  for (const record of records) {
    if (record.status !== 'success' || !record.retrievedPhone) {
      continue
    }

    const absoluteRow =
      range.s.r + headerRowIndex + 1 + record.rowIndex

    const address = XLSX.utils.encode_cell({
      r: absoluteRow,
      c: phoneColIndex,
    })

    worksheet[address] = {
      t: 's',
      v: record.retrievedPhone,
    }
  }

  const base = fileName.replace(/\.(xlsx|xls)$/i, '')
  const outName = `${base}-rechecked.xlsx`

  XLSX.writeFile(workbook, outName, {
    bookType: 'xlsx',
  })
}