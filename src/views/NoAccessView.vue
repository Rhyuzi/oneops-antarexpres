<script setup lang="ts">
import { useRouter } from 'vue-router'
import { LogOut, ShieldOff } from 'lucide-vue-next'
import { authStore } from '../stores/auth'
import LoadingButton from '../components/LoadingButton.vue'
import { useAsyncAction } from '../composables/useAsyncAction'

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
    <h1 class="mt-5 text-xl font-bold text-slate-900">No module access</h1>
    <p class="mt-2 max-w-md text-sm text-slate-500">
      Your account is signed in, but no application modules have been granted to your role yet.
      Ask a Super Admin to assign permissions through Access Management.
    </p>
    <p class="mt-1 text-xs text-slate-400">Signed in as {{ authStore.displayName }}</p>
    <LoadingButton
      class="btn btn-secondary mt-6"
      loading-text="Signing out…"
      :loading="logoutAction.pending"
      @click="logoutAction.run()"
    >
      <LogOut :size="16" /> Sign out
    </LoadingButton>
  </div>
</template>
