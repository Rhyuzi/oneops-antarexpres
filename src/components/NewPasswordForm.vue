<script setup lang="ts">
// Shared password-setting form for account activation and password reset.
// Emits (password) on success; parent supplies the API call + copy.
import { reactive, ref, watch } from 'vue'
import { Eye, EyeOff } from 'lucide-vue-next'
import LoadingButton from './LoadingButton.vue'
import { t, type MessageKey } from '../i18n'

const props = defineProps<{
  submitLabel: string
  submitting: boolean
  externalError: string
  externalMessage: string
}>()

const emit = defineEmits<{ (e: 'submit', password: string, confirm: string): void }>()

const form = reactive({ password: '', confirm: '' })
const show = reactive({ pw: false, cf: false })
// A key (not text) so the message follows a language switch.
const localError = ref<MessageKey | ''>('')

watch(
  () => [form.password, form.confirm],
  () => {
    localError.value = ''
  }
)

function validate(): MessageKey | '' {
  const pw = form.password
  if (pw.length < 8) return 'auth.pwMinLength'
  if (!/[A-Z]/.test(pw)) return 'auth.pwUpper'
  if (!/[a-z]/.test(pw)) return 'auth.pwLower'
  if (!/[0-9]/.test(pw)) return 'auth.pwDigit'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'auth.pwSymbol'
  return ''
}

function onSubmit(): void {
  // Enter key submits the form even while the button is disabled.
  if (props.submitting) return
  const v = validate()
  if (v) {
    localError.value = v
    return
  }
  if (form.password !== form.confirm) {
    localError.value = 'auth.pwMismatch'
    return
  }
  emit('submit', form.password, form.confirm)
}
</script>

<template>
  <div>
    <div v-if="props.externalMessage" class="mb-4 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
      {{ props.externalMessage }}
    </div>

    <form v-if="!props.externalMessage" class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label class="label" for="new-password">{{ t('auth.newPassword') }}</label>
        <div class="relative">
          <input
            id="new-password"
            v-model="form.password"
            class="input pr-11"
            :type="show.pw ? 'text' : 'password'"
            autocomplete="new-password"
            required
            autofocus
          />
          <button
            type="button"
            class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
            :aria-label="show.pw ? t('common.hide') : t('common.show')"
            @click="show.pw = !show.pw"
          >
            <Eye v-if="!show.pw" :size="17" />
            <EyeOff v-else :size="17" />
          </button>
        </div>
      </div>

      <div>
        <label class="label" for="confirm-password">{{ t('auth.confirmPassword') }}</label>
        <div class="relative">
          <input
            id="confirm-password"
            v-model="form.confirm"
            class="input pr-11"
            :type="show.cf ? 'text' : 'password'"
            autocomplete="new-password"
            required
          />
          <button
            type="button"
            class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
            :aria-label="show.cf ? t('common.hide') : t('common.show')"
            @click="show.cf = !show.cf"
          >
            <Eye v-if="!show.cf" :size="17" />
            <EyeOff v-else :size="17" />
          </button>
        </div>
      </div>

      <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        {{ t('auth.passwordPolicyHint') }}
      </p>

      <p v-if="localError || props.externalError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
        {{ localError ? t(localError) : props.externalError }}
      </p>

      <LoadingButton
        class="btn btn-primary w-full"
        type="submit"
        :loading-text="t('common.working')"
        :loading="props.submitting"
      >
        {{ props.submitLabel }}
      </LoadingButton>
    </form>
  </div>
</template>
