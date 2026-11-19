<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ShieldCheck, UserCheck } from 'lucide-vue-next'
import axios from 'axios'
import NewPasswordForm from '../components/NewPasswordForm.vue'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { useAsyncAction } from '../composables/useAsyncAction'
import { t } from '../i18n'
import { localizeMessage } from '../i18n/systemMessages'

const router = useRouter()
const token = computed(() => String(router.currentRoute.value.query.token || ''))
// Raw messages (server English or '') — localized when rendered.
const errorRaw = ref('')
const successRaw = ref('')
const failed = ref(false)
const done = ref(false)
const error = computed(() => (errorRaw.value ? localizeMessage(errorRaw.value) : failed.value ? t('auth.activationFailed') : ''))
const success = computed(() => (successRaw.value ? localizeMessage(successRaw.value) : done.value ? t('auth.accountActivated') : ''))

const submitAction = useAsyncAction(async (password: string, confirm: string): Promise<void> => {
  errorRaw.value = ''
  failed.value = false
  try {
    const resp = await axios.post('/api/auth/activate-account', {
      token: token.value,
      password,
      confirmPassword: confirm,
    })
    successRaw.value = resp.data.message || ''
    done.value = true
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } }
    errorRaw.value = e.response?.data?.message || ''
    failed.value = true
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4">
    <div class="w-full max-w-sm">
      <div class="mb-4 flex justify-end">
        <LanguageSwitcher :show-label="false" />
      </div>
      <div class="mb-6 flex flex-col items-center text-center">
        <div class="rounded-2xl bg-emerald-600 p-3 text-white shadow-lg shadow-emerald-200">
          <UserCheck :size="28" />
        </div>
        <h1 class="mt-4 text-2xl font-bold text-slate-900">{{ t('auth.activateTitle') }}</h1>
        <p class="mt-1 text-sm text-slate-500">{{ t('auth.activateSubtitle') }}</p>
      </div>

      <div class="card p-6">
        <p v-if="!token" class="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          {{ t('auth.activateNeedsLink') }}
        </p>
        <NewPasswordForm
          v-else
          :submit-label="t('auth.activateAccount')"
          :submitting="submitAction.pending"
          :external-error="error"
          :external-message="success"
          @submit="submitAction.run"
        />
        <router-link v-if="success" class="btn btn-primary mt-4 w-full" to="/login">
          {{ t('auth.continueToSignIn') }}
        </router-link>
      </div>

      <p class="mt-4 text-center text-xs text-slate-400">
        <ShieldCheck :size="12" class="mr-1 inline" /> {{ t('common.brandFooter') }}
      </p>
    </div>
  </div>
</template>
