<script setup lang="ts">
import { computed, type Component } from 'vue'

const props = defineProps<{
  label: string
  value: number | string
  icon: Component
  tone?: 'default' | 'success' | 'error' | 'warning' | 'info'
}>()

const toneClasses = computed(() => {
  switch (props.tone) {
    case 'success':
      return 'bg-emerald-100 text-emerald-700'
    case 'error':
      return 'bg-rose-100 text-rose-700'
    case 'warning':
      return 'bg-amber-100 text-amber-700'
    case 'info':
      return 'bg-sky-100 text-sky-700'
    default:
      return 'bg-indigo-100 text-indigo-700'
  }
})
</script>

<template>
  <div class="card flex items-start gap-3 p-4">
    <div class="rounded-xl p-2.5" :class="toneClasses">
      <component :is="icon" :size="20" />
    </div>
    <div class="min-w-0">
      <div class="text-2xl font-bold leading-tight text-slate-900">{{ value }}</div>
      <div class="text-xs font-medium text-slate-500">{{ label }}</div>
    </div>
  </div>
</template>
