<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ShieldCheck, UserCheck } from 'lucide-vue-next'
import axios from 'axios'
import NewPasswordForm from '../components/NewPasswordForm.vue'

const router = useRouter()
const token = computed(() => String(router.currentRoute.value.query.token || ''))
const submitting = ref(false)
const error = ref('')
const success = ref('')

async function onSubmit(password: string, confirm: string): Promise<void> {
  submitting.value = true
  error.value = ''
  try {
    const resp = await axios.post('/api/auth/activate-account', {
      token: token.value,
      password,
      confirmPassword: confirm,
    })
    success.value = resp.data.message || 'Account activated.'
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    error.value = e.response?.data?.message || 'Activation failed.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center text-center">
        <div class="rounded-2xl bg-emerald-600 p-3 text-white shadow-lg shadow-emerald-200">
          <UserCheck :size="28" />
        </div>
        <h1 class="mt-4 text-2xl font-bold text-slate-900">Activate your account</h1>
        <p class="mt-1 text-sm text-slate-500">Set your password to finish setting up OneOps</p>
      </div>

      <div class="card p-6">
        <p v-if="!token" class="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          This page needs a valid activation link from your invitation email.
          Ask your administrator to resend the invitation if you lost it.
        </p>
        <NewPasswordForm
          v-else
          submit-label="Activate account"
          :submitting="submitting"
          :external-error="error"
          :external-message="success"
          @submit="onSubmit"
        />
        <router-link v-if="success" class="btn btn-primary mt-4 w-full" to="/login">
          Continue to sign in
        </router-link>
      </div>

      <p class="mt-4 text-center text-xs text-slate-400">
        <ShieldCheck :size="12" class="mr-1 inline" /> OneOps — AntarXpress
      </p>
    </div>
  </div>
</template>
