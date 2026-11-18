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
        meta: { title: 'Data Warrior' },
      },
      {
        path: 'number-rechecking',
        name: 'number-rechecking',
        component: () => import('../views/NumberRecheckingView.vue'),
        meta: { title: 'Number Rechecking' },
      },
      {
        path: 'number-rechecking/settings',
        name: 'number-rechecking-settings',
        component: () => import('../views/NumberRecheckingSettingsView.vue'),
        meta: { title: 'Rechecker Settings' },
      },
    ],
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
    // Already logged in → go straight to the app.
    if (auth.state.user) return { name: 'data-warrior' }
    return true
  }

  if (!auth.state.user) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

export default router
