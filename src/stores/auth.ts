import { reactive } from 'vue'
import axios from 'axios'

export interface AuthUser {
  id: number
  username: string
  fullName: string
  email?: string | null
  roles: string[]
  permissions: string[] | null
}

interface AuthState {
  user: AuthUser | null
  checked: boolean
  loading: boolean
  error: string | null
}

const state = reactive<AuthState>({
  user: null,
  checked: false,
  loading: false,
  error: null,
})

let pendingMe: Promise<void> | null = null

export const authStore = {
  state,
  get isLoggedIn(): boolean {
    return state.user !== null
  },
  get isSuperAdmin(): boolean {
    return state.user?.roles.includes('super_admin') ?? false
  },
  /** Module permission check (frontend affordance only — backend enforces). */
  can(permission: string): boolean {
    if (!state.user) return false
    if (state.user.roles.includes('super_admin')) return true
    return state.user.permissions?.includes(permission) ?? false
  },
  get displayName(): string {
    return state.user?.fullName || state.user?.username || ''
  },
  get initials(): string {
    const name = state.user?.fullName || state.user?.username || ''
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('')
  },
  /**
   * Restores the session from the HttpOnly cookie (sent automatically —
   * same-origin). Concurrent callers share one in-flight request. A network /
   * 5xx failure leaves `checked` false so the next navigation retries instead
   * of treating a transient outage as "logged out" for the rest of the page.
   */
  fetchMe(): Promise<void> {
    if (state.checked) return Promise.resolve()
    if (!pendingMe) {
      pendingMe = axios
        .get<{ user: AuthUser | null }>('/api/auth/me')
        .then((resp) => {
          state.user = resp.data.user ?? null
          state.checked = true
          state.error = null
        })
        .catch(() => {
          state.user = null
          state.error = 'Could not verify your session. Check your connection and try again.'
        })
        .finally(() => {
          pendingMe = null
        })
    }
    return pendingMe
  },
  /** Drops client-side auth state (server already rejected the session). */
  clearSession(): void {
    state.user = null
    state.checked = true
  },
  async login(username: string, password: string): Promise<boolean> {
    state.loading = true
    state.error = null
    try {
      const resp = await axios.post('/api/auth/login', { username, password })
      state.user = resp.data.user
      state.checked = true
      return true
    } catch (err: unknown) {
      // Raw server text (or the English fallback); views render it via
      // localizeMessage() so it follows the selected language.
      const e = err as { response?: { data?: { message?: string } } }
      state.error = e.response?.data?.message || 'Login failed.'
      return false
    } finally {
      state.loading = false
    }
  },
  async logout(): Promise<void> {
    try {
      await axios.post('/api/auth/logout')
    } catch {
      // ignore network failures on logout
    }
    state.user = null
    state.checked = true
  },
}
