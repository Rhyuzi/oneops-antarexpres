/**
 * OneOps i18n — tiny, dependency-free, type-checked.
 *
 * - `locale` is a reactive ref; anything that calls t()/format*() during
 *   render or inside computed() re-renders automatically on setLocale().
 * - Keys are typed from the English dictionary (MessageKey), and the
 *   Indonesian dictionary is typed as `Messages`, so a missing/extra key in
 *   either language or a mistyped key in a component fails `vue-tsc`.
 * - Interpolation: t('x.y', { name: 'Ana' }) replaces "{name}".
 * - Preference: localStorage "oneops.locale" ('en' | 'id' only — never any
 *   session data). Unknown/invalid values fall back to English.
 *
 * Why not vue-i18n: two locales, no pluralisation rules beyond one/other and
 * no message compilation needed — this file covers it without a dependency.
 */
import { ref } from 'vue'
import { en, type Messages } from './locales/en'
import { id } from './locales/id'

export type Locale = 'en' | 'id'

export const SUPPORTED_LOCALES: ReadonlyArray<{ code: Locale; label: string; short: string }> = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'id', label: 'Bahasa Indonesia', short: 'ID' },
]

const DEFAULT_LOCALE: Locale = 'en'
const STORAGE_KEY = 'oneops.locale'
const dictionaries: Record<Locale, Messages> = { en, id }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'id'
}

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isLocale(stored) ? stored : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE // storage blocked (private mode etc.)
  }
}

export const locale = ref<Locale>(readStoredLocale())

function applyDocumentLang(l: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = l
}
applyDocumentLang(locale.value)

export function setLocale(next: unknown): void {
  const l = isLocale(next) ? next : DEFAULT_LOCALE
  locale.value = l
  applyDocumentLang(l)
  try {
    window.localStorage.setItem(STORAGE_KEY, l)
  } catch {
    // Preference just won't persist; the switch still applies.
  }
}

// --- keys -------------------------------------------------------------------

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>
}[keyof T & string]

/** Every valid dotted translation key, e.g. "common.save". */
export type MessageKey = Leaves<Messages>
export type MessageParams = Record<string, string | number>

function lookup(dict: unknown, key: string): string | undefined {
  let node: unknown = dict
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  )
}

/** Translate a key in the current locale (falls back to English, then the key). */
export function t(key: MessageKey, params?: MessageParams): string {
  const text = lookup(dictionaries[locale.value], key) ?? lookup(en, key) ?? key
  return interpolate(text, params)
}

/** one/other plural pick: tn(n, 'x.one', 'x.other') with {count} available. */
export function tn(count: number, one: MessageKey, other: MessageKey, params?: MessageParams): string {
  return t(count === 1 ? one : other, { count: formatNumber(count), ...params })
}

/** True when the key exists (for optional, data-driven labels). */
export function hasKey(key: string): key is MessageKey {
  return lookup(en, key) !== undefined
}

// --- locale-aware formatting (display only; data stays language-neutral) -----

export function intlLocale(): string {
  return locale.value === 'id' ? 'id-ID' : 'en-US'
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(intlLocale(), options).format(value) : '—'
}

/** "November 19, 2026" / "19 November 2026" */
export function formatDate(value: Date | string | number | null | undefined): string {
  const d = toDate(value)
  return d ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'long' }).format(d) : '—'
}

/** "Nov 19, 2026, 5:38 PM" / "19 Nov 2026, 17.38" (seconds optional) */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  { seconds = false }: { seconds?: boolean } = {}
): string {
  const d = toDate(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat(intlLocale(), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(d)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 2 ? 2 : 1, minimumFractionDigits: unit === 2 ? 2 : 1 })} ${units[unit]}`
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}
