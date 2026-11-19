<script setup lang="ts">
/**
 * Drop-in <button> with a loading state. Classes, listeners and other
 * attributes fall through to the native button, so existing `.btn` styles
 * apply unchanged:
 *
 *   <LoadingButton class="btn btn-primary" :loading="save.pending"
 *                  loading-text="Saving…" @click="save.run()">Save</LoadingButton>
 *
 * - loading ⇒ disabled + aria-busy, spinner (+ optional loading text) shown.
 * - The label and the loading content share one grid cell (the hidden one
 *   stays `invisible`, not removed), so the button keeps the same size in
 *   both states — no layout shift when loading starts or ends.
 * - Defaults to type="button" so it never submits a form by accident; pass
 *   type="submit" for form submit buttons.
 */
import { Loader2 } from 'lucide-vue-next'
import { t } from '../i18n'

const props = withDefaults(
  defineProps<{
    loading?: boolean
    disabled?: boolean
    loadingText?: string
    type?: 'button' | 'submit' | 'reset'
    spinnerSize?: number
  }>(),
  { loading: false, disabled: false, loadingText: '', type: 'button', spinnerSize: 16 }
)
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled || props.loading"
    :aria-busy="props.loading ? 'true' : undefined"
  >
    <span class="inline-grid items-center [gap:inherit] [justify-content:inherit]">
      <span
        class="col-start-1 row-start-1 inline-flex items-center whitespace-nowrap [gap:inherit] [justify-content:inherit]"
        :class="{ invisible: props.loading }"
        :aria-hidden="props.loading ? 'true' : undefined"
      >
        <slot />
      </span>
      <span
        class="col-start-1 row-start-1 inline-flex items-center whitespace-nowrap [gap:inherit] [justify-content:inherit]"
        :class="{ invisible: !props.loading }"
        :aria-hidden="props.loading ? undefined : 'true'"
      >
        <Loader2 :size="props.spinnerSize" class="shrink-0 animate-spin" aria-hidden="true" />
        <span v-if="props.loadingText">{{ props.loadingText }}</span>
        <span v-else class="sr-only">{{ t('common.loading') }}</span>
      </span>
    </span>
  </button>
</template>
