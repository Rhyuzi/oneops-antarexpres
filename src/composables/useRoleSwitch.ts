import { reactive } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { authStore } from '../stores/auth'
import { apiErrorMessage } from '../i18n/systemMessages'
import { landingRouteName } from '../router/landing'

/**
 * Switch Role, shared by the account menu and the Account Settings page.
 *
 * The server validates the role and re-signs the session; this only applies
 * the returned user (roles + permissions), then:
 *  - leaves the current page when the new role may not open it (the router
 *    guard then lands on the first module the role can use),
 *  - bumps `sessionKey`, which re-mounts the page so lists loaded with the
 *    previous role's rights (folders, loader jobs, master data …) reload,
 *  - shows a short notice in the layout.
 */
const state = reactive({
  pendingRole: undefined as string | null | undefined,
  error: '',
  /** Role just switched to (null = all roles) — the layout notice. */
  notice: undefined as string | null | undefined,
  /** Changes on every successful switch (router-view key). */
  sessionKey: 0,
})
let noticeTimer = 0

/** Pretty role name: data from the DB, shown as stored minus underscores. */
export function roleName(role: string): string {
  return role.replace(/_/g, ' ')
}

function routeAllowed(route: RouteLocationNormalizedLoaded): boolean {
  if (route.meta.superAdminOnly && !authStore.isSuperAdmin) return false
  if (route.meta.permission && !authStore.can(String(route.meta.permission))) return false
  return true
}

export function useRoleSwitch() {
  async function switchTo(role: string | null, router: Router): Promise<boolean> {
    if (state.pendingRole !== undefined) return false
    if (role === authStore.activeRole) return true
    state.pendingRole = role
    state.error = ''
    try {
      await authStore.switchRole(role)
      state.sessionKey++
      const current = router.currentRoute.value
      if (!routeAllowed(current)) await router.replace({ name: landingRouteName() })
      state.notice = role
      window.clearTimeout(noticeTimer)
      noticeTimer = window.setTimeout(() => (state.notice = undefined), 5000)
      return true
    } catch (err) {
      state.error = apiErrorMessage(err, 'account.switchFailed')
      return false
    } finally {
      state.pendingRole = undefined
    }
  }
  function dismissNotice(): void {
    state.notice = undefined
  }
  return { state, switchTo, dismissNotice }
}
