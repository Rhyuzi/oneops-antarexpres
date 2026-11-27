import { ref, watch, type Ref } from 'vue'
import axios from 'axios'

/** Same rule as the server (server/routes/accounts.js USERNAME_RE); usernames are lower-case. */
export const USERNAME_RE = /^[a-z0-9._-]{3,64}$/

export type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'unchanged' | 'error'

/** Local part of the check (no request): idle / invalid / unchanged, or null when the server must be asked. */
export function localUsernameStatus(value: string, current?: string | null): UsernameStatus | null {
  const u = value.trim().toLowerCase()
  if (!u) return 'idle'
  if (current && u === current.toLowerCase()) return 'unchanged'
  if (!USERNAME_RE.test(u)) return 'invalid'
  return null
}

/**
 * Live "username already exists?" check for the Create Account and Admin
 * Reset Password forms (GET /api/accounts/username-available, debounced).
 * The server checks again on submit (409 when taken).
 */
export function useUsernameCheck(
  username: Readonly<Ref<string>>,
  opts: { excludeId?: Readonly<Ref<number | null>>; current?: Readonly<Ref<string | null>> } = {}
) {
  const status = ref<UsernameStatus>('idle')
  let timer = 0
  let seq = 0
  const run = () => {
    window.clearTimeout(timer)
    const local = localUsernameStatus(username.value, opts.current?.value)
    if (local) {
      status.value = local
      return
    }
    status.value = 'checking'
    const mine = ++seq
    timer = window.setTimeout(async () => {
      try {
        const { data } = await axios.get('/api/accounts/username-available', {
          params: { username: username.value.trim().toLowerCase(), excludeId: opts.excludeId?.value || undefined },
        })
        if (mine !== seq) return
        status.value = !data.valid ? 'invalid' : data.available ? 'available' : 'taken'
      } catch {
        if (mine === seq) status.value = 'error'
      }
    }, 300)
  }
  watch([() => username.value, () => opts.excludeId?.value, () => opts.current?.value], run)
  /** Blocks submit: taken or invalid (while checking, submit stays possible — the server checks again). */
  const blocks = () => status.value === 'taken' || status.value === 'invalid'
  const reset = () => {
    window.clearTimeout(timer)
    seq++
    status.value = 'idle'
  }
  return { status, blocks, reset, recheck: run }
}
