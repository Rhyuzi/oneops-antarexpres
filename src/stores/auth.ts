import { reactive } from 'vue'
import axios from 'axios'

export interface AuthUser {
  id: number
  username: string
  fullName: string
  email?: string | null
  roles: string[]
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

export const authStore = {
  state,
  get isLoggedIn(): boolean {
    return state.user !== null
  },
  get isSuperAdmin(): boolean {
    return state.user?.roles.includes('super_admin') ?? false
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
  async fetchMe(): Promise<void> {
    if (state.checked) return
    try {
      const resp = await axios.get('/api/auth/me')
      state.user = resp.data.user ?? null
    } catch {
      state.user = null
    } finally {
      state.checked = true
    }
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
  },
}
