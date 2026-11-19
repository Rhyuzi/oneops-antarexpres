<script setup lang="ts">
import { ref } from 'vue'
import { KeyRound, Mail, ShieldCheck } from 'lucide-vue-next'
import axios from 'axios'
import LoadingButton from '../components/LoadingButton.vue'
import { useAsyncAction } from '../composables/useAsyncAction'

const email = ref('')
const sent = ref(false)
const error = ref('')

const submitAction = useAsyncAction(async (): Promise<void> => {
  if (!email.value) return
  error.value = ''
  try {
    await axios.post('/api/auth/forgot-password', { email: email.value.trim() })
    sent.value = true
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    error.value = e.response?.data?.message || 'Request failed. Try again.'
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center text-center">
        <div class="rounded-2xl bg-indigo-600 p-3 text-white shadow-lg shadow-indigo-200">
          <KeyRound :size="28" />
        </div>
        <h1 class="mt-4 text-2xl font-bold text-slate-900">Forgot password</h1>
        <p class="mt-1 text-sm text-slate-500">We'll email you a reset link</p>
      </div>

      <div v-if="!sent" class="card p-6">
        <form class="space-y-4" @submit.prevent="submitAction.run()">
          <div>
            <label class="label" for="email">Registered email</label>
            <div class="relative">
              <Mail class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="16" />
              <input
                id="email"
                v-model="email"
                class="input pl-9"
                type="email"
                required
                autofocus
                placeholder="you@antarxpress.co.id"
              />
            </div>
          </div>
          <p v-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>
          <LoadingButton
            class="btn btn-primary w-full"
            type="submit"
            loading-text="Sending…"
            :loading="submitAction.pending"
          >
            Send reset link
          </LoadingButton>
          <router-link class="block text-center text-sm font-medium text-indigo-600 hover:text-indigo-800" to="/login">
            Back to sign in
          </router-link>
        </form>
      </div>

      <div v-else class="card p-6 text-center">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Mail :size="22" />
        </div>
        <p class="text-sm text-slate-600">
          If that email address belongs to an account, a reset link has been sent.
          Check your inbox (and spam folder).
        </p>
        <p class="mt-2 text-xs text-slate-400">The link expires in 30 minutes and works once.</p>
        <router-link class="btn btn-secondary mt-5 w-full" to="/login">Back to sign in</router-link>
      </div>

      <p class="mt-4 text-center text-xs text-slate-400">
        <ShieldCheck :size="12" class="mr-1 inline" /> OneOps — AntarXpress
      </p>
    </div>
  </div>
</template>
