/**
 * Master Data — API client + the definition of the three loader reference
 * entities (columns, form fields, filters). One generic CRUD component
 * (components/masterData/MasterDataTable.vue) renders all three.
 * Server: server/routes/masterData.js.
 */
import axios from 'axios'
import type { MessageKey } from '../i18n'
import type { FilePayload } from './loaderApi'

export type EntityKey = 'hubs' | 'kota-wilayah' | 'kodepos'
export type MasterRow = Record<string, string | number | null> & { id: number }

export interface ColumnDef {
  key: string
  label: MessageKey
  mono?: boolean
  /** Shown (italic) when the value is empty. */
  empty?: MessageKey
}
export interface FieldDef {
  key: string
  label: MessageKey
  required?: boolean
  /** 'wilayah' = choose from the wilayah of the kodepos reference (or type a new one when allowNew). */
  type?: 'text' | 'wilayah'
  allowNew?: boolean
  maxlength?: number
  inputmode?: 'numeric' | 'text'
  placeholder?: MessageKey
}
export interface EntityDef {
  key: EntityKey
  entityType: string
  title: MessageKey
  hint: MessageKey
  importHint: MessageKey
  columns: ColumnDef[]
  fields: FieldDef[]
  filters: Array<'wilayah' | 'missingLabel'>
  /** Record name used in confirmations. */
  recordKey: (row: MasterRow) => string
}

export const ENTITIES: Record<EntityKey, EntityDef> = {
  hubs: {
    key: 'hubs',
    entityType: 'gerai_kota_mapping',
    title: 'masterData.hubs.title',
    hint: 'masterData.hubs.hint',
    importHint: 'masterData.hubs.importHint',
    columns: [
      { key: 'hub', label: 'masterData.hubs.hub' },
      { key: 'analytic_code', label: 'masterData.hubs.analyticCode', mono: true },
      { key: 'city', label: 'masterData.hubs.city' },
      { key: 'kota_penerima', label: 'masterData.hubs.kotaPenerima', empty: 'masterData.hubs.fallback' },
      { key: 'nama_pengirim', label: 'masterData.hubs.namaPengirim' },
    ],
    fields: [
      { key: 'hub', label: 'masterData.hubs.hub', required: true, maxlength: 150 },
      { key: 'analytic_code', label: 'masterData.hubs.analyticCode', maxlength: 30 },
      { key: 'city', label: 'masterData.hubs.city', maxlength: 100 },
      { key: 'dest_code', label: 'masterData.hubs.destCode', maxlength: 20 },
      { key: 'hub_type', label: 'masterData.hubs.hubType', maxlength: 30 },
      { key: 'kota_penerima', label: 'masterData.hubs.kotaPenerima', maxlength: 150, placeholder: 'masterData.hubs.kotaPlaceholder' },
      { key: 'nama_pengirim', label: 'masterData.hubs.namaPengirim', maxlength: 150, placeholder: 'masterData.hubs.pengirimPlaceholder' },
    ],
    filters: ['missingLabel'],
    recordKey: (r) => String(r.hub || ''),
  },
  'kota-wilayah': {
    key: 'kota-wilayah',
    entityType: 'kota_wilayah_mapping',
    title: 'masterData.kota.title',
    hint: 'masterData.kota.hint',
    importHint: 'masterData.kota.importHint',
    columns: [
      { key: 'kota', label: 'masterData.kota.kota' },
      { key: 'wilayah', label: 'masterData.wilayah' },
      { key: 'source', label: 'masterData.source' },
    ],
    fields: [
      { key: 'kota', label: 'masterData.kota.kota', required: true, maxlength: 150, placeholder: 'masterData.kota.kotaPlaceholder' },
      { key: 'wilayah', label: 'masterData.wilayah', required: true, type: 'wilayah' },
    ],
    filters: ['wilayah'],
    recordKey: (r) => String(r.kota || ''),
  },
  kodepos: {
    key: 'kodepos',
    entityType: 'kodepos_reference',
    title: 'masterData.kodepos.title',
    hint: 'masterData.kodepos.hint',
    importHint: 'masterData.kodepos.importHint',
    columns: [
      { key: 'wilayah', label: 'masterData.wilayah' },
      { key: 'kecamatan', label: 'masterData.kodepos.kecamatan' },
      { key: 'kodepos', label: 'masterData.kodepos.kodepos', mono: true },
    ],
    fields: [
      { key: 'wilayah', label: 'masterData.wilayah', required: true, type: 'wilayah', allowNew: true, maxlength: 100 },
      { key: 'kecamatan', label: 'masterData.kodepos.kecamatan', required: true, maxlength: 150 },
      { key: 'kodepos', label: 'masterData.kodepos.kodepos', required: true, maxlength: 5, inputmode: 'numeric' },
    ],
    filters: ['wilayah'],
    recordKey: (r) => `${r.wilayah} / ${r.kecamatan} / ${r.kodepos}`,
  },
}

export interface ListResult { rows: MasterRow[]; total: number; page: number; pageSize: number }
export interface ImportResult { rows: number; inserted: number; updated: number; skipped: Array<{ row: number; value: string; reason: string }>; sheet: string }

export async function listRows(entity: EntityKey, params: Record<string, string | number | undefined>): Promise<ListResult> {
  return (await axios.get(`/api/master-data/${entity}`, { params })).data
}
export async function getMeta(): Promise<{ wilayah: string[] }> {
  return (await axios.get('/api/master-data/meta')).data
}
export async function createRow(entity: EntityKey, body: Record<string, string>): Promise<void> {
  await axios.post(`/api/master-data/${entity}`, body)
}
export async function updateRow(entity: EntityKey, id: number, body: Record<string, string>): Promise<void> {
  await axios.put(`/api/master-data/${entity}/${id}`, body)
}
export async function deleteRow(entity: EntityKey, id: number): Promise<void> {
  await axios.delete(`/api/master-data/${entity}/${id}`)
}
export async function importFile(entity: EntityKey, file: FilePayload): Promise<ImportResult> {
  return (await axios.post(`/api/master-data/${entity}/import`, { file })).data
}

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'IMPORT'
export interface AuditEntry {
  id: number
  created_at: string | null
  action: AuditAction
  entity_type: string
  entity: EntityKey | null
  record_id: number | null
  record_key: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  details: { file: string | null; sheet: string | null }
  actor: { id: number | null; username: string | null; full_name: string | null }
  result: string
}
export async function listAudit(params: Record<string, string | number | undefined>): Promise<{ records: AuditEntry[]; total: number; page: number; pageSize: number }> {
  return (await axios.get('/api/master-data/audit', { params })).data
}

export const ENTITY_TYPE_LABEL: Record<string, MessageKey> = {
  gerai_kota_mapping: 'masterData.hubs.title',
  kota_wilayah_mapping: 'masterData.kota.title',
  kodepos_reference: 'masterData.kodepos.title',
}
export const ACTION_LABEL: Record<AuditAction, MessageKey> = {
  CREATE: 'masterData.audit.actions.CREATE',
  UPDATE: 'masterData.audit.actions.UPDATE',
  DELETE: 'masterData.audit.actions.DELETE',
  IMPORT: 'masterData.audit.actions.IMPORT',
}
