/**
 * Data Warrior — files and folders dropped (drag & drop) or pasted from the
 * local file manager.
 *
 *   collectDataTransfer(dt) reads a drop/paste: folders are walked recursively
 *   with webkitGetAsEntry (every sub-folder, empty ones included); browsers
 *   without it fall back to File.webkitRelativePath / plain files.
 *
 *   planLocalUpload(entries) (pure, unit-tested in tests/test-local-drop.js)
 *   groups the files per relative folder: `folderPaths` is every folder the
 *   upload needs (parents included) for POST /api/storage/folders/tree, and
 *   `groups` lists the files of each folder ('' = the current folder).
 */

export interface LocalEntry {
  /** Relative folder of the file inside the drop ("" = top level), "/"-separated. */
  dir: string
  /** Null for an (empty) folder entry. */
  file: File | null
}

export interface LocalUploadPlan {
  folderPaths: string[]
  groups: Array<{ dir: string; files: File[] }>
  fileCount: number
}

const tidy = (s: string) => s.replace(/[ \t ]+/g, ' ').trim()

/** "A\\ B /C/" → "A B/C" (segments trimmed, empty ones dropped). */
export function normalizeDir(dir: string): string {
  return String(dir || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(tidy)
    .filter((s) => s.length)
    .join('/')
}

/** Case-insensitive key of a folder path (the folder table compares names case-insensitively). */
export const dirKey = (dir: string) => normalizeDir(dir).toLowerCase()

export function planLocalUpload(entries: readonly LocalEntry[]): LocalUploadPlan {
  const paths = new Map<string, string>()
  const groups = new Map<string, { dir: string; files: File[] }>()
  let fileCount = 0
  for (const e of entries) {
    const dir = normalizeDir(e.dir)
    if (dir) {
      const parts = dir.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/')
        if (!paths.has(p.toLowerCase())) paths.set(p.toLowerCase(), p)
      }
    }
    if (!e.file) continue
    const k = dir.toLowerCase()
    if (!groups.has(k)) groups.set(k, { dir: paths.get(k) ?? dir, files: [] })
    groups.get(k)!.files.push(e.file)
    fileCount += 1
  }
  const folderPaths = [...paths.values()].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const ordered = [...groups.values()].sort((a, b) => (a.dir ? a.dir.split('/').length : 0) - (b.dir ? b.dir.split('/').length : 0) || a.dir.localeCompare(b.dir))
  return { folderPaths, groups: ordered, fileCount }
}

// ---------------------------------------------------------------------------
// Browser side (FileSystem entries API)
// ---------------------------------------------------------------------------

interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (list: FsEntry[]) => void, fail: (e: unknown) => void) => void }
}

function readAll(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader!()
  const out: FsEntry[] = []
  return new Promise((resolve, reject) => {
    // readEntries returns at most ~100 entries per call: read until empty.
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(out)
        else {
          out.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

async function walk(entry: FsEntry, dir: string, out: LocalEntry[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail))
    out.push({ dir, file })
  } else if (entry.isDirectory) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    out.push({ dir: path, file: null }) // keeps empty folders
    for (const child of await readAll(entry)) await walk(child, path, out)
  }
}

/** Entries of a drop / paste (folders recursively). */
export async function collectDataTransfer(dt: DataTransfer | null): Promise<LocalEntry[]> {
  if (!dt) return []
  const out: LocalEntry[] = []
  const items = Array.from(dt.items || []).filter((i) => i.kind === 'file')
  const entries = items
    .map((i) => (typeof (i as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry === 'function'
      ? (i as unknown as { webkitGetAsEntry: () => FsEntry | null }).webkitGetAsEntry()
      : null))
  if (entries.length && entries.every((e) => e)) {
    for (const e of entries) await walk(e as FsEntry, '', out)
    return out
  }
  // Fallback: plain files (paste, or no entries API); keep relative folders when known.
  for (const file of Array.from(dt.files || [])) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || ''
    out.push({ dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', file })
  }
  return out
}
