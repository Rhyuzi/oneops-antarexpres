import { reactive } from 'vue'

/**
 * Duplicate-action prevention for buttons, forms and row actions.
 *
 * Guards are checked and set SYNCHRONOUSLY on the reactive state, so a second
 * click (or Enter key) that arrives before Vue re-renders the disabled button
 * is still rejected. Cleanup always happens in `finally`, so a failed or
 * throwing operation never leaves a control stuck in its loading state.
 */

export interface AsyncAction<A extends unknown[], R> {
  /** True while the operation is running (drives `:loading`). */
  readonly pending: boolean
  /** Runs the operation unless it is already running (then resolves undefined). */
  run: (...args: A) => Promise<R | undefined>
}

export function useAsyncAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R
): AsyncAction<A, R> {
  const state = reactive({ pending: false })

  async function run(...args: A): Promise<R | undefined> {
    if (state.pending) return undefined
    state.pending = true
    try {
      return await fn(...args)
    } finally {
      state.pending = false
    }
  }

  return {
    get pending() {
      return state.pending
    },
    run,
  }
}

export type ActionKey = string | number

export interface KeyedActions {
  /** Any operation running for this entity (disable its other mutation controls). */
  isBusy: (key: ActionKey) => boolean
  /** This specific operation running for this entity (show the spinner). */
  isPending: (key: ActionKey, tag: string) => boolean
  /**
   * Runs `fn` for an entity unless an operation for the same entity is already
   * in flight — independent entities (table rows) never block each other.
   */
  run: <R>(key: ActionKey, tag: string, fn: () => Promise<R> | R) => Promise<R | undefined>
}

export function useKeyedActions(): KeyedActions {
  const active = reactive(new Map<ActionKey, string>())

  return {
    isBusy: (key) => active.has(key),
    isPending: (key, tag) => active.get(key) === tag,
    async run(key, tag, fn) {
      if (active.has(key)) return undefined
      active.set(key, tag)
      try {
        return await fn()
      } finally {
        active.delete(key)
      }
    },
  }
}

/**
 * Resolves on the next animation frame. Used around CPU-bound synchronous
 * work (e.g. writing an Excel file): awaiting it BEFORE the work lets the
 * spinner paint; awaiting it AFTER keeps the button disabled until clicks
 * queued during the blocked main thread have been dispatched (they are
 * delivered before the frame), so they cannot start a second run.
 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}
