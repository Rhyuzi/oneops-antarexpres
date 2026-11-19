<script setup lang="ts">
/**
 * Global language selector. Switching is instant (reactive locale), persists
 * in localStorage and never touches the auth session or the current route.
 *   <LanguageSwitcher />           segmented EN | ID control (sidebar, auth pages)
 *   <LanguageSwitcher compact />   single toggle button (collapsed sidebar)
 */
import { computed } from 'vue'
import { Languages } from 'lucide-vue-next'
import { SUPPORTED_LOCALES, locale, setLocale, t } from '../i18n'

const props = withDefaults(defineProps<{ compact?: boolean; showLabel?: boolean }>(), {
  compact: false,
  showLabel: true,
})

const next = computed(() => SUPPORTED_LOCALES.find((l) => l.code !== locale.value) ?? SUPPORTED_LOCALES[0])
const current = computed(() => SUPPORTED_LOCALES.find((l) => l.code === locale.value) ?? SUPPORTED_LOCALES[0])
</script>

<template>
  <button
    v-if="props.compact"
    type="button"
    class="flex w-full items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
    :title="t('lang.switchTo', { language: next.label })"
    :aria-label="t('lang.switchTo', { language: next.label })"
    @click="setLocale(next.code)"
  >
    <Languages :size="15" />
    {{ current.short }}
  </button>

  <div v-else class="flex items-center gap-2" role="group" :aria-label="t('lang.label')">
    <span v-if="props.showLabel" class="flex items-center gap-1.5 text-xs font-medium text-slate-500">
      <Languages :size="14" />
      {{ t('lang.label') }}
    </span>
    <div class="ml-auto inline-flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      <button
        v-for="l in SUPPORTED_LOCALES"
        :key="l.code"
        type="button"
        class="rounded-md px-2.5 py-1 text-xs font-semibold transition"
        :class="locale === l.code ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'"
        :title="l.label"
        :aria-label="l.label"
        :aria-pressed="locale === l.code"
        :lang="l.code"
        @click="setLocale(l.code)"
      >
        {{ l.short }}
      </button>
    </div>
  </div>
</template>
