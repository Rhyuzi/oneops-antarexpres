<script setup lang="ts">
import { ref } from 'vue'
import { UploadCloud } from 'lucide-vue-next'
import LoadingButton from './LoadingButton.vue'

// busy: the parent is still reading the previous file — picks/drops are ignored.
const props = withDefaults(defineProps<{ busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ (e: 'select', file: File): void }>()

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

function pick(): void {
  input.value?.click()
}

function onChange(e: Event): void {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) emit('select', file)
  target.value = ''
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  if (props.busy) return
  const file = e.dataTransfer?.files?.[0]
  if (file) emit('select', file)
}
</script>

<template>
  <div
    class="mt-3 rounded-2xl border-2 border-dashed p-8 text-center transition"
    :class="
      dragging
        ? 'border-indigo-500 bg-indigo-50'
        : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
    "
    @dragover.prevent="dragging = true"
    @dragenter.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div
      class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600"
    >
      <UploadCloud :size="24" />
    </div>
    <p class="text-sm font-medium text-slate-700">
      Drag &amp; drop your SiCepat Excel file here
    </p>
    <p class="mt-1 text-xs text-slate-500">
      Supports .xlsx and .xls — the file stays in your browser (only AWB numbers are sent to
      SiCepat via the local proxy).
    </p>
    <LoadingButton class="btn btn-secondary mt-4" loading-text="Reading file…" :loading="props.busy" @click="pick">
      Browse files
    </LoadingButton>
    <input
      ref="input"
      type="file"
      accept=".xlsx,.xls"
      class="hidden"
      @change="onChange"
    />
  </div>
</template>
