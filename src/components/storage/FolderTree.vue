<script setup lang="ts">
import { computed } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
} from 'lucide-vue-next'
import { storageStore } from '../../stores/storage'
import type { StorageFolder } from '../../lib/storageApi'
import { t } from '../../i18n'

const props = defineProps<{
  folders: StorageFolder[]
  depth?: number
}>()

const store = storageStore
const depth = computed(() => props.depth ?? 0)

function isCurrent(id: number): boolean {
  return store.state.currentFolderId === id
}

function select(folder: StorageFolder | null): void {
  if (folder) void store.navigateTo(folder.id)
  else void store.navigateTo('root')
}
</script>

<template>
  <div>
    <!-- Virtual root -->
    <button
      class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition"
      :class="
        store.state.currentFolderId === 'root'
          ? 'bg-indigo-50 text-indigo-700'
          : 'text-slate-600 hover:bg-slate-100'
      "
      @click="select(null)"
    >
      <HardDrive :size="16" class="shrink-0" />
      <span class="truncate">{{ t('storage.allFolders') }}</span>
    </button>

    <template v-if="store.state.foldersLoading && !store.state.folders.length">
      <div class="flex items-center gap-2 px-2 py-2 text-sm text-slate-400">
        <Loader2 :size="14" class="animate-spin" /> {{ t('common.loading') }}
      </div>
    </template>

    <template v-else>
      <div
        v-for="folder in folders"
        :key="folder.id"
        class="my-0.5"
        :style="{ paddingLeft: `${depth * 14}px` }"
      >
        <div
          class="flex items-center rounded-lg"
          :class="isCurrent(folder.id) ? 'bg-indigo-50' : 'hover:bg-slate-100'"
        >
          <button
            v-if="store.childrenOf(folder.id).length"
            class="rounded p-1 text-slate-400 hover:text-slate-700"
            @click.stop="store.toggleExpand(folder.id)"
          >
            <ChevronDown v-if="store.state.expanded.has(folder.id)" :size="14" />
            <ChevronRight v-else :size="14" />
          </button>
          <span v-else class="w-[22px]" />

          <button
            class="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-sm"
            :class="isCurrent(folder.id) ? 'text-indigo-700' : 'text-slate-600'"
            @click="select(folder)"
          >
            <FolderOpen v-if="store.state.expanded.has(folder.id)" :size="16" class="shrink-0 text-amber-500" />
            <Folder v-else :size="16" class="shrink-0 text-amber-500" />
            <span class="truncate">{{ folder.name }}</span>
          </button>
        </div>

        <div v-if="store.state.expanded.has(folder.id)">
          <FolderTree :folders="store.childrenOf(folder.id)" :depth="depth + 1" />
        </div>
      </div>
    </template>
  </div>
</template>
