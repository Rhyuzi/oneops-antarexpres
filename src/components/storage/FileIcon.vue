<script setup lang="ts">
import { computed } from 'vue'
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
} from 'lucide-vue-next'

const props = defineProps<{ extension: string; size?: number }>()

const map = computed(() => {
  const ext = props.extension.toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
    return { icon: FileImage, cls: 'text-emerald-600 bg-emerald-50' }
  if (['pdf'].includes(ext)) return { icon: FileType, cls: 'text-rose-600 bg-rose-50' }
  if (['xls', 'xlsx', 'csv'].includes(ext))
    return { icon: FileSpreadsheet, cls: 'text-green-700 bg-green-50' }
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext))
    return { icon: FileText, cls: 'text-blue-700 bg-blue-50' }
  if (['ppt', 'pptx'].includes(ext)) return { icon: FileText, cls: 'text-orange-600 bg-orange-50' }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))
    return { icon: FileArchive, cls: 'text-amber-600 bg-amber-50' }
  if (['js', 'ts', 'json', 'html', 'css', 'py', 'sql', 'sh', 'xml', 'yml', 'yaml'].includes(ext))
    return { icon: FileCode, cls: 'text-violet-600 bg-violet-50' }
  return { icon: File, cls: 'text-slate-500 bg-slate-100' }
})
</script>

<template>
  <span
    class="inline-flex items-center justify-center rounded-lg"
    :class="map.cls"
    :style="{ padding: props.size && props.size > 30 ? '10px' : '6px' }"
  >
    <component :is="map.icon" :size="props.size || 18" />
  </span>
</template>
