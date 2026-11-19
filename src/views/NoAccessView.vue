<script setup lang="ts">
import { useRouter } from 'vue-router'
import { LogOut, ShieldOff } from 'lucide-vue-next'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { useAsyncAction } from '../composables/useAsyncAction'
import { t } from '../i18n'

const router = useRouter()

const logoutAction = useAsyncAction(async (): Promise<void> => {
  await authStore.logout()
  await router.push('/login')
})
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center bg-slate-100 px-4 text-center">
    <div class="rounded-2xl bg-rose-100 p-4 text-rose-600">
      <ShieldOff :size="32" />
    </div>
    <h1 class="mt-5 text-xl font-bold text-slate-900">{{ t('auth.noAccessTitle') }}</h1>
    <p class="mt-2 max-w-md text-sm text-slate-500">
      {{ t('auth.noAccessBody') }}
    </p>
    <p class="mt-1 text-xs text-slate-400">{{ t('auth.signedInAs', { name: authStore.displayName }) }}</p>
    <LoadingButton
      class="btn btn-secondary mt-6"
      :loading-text="t('nav.signingOut')"
      :loading="logoutAction.pending"
      @click="logoutAction.run()"
    >
      <LogOut :size="16" /> {{ t('nav.signOut') }}
    </LoadingButton>
    <div class="mt-6 w-48">
      <LanguageSwitcher />
    </div>
  </div>
</template>
