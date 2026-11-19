<script setup lang="ts">
import { CheckCircle2, Info, X, XCircle } from 'lucide-vue-next'
import { storageStore } from '../../stores/storage'
import { t } from '../../i18n'

const store = storageStore
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      <div
        v-for="toast in store.state.toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-2.5 rounded-xl border p-3.5 shadow-lg"
        :class="{
          'border-emerald-200 bg-emerald-50 text-emerald-800': toast.kind === 'success',
          'border-rose-200 bg-rose-50 text-rose-800': toast.kind === 'error',
          'border-slate-200 bg-white text-slate-700': toast.kind === 'info',
        }"
      >
        <CheckCircle2 v-if="toast.kind === 'success'" :size="18" class="mt-0.5 shrink-0" />
        <XCircle v-else-if="toast.kind === 'error'" :size="18" class="mt-0.5 shrink-0" />
        <Info v-else :size="18" class="mt-0.5 shrink-0" />
        <p class="flex-1 break-words text-sm">{{ toast.message }}</p>
        <button
          class="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100"
          :aria-label="t('storage.dismiss')"
          @click="store.dismissToast(toast.id)"
        >
          <X :size="14" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
