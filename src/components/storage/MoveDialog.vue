<script setup lang="ts">
/**
 * Move dialog for Data Warrior (one folder, one file, or a multi-selection):
 * folder tree picker (collapsed from Root), live preview of the full
 * destination path, Move disabled until an allowed target is chosen.
 * The API applies the same rules (server/routes/storage.js).
 */
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import LoadingButton from '../LoadingButton.vue'
import FolderTreePicker from './FolderTreePicker.vue'
import { t } from '../../i18n'
import { ROOT, blockedReason, pathText, type MoveContext, type NodeKey } from '../../lib/folderTree'

const props = defineProps<{
  title: string
  /** What is moved ("Report.pdf", "3 item(s)"). */
  subject: string
  ctx: MoveContext
  busy?: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm', target: number | null): void }>()

const target = ref<NodeKey | null>(null)
const allowed = computed(() => target.value !== null && !blockedReason(target.value, props.ctx))
const preview = computed(() => (target.value === null ? '' : pathText(target.value, props.ctx.folders, t('storage.mvRoot'))))

function confirm(): void {
  if (!allowed.value || target.value === null) return
  emit('confirm', target.value === ROOT ? null : target.value)
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="emit('close')">
      <div class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white p-6 shadow-2xl" role="dialog" :aria-label="props.title" data-testid="move-dialog">
        <div class="mb-1 flex items-start justify-between gap-3">
          <h3 class="section-title">{{ props.title }}</h3>
          <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" :aria-label="t('common.close')" @click="emit('close')"><X :size="18" /></button>
        </div>
        <p class="mb-4 truncate text-sm text-slate-500" data-testid="move-subject">{{ t('storage.mvMoving', { name: props.subject }) }}</p>

        <FolderTreePicker v-model="target" :ctx="props.ctx" />

        <div class="mt-3 rounded-xl border px-3 py-2 text-sm" :class="allowed ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-slate-200 bg-slate-50 text-slate-500'">
          <span class="font-semibold">{{ t('storage.mvPreview') }}:</span>
          <span class="ml-1 break-words" data-testid="move-preview">{{ preview || t('storage.mvNoTarget') }}</span>
        </div>

        <div class="mt-4 flex justify-end gap-3">
          <button class="btn btn-secondary" :disabled="props.busy" @click="emit('close')">{{ t('common.cancel') }}</button>
          <LoadingButton
            class="btn btn-primary"
            :loading-text="t('common.moving')"
            :loading="props.busy"
            :disabled="!allowed"
            data-testid="move-confirm"
            @click="confirm"
          >
            {{ t('common.move') }}
          </LoadingButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>
