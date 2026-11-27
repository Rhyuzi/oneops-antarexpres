/**
 * Folder tree for the Data Warrior "Move" dialog — pure, so the rules are
 * unit-tested without a browser (tests/test-folder-tree.js).
 *
 *  - The tree starts at a virtual Root node (key ROOT); every node starts
 *    COLLAPSED, Root included.
 *  - Blocked targets (disabled in the picker; the API refuses them too):
 *      moving        a folder that is being moved
 *      inside        a descendant of a folder that is being moved
 *      source        the folder the items are in now (same location)
 *      no_permission no create-folder (moving folders) / upload (moving files) right
 *      root_files    Root while files are moved (files always live in a folder)
 *      root_admin    Root for non Super Admins (top-level folders are admin-only)
 *  - Search: case-insensitive "contains"; matches keep their parent path
 *    (two "Garut" under different parents stay distinguishable) and their
 *    ancestors are expanded automatically.
 */

export interface TreeFolder {
  id: number
  parent_id: number | null
  name: string
  permissions?: { can_create_folder?: boolean; can_upload?: boolean }
}

/** The virtual Root node. */
export const ROOT = 'root' as const
export type NodeKey = number | typeof ROOT

export type BlockReason = 'moving' | 'inside' | 'source' | 'no_permission' | 'root_files' | 'root_admin'

export interface TreeRow {
  key: NodeKey
  name: string
  depth: number
  hasChildren: boolean
  expanded: boolean
  blocked: BlockReason | null
  /** Search match (highlighted). */
  match: boolean
  /** Parent path of a match while searching ("Root / 2025 / Garut"). */
  parentPath: string | null
}

const byName = (a: TreeFolder, b: TreeFolder) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

export function childrenMap(folders: readonly TreeFolder[]): Map<number | null, TreeFolder[]> {
  const ids = new Set(folders.map((f) => f.id))
  const map = new Map<number | null, TreeFolder[]>()
  for (const f of folders) {
    // A folder whose parent is not visible to the user hangs under Root.
    const parent = f.parent_id !== null && ids.has(f.parent_id) ? f.parent_id : null
    if (!map.has(parent)) map.set(parent, [])
    map.get(parent)!.push(f)
  }
  for (const list of map.values()) list.sort(byName)
  return map
}

/** Ancestor ids of a folder, nearest first (cycle-safe). */
export function ancestorsOf(id: number, folders: readonly TreeFolder[]): number[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: number[] = []
  let cur = byId.get(id)
  const seen = new Set<number>([id])
  while (cur && cur.parent_id !== null && byId.has(cur.parent_id) && !seen.has(cur.parent_id)) {
    out.push(cur.parent_id)
    seen.add(cur.parent_id)
    cur = byId.get(cur.parent_id)
  }
  return out
}

/** ["Root", "2026", "November", "Garut"] for a folder; ["Root"] for ROOT. */
export function pathNames(key: NodeKey, folders: readonly TreeFolder[], rootLabel = 'Root'): string[] {
  if (key === ROOT) return [rootLabel]
  const byId = new Map(folders.map((f) => [f.id, f]))
  const self = byId.get(key)
  if (!self) return [rootLabel]
  const names = ancestorsOf(key, folders).reverse().map((id) => byId.get(id)!.name)
  return [rootLabel, ...names, self.name]
}

export function pathText(key: NodeKey, folders: readonly TreeFolder[], rootLabel = 'Root'): string {
  return pathNames(key, folders, rootLabel).join(' / ')
}

/** The moved folders and all their descendants. */
export function descendantsOf(ids: readonly number[], folders: readonly TreeFolder[]): Set<number> {
  const kids = childrenMap(folders)
  const out = new Set<number>()
  const stack = [...ids]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of kids.get(id) || []) {
      if (!out.has(c.id) && !ids.includes(c.id)) {
        out.add(c.id)
        stack.push(c.id)
      }
    }
  }
  return out
}

export interface MoveContext {
  folders: readonly TreeFolder[]
  /** Folders being moved. */
  movingFolderIds: readonly number[]
  /** Files are moved too (then Root is not allowed and upload rights matter). */
  movingFiles: boolean
  /** Where the items are now (null = Root). */
  sourceParentIds: ReadonlyArray<number | null>
  isSuperAdmin: boolean
}

/** Why a target is not allowed (null = allowed). */
export function blockedReason(key: NodeKey, ctx: MoveContext): BlockReason | null {
  if (key === ROOT) {
    if (ctx.movingFiles) return 'root_files'
    if (!ctx.isSuperAdmin) return 'root_admin'
    if (ctx.sourceParentIds.includes(null)) return 'source'
    return null
  }
  if (ctx.movingFolderIds.includes(key)) return 'moving'
  if (descendantsOf(ctx.movingFolderIds, ctx.folders).has(key)) return 'inside'
  if (ctx.sourceParentIds.includes(key)) return 'source'
  const f = ctx.folders.find((x) => x.id === key)
  if (f && f.permissions) {
    if (ctx.movingFolderIds.length && !f.permissions.can_create_folder) return 'no_permission'
    if (ctx.movingFiles && !f.permissions.can_upload) return 'no_permission'
  }
  return null
}

export interface SearchResult {
  matches: Set<number>
  /** Ancestors to show / expand (Root implied). */
  expand: Set<NodeKey>
}

export function searchTree(folders: readonly TreeFolder[], query: string): SearchResult | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const matches = new Set(folders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => f.id))
  const expand = new Set<NodeKey>([ROOT])
  for (const id of matches) for (const a of ancestorsOf(id, folders)) expand.add(a)
  return { matches, expand }
}

/**
 * The rows to render, in tree order. `expanded` = keys opened by the user
 * (empty → only the collapsed Root row). While searching, only matches and
 * their ancestors are shown, all expanded.
 */
export function visibleRows(
  ctx: MoveContext,
  expanded: ReadonlySet<NodeKey>,
  query = '',
  rootLabel = 'Root'
): TreeRow[] {
  const kids = childrenMap(ctx.folders)
  const search = searchTree(ctx.folders, query)
  const rows: TreeRow[] = []
  const isOpen = (key: NodeKey) => (search ? search.expand.has(key) : expanded.has(key))
  const inSearch = (id: number) => !search || search.matches.has(id) || search.expand.has(id)

  rows.push({
    key: ROOT,
    name: rootLabel,
    depth: 0,
    hasChildren: (kids.get(null) || []).length > 0,
    expanded: isOpen(ROOT),
    blocked: blockedReason(ROOT, ctx),
    match: false,
    parentPath: null,
  })
  const walk = (parent: number | null, depth: number) => {
    for (const f of kids.get(parent) || []) {
      if (!inSearch(f.id)) continue
      const children = kids.get(f.id) || []
      const match = Boolean(search && search.matches.has(f.id))
      rows.push({
        key: f.id,
        name: f.name,
        depth,
        hasChildren: children.length > 0,
        expanded: isOpen(f.id),
        blocked: blockedReason(f.id, ctx),
        match,
        parentPath: match ? pathNames(f.id, ctx.folders, rootLabel).slice(0, -1).join(' / ') : null,
      })
      if (isOpen(f.id)) walk(f.id, depth + 1)
    }
  }
  if (isOpen(ROOT)) walk(null, 1)
  return rows
}

/** Toggle one node (immutable). */
export function toggleNode(expanded: ReadonlySet<NodeKey>, key: NodeKey): Set<NodeKey> {
  const next = new Set(expanded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
