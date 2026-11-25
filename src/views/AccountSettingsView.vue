<script setup lang="ts">
/**
 * Account Settings — the signed-in user's own account:
 *  - account information: full name + email (username and roles are read-only;
 *    the server rejects any other field, so roles/permissions cannot be
 *    changed from here),
 *  - active role (Switch Role) when the account holds more than one role,
 *  - password change (current password required; other sessions signed out).
 * Every change is recorded in the Audit Trail by the server.
 */
import { computed, reactive, ref, watch } from 'vue'
import { Eye, EyeOff, KeyRound, ShieldCheck, UserCircle2 } from 'lucide-vue-next'
import LoadingButton from '../components/LoadingButton.vue'
import RoleSwitcher from '../components/account/RoleSwitcher.vue'
import { authStore } from '../stores/auth'
import { roleName } from '../composables/useRoleSwitch'
import { useAsyncAction } from '../composables/useAsyncAction'
import { t, type MessageKey } from '../i18n'
import { apiErrorMessage, localizeMessage } from '../i18n/systemMessages'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// -- account information ------------------------------------------------------
const profile = reactive({ full_name: '', email: '' })
const profileError = ref('')
const profileOk = ref('')
function loadProfile(): void {
  profile.full_name = authStore.state.user?.fullName ?? ''
  profile.email = authStore.state.user?.email ?? ''
}
loadProfile()
watch(() => [profile.full_name, profile.email], () => {
  profileError.value = ''
  profileOk.value = ''
})

const dirty = computed(
  () =>
    profile.full_name.trim() !== (authStore.state.user?.fullName ?? '') ||
    profile.email.trim().toLowerCase() !== (authStore.state.user?.email ?? '').toLowerCase()
)

function validateProfile(): MessageKey | '' {
  const name = profile.full_name.trim()
  if (name.length < 2 || name.length > 150) return 'account.nameLength'
  const email = profile.email.trim()
  if ((email || authStore.state.user?.email) && !EMAIL_RE.test(email)) return 'account.emailInvalid'
  return ''
}

const saveProfile = useAsyncAction(async (): Promise<void> => {
  const v = validateProfile()
  if (v) {
    profileError.value = t(v)
    return
  }
  try {
    const r = await authStore.updateProfile({ full_name: profile.full_name.trim(), email: profile.email.trim() })
    loadProfile() // the header/menu already show the stored values
    profileOk.value = r.changed.length ? localizeMessage(r.message) : t('account.noChanges')
  } catch (err) {
    profileError.value = apiErrorMessage(err, 'account.saveFailed')
  }
})

// -- password -----------------------------------------------------------------
const pw = reactive({ current: '', next: '', confirm: '' })
const show = reactive({ current: false, next: false, confirm: false })
const pwError = ref('')
const pwOk = ref('')
watch(() => [pw.current, pw.next, pw.confirm], () => {
  pwError.value = ''
})

function validatePassword(): MessageKey | '' {
  if (!pw.current || !pw.next) return 'account.pwRequired'
  if (pw.next.length < 8) return 'auth.pwMinLength'
  if (!/[A-Z]/.test(pw.next)) return 'auth.pwUpper'
  if (!/[a-z]/.test(pw.next)) return 'auth.pwLower'
  if (!/[0-9]/.test(pw.next)) return 'auth.pwDigit'
  if (!/[^A-Za-z0-9]/.test(pw.next)) return 'auth.pwSymbol'
  if (pw.next !== pw.confirm) return 'auth.pwMismatch'
  if (pw.next === pw.current) return 'account.pwSame'
  return ''
}

const changePassword = useAsyncAction(async (): Promise<void> => {
  pwOk.value = ''
  const v = validatePassword()
  if (v) {
    pwError.value = t(v)
    return
  }
  try {
    const message = await authStore.changePassword(pw.current, pw.next, pw.confirm)
    Object.assign(pw, { current: '', next: '', confirm: '' })
    pwError.value = ''
    pwOk.value = localizeMessage(message)
  } catch (err) {
    pwError.value = apiErrorMessage(err, 'account.pwFailed')
  }
})

const PW_FIELDS: Array<{ key: 'current' | 'next' | 'confirm'; label: MessageKey; autocomplete: string }> = [
  { key: 'current', label: 'account.pwCurrent', autocomplete: 'current-password' },
  { key: 'next', label: 'account.pwNew', autocomplete: 'new-password' },
  { key: 'confirm', label: 'account.pwConfirm', autocomplete: 'new-password' },
]
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-4">
    <div>
      <h1 class="flex items-center gap-2 text-xl font-bold text-slate-900">
        <UserCircle2 :size="22" class="text-indigo-600" /> {{ t('account.title') }}
      </h1>
      <p class="text-sm text-slate-500">{{ t('account.subtitle') }}</p>
    </div>

    <!-- Account information -->
    <form class="card space-y-4 p-5" novalidate @submit.prevent="saveProfile.run()">
      <h2 class="section-title">{{ t('account.infoTitle') }}</h2>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="label" for="acc-username">{{ t('account.username') }}</label>
          <input id="acc-username" class="input bg-slate-50 text-slate-500" :value="authStore.state.user?.username" readonly />
          <p class="mt-1 text-xs text-slate-400">{{ t('account.usernameHint') }}</p>
        </div>
        <div>
          <label class="label" for="acc-name">{{ t('account.fullName') }}</label>
          <input id="acc-name" v-model="profile.full_name" class="input" maxlength="150" autocomplete="name" required />
        </div>
        <div class="sm:col-span-2">
          <label class="label" for="acc-email">{{ t('account.email') }}</label>
          <input id="acc-email" v-model="profile.email" class="input" type="email" maxlength="190" autocomplete="email" />
          <p class="mt-1 text-xs text-slate-400">{{ t('account.emailHint') }}</p>
        </div>
      </div>
      <p v-if="profileError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{{ profileError }}</p>
      <p v-if="profileOk" class="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{{ profileOk }}</p>
      <div class="flex justify-end">
        <LoadingButton
          type="submit"
          class="btn btn-primary"
          :loading="saveProfile.pending"
          :disabled="!dirty"
          :loading-text="t('common.saving')"
        >
          {{ t('common.saveChanges') }}
        </LoadingButton>
      </div>
    </form>

    <!-- Roles: read-only list + Switch Role -->
    <section class="card space-y-3 p-5">
      <h2 class="section-title flex items-center gap-2"><ShieldCheck :size="18" class="text-indigo-600" /> {{ t('account.rolesTitle') }}</h2>
      <p class="text-sm text-slate-500">{{ t('account.rolesHint') }}</p>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="r in authStore.assignedRoles"
          :key="r"
          class="chip capitalize"
          :class="authStore.activeRole === r || !authStore.activeRole ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'"
        >
          {{ roleName(r) }}
        </span>
      </div>
      <div v-if="authStore.assignedRoles.length > 1" class="border-t border-slate-100 pt-3">
        <p class="mb-2 text-sm font-semibold text-slate-700">{{ t('account.switchRole') }}</p>
        <p class="mb-3 text-xs text-slate-500">{{ t('account.switchHint') }}</p>
        <RoleSwitcher />
      </div>
      <p v-else class="text-xs text-slate-400">{{ t('account.singleRole') }}</p>
    </section>

    <!-- Password -->
    <form class="card space-y-4 p-5" novalidate @submit.prevent="changePassword.run()">
      <h2 class="section-title flex items-center gap-2"><KeyRound :size="18" class="text-indigo-600" /> {{ t('account.pwTitle') }}</h2>
      <p class="text-sm text-slate-500">{{ t('account.pwHint') }}</p>
      <div class="grid gap-4 sm:grid-cols-3">
        <div v-for="f in PW_FIELDS" :key="f.key">
          <label class="label" :for="`acc-pw-${f.key}`">{{ t(f.label) }}</label>
          <div class="relative">
            <input
              :id="`acc-pw-${f.key}`"
              v-model="pw[f.key]"
              class="input pr-10"
              :type="show[f.key] ? 'text' : 'password'"
              :autocomplete="f.autocomplete"
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
              :aria-label="show[f.key] ? t('common.hide') : t('common.show')"
              @click="show[f.key] = !show[f.key]"
            >
              <EyeOff v-if="show[f.key]" :size="16" />
              <Eye v-else :size="16" />
            </button>
          </div>
        </div>
      </div>
      <p v-if="pwError" class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{{ pwError }}</p>
      <p v-if="pwOk" class="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{{ pwOk }}</p>
      <div class="flex justify-end">
        <LoadingButton type="submit" class="btn btn-primary" :loading="changePassword.pending" :loading-text="t('common.saving')">
          {{ t('account.pwSubmit') }}
        </LoadingButton>
      </div>
    </form>
  </div>
</template>
