import { createRouter, createWebHistory } from 'vue-router'
import { authStore } from '../stores/auth'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('../views/ForgotPasswordView.vue'),
    meta: { public: true },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('../views/ResetPasswordView.vue'),
    meta: { public: true },
  },
  {
    path: '/activate-account',
    name: 'activate-account',
    component: () => import('../views/ActivateAccountView.vue'),
    meta: { public: true },
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
        meta: { title: 'Data Warrior', permission: 'data_warrior.view' },
      },
      {
        path: 'number-rechecking',
        name: 'number-rechecking',
        component: () => import('../views/NumberRecheckingView.vue'),
        meta: { title: 'Number Rechecking', permission: 'number_rechecking.view' },
      },
      {
        path: 'number-rechecking/settings',
        name: 'number-rechecking-settings',
        component: () => import('../views/NumberRecheckingSettingsView.vue'),
        meta: { title: 'Rechecker Settings', permission: 'number_rechecking.view' },
      },
      {
        path: 'access-management/roles',
        name: 'access-management-roles',
        component: () => import('../views/AccessManagementView.vue'),
        meta: { title: 'Roles & Permissions', superAdminOnly: true },
      },
      {
        path: 'access-management/accounts',
        name: 'access-management-accounts',
        component: () => import('../views/AccountManagementView.vue'),
        meta: { title: 'Account Management', permission: 'account_management.view' },
      },
    ],
  },
  {
    path: '/no-access',
    name: 'no-access',
    component: () => import('../views/NoAccessView.vue'),
    meta: { title: 'No access' },
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
    return { name: 'data-warrior' }
  }

  // Module permission gate.
  if (to.meta.permission && !auth.can(String(to.meta.permission))) {
    // User lacks this module entirely — land on the first module they CAN use.
    if (to.meta.superAdminOnly !== true) {
      if (auth.can('data_warrior.view')) return { name: 'data-warrior' }
      if (auth.can('number_rechecking.view')) return { name: 'number-rechecking' }
      if (auth.can('account_management.view')) return { name: 'access-management-accounts' }
    }
    return { name: 'no-access' }
  }
  return true
})

export default router
