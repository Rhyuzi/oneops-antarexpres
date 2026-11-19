<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ShieldCheck } from 'lucide-vue-next'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import { useAsyncAction } from '../composables/useAsyncAction'

const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')

// Guards both the button and Enter-key submits; stays loading until the
// post-login navigation finishes so the form cannot be re-submitted.
const submitAction = useAsyncAction(async (): Promise<void> => {
  if (!username.value || !password.value) return
  error.value = ''
  const ok = await authStore.login(username.value.trim(), password.value)
  if (ok) {
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/ops/data-warrior'
    await router.push(redirect)
  } else {
    error.value = authStore.state.error || 'Login failed.'
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center text-center">
        <div class="rounded-2xl bg-indigo-600 p-3 text-white shadow-lg shadow-indigo-200">
          <ShieldCheck :size="28" />
        </div>
        <h1 class="mt-4 text-2xl font-bold text-slate-900">OneOps</h1>
        <p class="mt-1 text-sm text-slate-500">AntarXpress operations platform</p>
      </div>

      <form class="card p-6" @submit.prevent="submitAction.run()">
        <div class="space-y-4">
          <div>
            <label class="label" for="username">Username</label>
            <input
              id="username"
              v-model="username"
              class="input"
              type="text"
              autocomplete="username"
              required
              autofocus
            />
          </div>
          <div>
            <label class="label" for="password">Password</label>
            <div class="relative">
              <input
                id="password"
                v-model="password"
                class="input pr-12"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-3 text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                @click="showPassword = !showPassword"
              >
                {{ showPassword ? 'HIDE' : 'SHOW' }}
              </button>
            </div>
          </div>

          <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {{ error }}
          </p>

          <LoadingButton
            class="btn btn-primary w-full"
            type="submit"
            loading-text="Signing in…"
            :loading="submitAction.pending"
          >
            Sign in
          </LoadingButton>

          <router-link
            class="block text-center text-sm font-medium text-indigo-600 hover:text-indigo-800"
            to="/forgot-password"
          >
            Forgot password?
          </router-link>
        </div>
      </form>

      <p class="mt-4 text-center text-xs text-slate-400">
        Authorized personnel only. Activity is logged.
      </p>
    </div>
  </div>
</template>
