/**
 * Multi-select rules for Data Warrior (folders + files of the current view, in
 * display order). Pure and immutable — every function returns a new state —
 * so the rules are unit-tested without a browser (tests/test-selection.js).
 *
 *   click          → only this item; anchor = active = it
 *   Ctrl/Cmd+click → toggle it, keep the others; anchor = active = it
 *   Shift+click    → range anchor…target, ADDED to what was selected when the
 *                    anchor was set (so earlier Ctrl/Cmd+click picks survive;
 *                    a new Shift+click replaces the previous range); active = target
 *   Ctrl/Cmd+Shift+click → range added to the current selection
 *   Shift+↑/↓      → active ±1, selection = base ∪ range anchor…active
 *   Ctrl/Cmd+↑/↓   → active ±1 only (selection unchanged)
 *   ↑/↓            → active ±1, only that item selected (new anchor)
 *   Space          → toggle the active item (with Ctrl/Cmd+↑/↓: pick items one by one)
 *   Ctrl/Cmd+A     → select all          Esc → clear
 */

export interface SelectionState {
  /** Selected item keys ("folder:12", "file:7"). */
  selected: ReadonlySet<string>
  /** Start of Shift ranges (index into keys). */
  anchor: number | null
  /** Focused item (index into keys). */
  active: number | null
  /** Selection when the anchor was set: Shift ranges are added to it. */
  base: ReadonlySet<string>
}

export interface Modifiers {
  shift?: boolean
  /** Ctrl on Windows/Linux, Cmd on macOS (event.ctrlKey || event.metaKey). */
  ctrl?: boolean
}

export type SelectAllState = 'none' | 'some' | 'all'

export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: null, active: null, base: new Set() }
}

/** event → modifiers (Cmd counts as Ctrl). */
export function modifiersOf(e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): Modifiers {
  return { shift: Boolean(e.shiftKey), ctrl: Boolean(e.ctrlKey || e.metaKey) }
}

function rangeKeys(keys: readonly string[], a: number, b: number): string[] {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(keys.length - 1, Math.max(a, b))
  return keys.slice(lo, hi + 1)
}

const clamp = (i: number, keys: readonly string[]) => Math.min(Math.max(0, i), keys.length - 1)

/** Mouse click (item body or its checkbox) on keys[index]. */
export function clickItem(s: SelectionState, keys: readonly string[], index: number, mod: Modifiers = {}): SelectionState {
  if (index < 0 || index >= keys.length) return s
  const key = keys[index]
  if (mod.shift && s.anchor !== null && s.anchor < keys.length) {
    const range = rangeKeys(keys, s.anchor, index)
    if (mod.ctrl) {
      const selected = new Set([...s.selected, ...range])
      return { selected, anchor: s.anchor, active: index, base: selected }
    }
    return { selected: new Set([...s.base, ...range]), anchor: s.anchor, active: index, base: s.base }
  }
  if (mod.ctrl) {
    const selected = new Set(s.selected)
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    return { selected, anchor: index, active: index, base: selected }
  }
  // Plain click (or Shift without an anchor yet).
  const only = new Set([key])
  return { selected: only, anchor: index, active: index, base: only }
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

/** Arrow keys (and Home/End) with Shift / Ctrl·Cmd. */
export function moveActive(s: SelectionState, keys: readonly string[], key: NavKey, mod: Modifiers = {}): SelectionState {
  if (!keys.length) return s
  let next: number
  if (key === 'Home') next = 0
  else if (key === 'End') next = keys.length - 1
  else if (s.active === null) next = key === 'ArrowDown' ? 0 : keys.length - 1
  else next = clamp(s.active + (key === 'ArrowDown' ? 1 : -1), keys)

  if (mod.shift) {
    // No anchor yet: the range starts at the current (or the new) active item.
    const anchor = s.anchor !== null && s.anchor < keys.length ? s.anchor : s.active ?? next
    const base = s.anchor !== null ? s.base : s.selected
    return { selected: new Set([...base, ...rangeKeys(keys, anchor, next)]), anchor, active: next, base }
  }
  if (mod.ctrl) return { ...s, active: next }
  const only = new Set([keys[next]])
  return { selected: only, anchor: next, active: next, base: only }
}

/** Space: toggle the active item, which becomes the anchor. */
export function toggleActive(s: SelectionState, keys: readonly string[]): SelectionState {
  if (s.active === null || s.active >= keys.length) return s
  return clickItem(s, keys, s.active, { ctrl: true })
}

export function selectAll(s: SelectionState, keys: readonly string[]): SelectionState {
  const all = new Set(keys)
  return { selected: all, anchor: s.anchor ?? (keys.length ? 0 : null), active: s.active, base: all }
}

export function clearSelection(s: SelectionState): SelectionState {
  return { selected: new Set(), anchor: null, active: s.active, base: new Set() }
}

/** The header checkbox: all → none, otherwise → all. */
export function toggleAll(s: SelectionState, keys: readonly string[]): SelectionState {
  return selectAllState(s, keys) === 'all' ? clearSelection(s) : selectAll(s, keys)
}

/** checked / unchecked / indeterminate for the "Select all" checkbox. */
export function selectAllState(s: SelectionState, keys: readonly string[]): SelectAllState {
  const n = keys.filter((k) => s.selected.has(k)).length
  if (!n) return 'none'
  return n === keys.length ? 'all' : 'some'
}

/** The list changed (navigation, search, paging, delete): drop gone keys, clamp indexes. */
export function syncSelection(s: SelectionState, keys: readonly string[]): SelectionState {
  const present = new Set(keys)
  const selected = new Set([...s.selected].filter((k) => present.has(k)))
  const base = new Set([...s.base].filter((k) => present.has(k)))
  const fix = (i: number | null) => (i === null || !keys.length ? null : clamp(i, keys))
  return { selected, anchor: fix(s.anchor), active: fix(s.active), base }
}

/** Selected keys in display order. */
export function selectedInOrder(s: SelectionState, keys: readonly string[]): string[] {
  return keys.filter((k) => s.selected.has(k))
}

// -- Selection mode (checkboxes hidden until the user starts selecting) -------------------
//
//   off: checkboxes hidden; plain click / arrows only move the focus (focusItem);
//        Ctrl/Cmd or Shift (click or arrows), Space, Ctrl/Cmd+A, the header "Select"
//        button or "Select" in an item's ⋮ menu switch the mode on.
//   on:  checkboxes shown, all rules above apply; "Done" / Esc switch it off and clear.

/** true when this click / key starts selecting (modifier held). */
export function startsSelection(mod: Modifiers = {}): boolean {
  return Boolean(mod.shift || mod.ctrl)
}

/** Focus keys[index] without selecting it (mode off). */
export function focusItem(s: SelectionState, keys: readonly string[], index: number): SelectionState {
  if (index < 0 || index >= keys.length) return s
  return { ...s, active: index, anchor: index, base: s.selected }
}

/** "Select" in an item's ⋮ menu: add the item (never toggles it off); it becomes anchor + active. */
export function pickItem(s: SelectionState, keys: readonly string[], index: number): SelectionState {
  if (index < 0 || index >= keys.length) return s
  const selected = new Set([...s.selected, keys[index]])
  return { selected, anchor: index, active: index, base: selected }
}
