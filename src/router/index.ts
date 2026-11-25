import axios from 'axios'
import { watch } from 'vue'
import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router'
import { authStore } from '../stores/auth'
import { locale, t, type MessageKey } from '../i18n'
import { landingRouteName } from './landing'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, titleKey: 'titles.login' },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('../views/ForgotPasswordView.vue'),
    meta: { public: true, titleKey: 'titles.forgotPassword' },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('../views/ResetPasswordView.vue'),
    meta: { public: true, titleKey: 'titles.resetPassword' },
  },
  {
    path: '/activate-account',
    name: 'activate-account',
    component: () => import('../views/ActivateAccountView.vue'),
    meta: { public: true, titleKey: 'titles.activateAccount' },
  },
  {
    path: '/',
    redirect: '/ops/data-warrior',
  },
  {
    path: '/ops',
    component: () => import('../layouts/OpsLayout.vue'),
    children: [
      {
        path: '',
        redirect: { name: 'data-warrior' },
      },
      {
        path: 'data-warrior',
        name: 'data-warrior',
        component: () => import('../views/DataWarriorView.vue'),
        meta: { titleKey: 'nav.dataWarrior', permission: 'data_warrior.view' },
      },
      {
        path: 'number-rechecking',
        name: 'number-rechecking',
        component: () => import('../views/NumberRecheckingView.vue'),
        meta: { titleKey: 'nav.numberRechecking', permission: 'number_rechecking.view' },
      },
      {
        path: 'number-rechecking/settings',
        name: 'number-rechecking-settings',
        component: () => import('../views/NumberRecheckingSettingsView.vue'),
        // Token settings only matter for running lookups.
        meta: { titleKey: 'nav.recheckerSettings', permission: 'number_rechecking.run' },
      },
      {
        path: 'kodepos-loader',
        name: 'kodepos-loader',
        component: () => import('../views/KodeposLoaderView.vue'),
        meta: { titleKey: 'nav.kodeposLoader', permission: 'loader.view' },
      },
      // Master Data — loader reference data CRUD (one route per tab).
      { path: 'master-data', redirect: { name: 'master-data-hubs' } },
      {
        path: 'master-data/hubs',
        name: 'master-data-hubs',
        component: () => import('../views/MasterDataView.vue'),
        meta: { titleKey: 'nav.mdHubs', permission: 'master_data.view', tab: 'hubs' },
      },
      {
        path: 'master-data/kota-wilayah',
        name: 'master-data-kota-wilayah',
        component: () => import('../views/MasterDataView.vue'),
        meta: { titleKey: 'nav.mdKotaWilayah', permission: 'master_data.view', tab: 'kota-wilayah' },
      },
      {
        path: 'master-data/kodepos',
        name: 'master-data-kodepos',
        component: () => import('../views/MasterDataView.vue'),
        meta: { titleKey: 'nav.mdKodepos', permission: 'master_data.view', tab: 'kodepos' },
      },
      {
        path: 'master-data/audit',
        name: 'master-data-audit',
        component: () => import('../views/MasterDataView.vue'),
        meta: { titleKey: 'nav.mdAudit', permission: 'master_data.audit', tab: 'audit' },
      },
      {
        path: 'access-management/roles',
        name: 'access-management-roles',
        component: () => import('../views/AccessManagementView.vue'),
        meta: { titleKey: 'nav.rolesPermissions', superAdminOnly: true },
      },
      {
        path: 'access-management/accounts',
        name: 'access-management-accounts',
        component: () => import('../views/AccountManagementView.vue'),
        meta: { titleKey: 'nav.accountManagement', permission: 'account_management.view' },
      },
      {
        // Own account: profile, password, active role. Signed-in users only.
        path: 'account',
        name: 'account-settings',
        component: () => import('../views/AccountSettingsView.vue'),
        meta: { titleKey: 'account.title' },
      },
      {
        path: 'audit-trail',
        name: 'audit-trail',
        component: () => import('../views/AuditTrailView.vue'),
        meta: { titleKey: 'nav.auditTrail', permission: 'audit_trail.view' },
      },
    ],
  },
  {
    path: '/no-access',
    name: 'no-access',
    component: () => import('../views/NoAccessView.vue'),
    meta: { titleKey: 'titles.noAccess' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/ops/data-warrior',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Session expired / revoked while the app is open (TTL reached, password
// changed, logged out in another tab): the backend answers 401 → drop the
// stale client state and send the user to login, returning here afterwards.
// Auth endpoints are excluded — their 401s are handled by the views.
axios.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401) {
    const url = error.config?.url ?? ''
    if (!url.startsWith('/api/auth/') && authStore.state.user) {
      authStore.clearSession()
      const current = router.currentRoute.value
      if (!current.meta.public) {
        void router.replace({ name: 'login', query: { redirect: current.fullPath, expired: '1' } })
      }
    }
  }
  return Promise.reject(error)
})

router.beforeEach(async (to) => {
  const auth = authStore

  // Try to restore the session once per page load.
  if (!auth.state.checked) {
    await auth.fetchMe()
  }

  if (to.meta.public) {
    // Logged-in users never see auth/lifecycle pages (except login → app).
    if (auth.state.user && to.name !== 'activate-account') {
      return { name: 'data-warrior' }
    }
    return true
  }

  if (!auth.state.user) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  // Super-admin-only routes.
  if (to.meta.superAdminOnly && !auth.isSuperAdmin) {
    return { name: landingRouteName() }
  }

  // Module permission gate.
  if (to.meta.permission && !auth.can(String(to.meta.permission))) {
    // User lacks this module entirely — land on the first module they CAN use.
    if (to.meta.superAdminOnly !== true) return { name: landingRouteName() }
    return { name: 'no-access' }
  }
  return true
})

// Localized document title; re-applied when the language changes.
function applyTitle(route: RouteLocationNormalized): void {
  const key = route.meta.titleKey as MessageKey | undefined
  document.title = key ? `${t(key)} · ${t('common.appName')}` : t('common.appName')
}
router.afterEach((to) => applyTitle(to))
watch(locale, () => applyTitle(router.currentRoute.value))

export default router
