<script setup lang="ts">
/**
 * Folder tree picker for the Move dialog: Root + every folder, nested with
 * indentation, expand / collapse per level (everything — Root included —
 * starts collapsed), search with the parent path of each match (ancestors
 * expanded automatically), and blocked targets shown disabled with the reason.
 * Rules: lib/folderTree.ts.
 */
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive, Search } from 'lucide-vue-next'
import { t, type MessageKey } from '../../i18n'
import { ROOT, toggleNode, visibleRows, type BlockReason, type MoveContext, type NodeKey } from '../../lib/folderTree'

const props = defineProps<{ ctx: MoveContext; modelValue: NodeKey | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: NodeKey): void }>()

const expanded = ref<Set<NodeKey>>(new Set()) // collapsed from Root on open
const query = ref('')
const rows = computed(() => visibleRows(props.ctx, expanded.value, query.value, t('storage.mvRoot')))
const searching = computed(() => query.value.trim().length > 0)
const noResults = computed(() => searching.value && rows.value.length <= 1)

const REASON: Record<BlockReason, MessageKey> = {
  moving: 'storage.mvBlockedMoving',
  inside: 'storage.mvBlockedInside',
  source: 'storage.mvBlockedSource',
  no_permission: 'storage.mvBlockedPermission',
  root_files: 'storage.mvBlockedRootFiles',
  root_admin: 'storage.mvBlockedRootAdmin',
}

function toggle(key: NodeKey): void {
  if (searching.value) return // while searching the tree is opened for the matches
  expanded.value = toggleNode(expanded.value, key)
}
function pick(key: NodeKey, blocked: BlockReason | null): void {
  if (blocked) return
  emit('update:modelValue', key)
}
function onKey(e: KeyboardEvent, key: NodeKey, blocked: BlockReason | null, open: boolean, hasChildren: boolean): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    pick(key, blocked)
  } else if (e.key === 'ArrowRight' && hasChildren && !open) {
    e.preventDefault()
    toggle(key)
  } else if (e.key === 'ArrowLeft' && open) {
    e.preventDefault()
    toggle(key)
  }
}
const keyAttr = (key: NodeKey) => (key === ROOT ? 'root' : String(key))
</script>

<template>
  <div class="space-y-2" data-testid="folder-tree-picker">
    <div class="relative">
      <Search class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
      <input
        v-model="query"
        type="search"
        class="input py-2 pl-9"
        :placeholder="t('storage.mvSearch')"
        :aria-label="t('storage.mvSearch')"
        data-testid="tree-search"
      />
    </div>
    <ul class="max-h-72 overflow-auto rounded-xl border border-slate-200 py-1" role="tree" :aria-label="t('storage.mvTree')">
      <li
        v-for="r in rows"
        :key="keyAttr(r.key)"
        role="treeitem"
        :aria-level="r.depth + 1"
        :aria-expanded="r.hasChildren ? r.expanded : undefined"
        :aria-selected="modelValue === r.key"
        :aria-disabled="r.blocked ? 'true' : undefined"
        :data-tree-key="keyAttr(r.key)"
        :data-depth="r.depth"
        :data-blocked="r.blocked || undefined"
        :tabindex="r.blocked ? -1 : 0"
        class="flex items-center gap-1.5 py-1.5 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        :class="[
          r.blocked ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer text-slate-700 hover:bg-slate-50',
          modelValue === r.key ? 'bg-indigo-50 font-semibold text-indigo-700' : '',
        ]"
        :style="{ paddingLeft: `${8 + r.depth * 18}px` }"
        :title="r.blocked ? t(REASON[r.blocked]) : undefined"
        @click="pick(r.key, r.blocked)"
        @keydown="onKey($event, r.key, r.blocked, r.expanded, r.hasChildren)"
      >
        <button
          v-if="r.hasChildren"
          type="button"
          tabindex="-1"
          class="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40"
          :disabled="searching"
          :aria-label="r.expanded ? t('storage.mvCollapse', { name: r.name }) : t('storage.mvExpand', { name: r.name })"
          data-testid="tree-toggle"
          @click.stop="toggle(r.key)"
        >
          <ChevronDown v-if="r.expanded" :size="15" />
          <ChevronRight v-else :size="15" />
        </button>
        <span v-else class="inline-block w-5"></span>
        <HardDrive v-if="r.key === ROOT" :size="16" class="shrink-0 text-slate-500" />
        <FolderOpen v-else-if="r.expanded" :size="16" class="shrink-0" :class="r.blocked ? 'text-slate-300' : 'text-amber-500'" />
        <Folder v-else :size="16" class="shrink-0" :class="r.blocked ? 'text-slate-300' : 'text-amber-500'" />
        <span class="min-w-0 flex-1 truncate">
          <span :class="r.match ? 'rounded bg-amber-100 px-0.5' : ''" data-testid="tree-name">{{ r.name }}</span>
          <span v-if="r.parentPath" class="ml-1.5 text-xs font-normal text-slate-400" data-testid="tree-parent-path">{{ r.parentPath }}</span>
        </span>
        <span v-if="r.blocked" class="shrink-0 text-[11px] italic text-slate-400" data-testid="tree-blocked-reason">{{ t(REASON[r.blocked]) }}</span>
      </li>
    </ul>
    <p v-if="noResults" class="text-xs text-slate-500" data-testid="tree-no-results">{{ t('storage.mvNoResults', { q: query.trim() }) }}</p>
  </div>
</template>
