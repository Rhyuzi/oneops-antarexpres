<script setup lang="ts">
import { ref, watch } from 'vue'
import { Download, ExternalLink, Loader2, X } from 'lucide-vue-next'
import {
  getPreviewUrl,
  getDownloadUrl,
  formatBytes,
  type StorageFile,
} from '../../lib/storageApi'

const props = defineProps<{ file: StorageFile | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const url = ref('')
const loading = ref(false)
const error = ref('')
const downloadUrl = ref('')

const INLINE_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'txt', 'csv', 'md']
const canPreview = (ext: string) => INLINE_EXT.includes(ext.toLowerCase())

watch(
  () => props.file,
  async (file) => {
    url.value = ''
    downloadUrl.value = ''
    error.value = ''
    if (!file) return
    loading.value = true
    try {
      downloadUrl.value = await getDownloadUrl(file.id)
      if (canPreview(file.file_extension)) {
        url.value = await getPreviewUrl(file.id)
      }
    } catch (err) {
      error.value = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        || 'Could not open file.'
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="file"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      @click.self="emit('close')"
    >
      <div class="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <!-- Header -->
        <div class="flex items-center gap-3 border-b border-slate-200 px-5 py-3.5">
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold text-slate-900">{{ file.file_name }}</p>
            <p class="text-xs text-slate-400">
              {{ formatBytes(file.file_size) }} · {{ file.file_extension.toUpperCase() }}
              <template v-if="file.uploaded_by_name"> · {{ file.uploaded_by_name }}</template>
            </p>
          </div>
          <a
            v-if="downloadUrl"
            :href="downloadUrl"
            class="btn btn-secondary"
            download
          >
            <Download :size="16" /> Download
          </a>
          <a v-if="url" :href="url" target="_blank" rel="noopener" class="btn btn-ghost" title="Open in new tab">
            <ExternalLink :size="16" />
          </a>
          <button class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" @click="emit('close')">
            <X :size="18" />
          </button>
        </div>

        <!-- Body -->
        <div class="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-slate-50 p-4">
          <div v-if="loading" class="flex flex-col items-center gap-2 text-slate-400">
            <Loader2 :size="28" class="animate-spin" />
            <p class="text-sm">Preparing preview…</p>
          </div>

          <p v-else-if="error" class="max-w-sm text-center text-sm text-rose-600">{{ error }}</p>

          <!-- Images -->
          <img
            v-else-if="url && file.mime_type.startsWith('image/')"
            :src="url"
            :alt="file.file_name"
            class="max-h-[70vh] max-w-full rounded-lg object-contain shadow"
          />

          <!-- PDF -->
          <iframe
            v-else-if="url && file.file_extension === 'pdf'"
            :src="url"
            class="h-[70vh] w-full rounded-lg bg-white shadow"
            :title="file.file_name"
          />

          <!-- Text-like -->
          <iframe
            v-else-if="url && ['txt', 'csv', 'md'].includes(file.file_extension)"
            :src="url"
            class="h-[70vh] w-full rounded-lg bg-white p-2 shadow"
            :title="file.file_name"
          />

          <!-- Not previewable -->
          <div v-else class="flex flex-col items-center gap-3 text-center">
            <p class="text-sm text-slate-500">
              Preview is not available for {{ file.file_extension.toUpperCase() }} files.
            </p>
            <a v-if="downloadUrl" :href="downloadUrl" class="btn btn-primary" download>
              <Download :size="16" /> Download to view
            </a>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
