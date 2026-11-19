<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Filter,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  X,
} from 'lucide-vue-next'
import axios from 'axios'
import { useKeyedActions } from '../composables/useAsyncAction'

// --- types (mirror server/audit.js normalizeRecord) ---------------------------
interface AuditActor {
  id: number | null
  username: string | null
  full_name: string | null
  roles: string[]
  roles_are_current: boolean
  anonymous: boolean
  deleted: boolean
}

interface AuditRecord {
  id: number
  created_at: string | null
  action: string
  module: string
  module_label: string
  result: 'success' | 'failure'
  description: string
  entity_type: string
  entity_id: number | null
  resource_id: string | null
  actor: AuditActor
  ip_address: string | null
  // detail only
  user_agent?: string | null
  before?: unknown
  after?: unknown
  details?: Record<string, unknown>
  format?: number
}

interface FilterOptions {
  modules: Array<{ key: string; label: string }>
  actions: Array<{ action: string; module: string; count: number }>
  users: Array<{ id: number; username: string; full_name: string }>
}

// --- state ----------------------------------------------------------------------
const PAGE_SIZE = 25
const records = ref<AuditRecord[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(true)
const error = ref('')
const options = ref<FilterOptions>({ modules: [], actions: [], users: [] })

const filters = reactive({
  from: '',
  to: '',
  userId: '',
  module: '',
  action: '',
  result: '',
})
const searchInput = ref('')
const search = ref('')
let searchTimer = 0

const detail = ref<AuditRecord | null>(null)
const detailError = ref('')
const detailOps = useKeyedActions()

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const actionOptions = computed(() =>
  options.value.actions.filter((a) => !filters.module || a.module === filters.module)
)
const hasFilters = computed(
  () => Boolean(filters.from || filters.to || filters.userId || filters.module || filters.action || filters.result || search.value)
)
const dateError = computed(() =>
  filters.from && filters.to && filters.from > filters.to ? 'Start date is after end date.' : ''
)

// --- helpers ----------------------------------------------------------------------
/** Local calendar day → epoch seconds at local midnight (server compares epochs). */
function dayStart(value: string, plusDays = 0): number {
  const [y, m, d] = value.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d + plusDays).getTime() / 1000)
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
}

function actorName(a: AuditActor): string {
  if (a.anonymous) return 'Anonymous'
  return a.full_name || (a.username ? `@${a.username}` : `User #${a.id}`)
}

function roleLabel(r: string): string {
  return r.replace(/_/g, ' ')
}

function errMsg(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: string } } }
  return e.response?.data?.message || fallback
}

const MODULE_CHIP: Record<string, string> = {
  authentication: 'bg-sky-100 text-sky-700',
  account_management: 'bg-indigo-100 text-indigo-700',
  access_management: 'bg-amber-100 text-amber-700',
  data_warrior: 'bg-emerald-100 text-emerald-700',
  number_rechecking: 'bg-fuchsia-100 text-fuchsia-700',
  system: 'bg-slate-200 text-slate-700',
}
function moduleChip(m: string): string {
  return MODULE_CHIP[m] || 'bg-slate-100 text-slate-600'
}

// --- loading (latest request wins: stale responses are dropped) ------------------
let requestSeq = 0

async function load(): Promise<void> {
  if (dateError.value) return
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const params: Record<string, string | number> = { page: page.value, pageSize: PAGE_SIZE }
    if (filters.from) params.from = dayStart(filters.from)
    if (filters.to) params.to = dayStart(filters.to, 1)
    if (filters.userId) params.userId = filters.userId
    if (filters.module) params.module = filters.module
    if (filters.action) params.action = filters.action
    if (filters.result) params.result = filters.result
    if (search.value) params.search = search.value
    const resp = await axios.get('/api/audit-trail', { params })
    if (seq !== requestSeq) return
    records.value = resp.data.records
    total.value = resp.data.total
  } catch (err) {
    if (seq !== requestSeq) return
    error.value = errMsg(err, 'Could not load the audit trail.')
    records.value = []
    total.value = 0
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

async function loadOptions(): Promise<void> {
  try {
    const resp = await axios.get('/api/audit-trail/filters')
    options.value = { modules: resp.data.modules, actions: resp.data.actions, users: resp.data.users }
  } catch {
    // Filters stay usable as free text search; the list shows its own error.
  }
}

onMounted(async () => {
  await Promise.all([load(), loadOptions()])
})

// Any filter change → back to page 1, one request (watch batches same-tick changes).
watch(
  () => ({ ...filters }),
  () => {
    if (filters.action && !actionOptions.value.some((a) => a.action === filters.action)) {
      filters.action = ''
      return // the action reset triggers this watcher again
    }
    page.value = 1
    void load()
  }
)
watch(searchInput, (q) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    const next = q.trim()
    if (next === search.value) return
    search.value = next
    page.value = 1
    void load()
  }, 350)
})

function goPage(p: number): void {
  if (loading.value || p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
  void load()
}

function resetFilters(): void {
  window.clearTimeout(searchTimer)
  const onlySearch = !Object.values(filters).some(Boolean)
  searchInput.value = ''
  search.value = ''
  Object.assign(filters, { from: '', to: '', userId: '', module: '', action: '', result: '' })
  // The filters watcher only fires when a filter value changed.
  if (onlySearch) {
    page.value = 1
    void load()
  }
}

// --- detail -------------------------------------------------------------------------
function openDetail(r: AuditRecord): void {
  detailError.value = ''
  detail.value = r // show the summary immediately; enrich with before/after
  void detailOps.run(r.id, 'load', async () => {
    try {
      const resp = await axios.get(`/api/audit-trail/${r.id}`)
      if (detail.value && detail.value.id === r.id) detail.value = resp.data.record
    } catch (err) {
      if (detail.value && detail.value.id === r.id) detailError.value = errMsg(err, 'Could not load the record details.')
    }
  })
}

interface DiffRow {
  field: string
  before: string
  after: string
  changed: boolean
}

function formatValue(v: unknown): string {
  if (v === undefined) return ''
  if (v === null) return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '(none)'
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return { value: v }
}

const diffRows = computed<DiffRow[]>(() => {
  const d = detail.value
  if (!d) return []
  const b = asObject(d.before)
  const a = asObject(d.after)
  if (!b && !a) return []
  const keys = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])]
  return keys.map((field) => {
    const before = b && field in b ? formatValue(b[field]) : ''
    const after = a && field in a ? formatValue(a[field]) : ''
    return { field, before, after, changed: before !== after }
  })
})

const diffMode = computed(() => {
  const d = detail.value
  if (!d) return 'none'
  const hasB = d.before !== null && d.before !== undefined
  const hasA = d.after !== null && d.after !== undefined
  if (hasB && hasA) return 'change'
  if (hasA) return 'created'
  if (hasB) return 'removed'
  return 'none'
})

const detailsJson = computed(() => {
  const d = detail.value?.details
  return d && Object.keys(d).length ? JSON.stringify(d, null, 2) : ''
})
</script>

<template>
  <div class="min-h-[calc(100vh-3.5rem)] space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="flex items-center gap-2 text-xl font-bold text-slate-900">
          <ScrollText :size="22" class="text-indigo-600" /> Audit Trail
        </h1>
        <p class="text-sm text-slate-500">Read-only history of security and business events</p>
      </div>
      <button
        class="btn btn-secondary"
        title="Refresh"
        :disabled="loading"
        :aria-busy="loading ? 'true' : undefined"
        @click="load"
      >
        <RefreshCw :size="15" :class="{ 'animate-spin': loading }" /> Refresh
      </button>
    </div>

    <!-- Filters -->
    <div class="card space-y-3 p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative min-w-[220px] flex-1">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" :size="15" />
          <input
            v-model="searchInput"
            class="input py-2 pl-9"
            placeholder="Search user, description, action, resource ID…"
            maxlength="100"
          />
        </div>
        <button v-if="hasFilters" class="btn btn-ghost px-3 py-2 text-xs" @click="resetFilters">
          <X :size="14" /> Clear filters
        </button>
      </div>
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-6">
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">From</span>
          <input v-model="filters.from" type="date" class="input py-2" :max="filters.to || undefined" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">To</span>
          <input v-model="filters.to" type="date" class="input py-2" :min="filters.from || undefined" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">User</span>
          <select v-model="filters.userId" class="input py-2">
            <option value="">All users</option>
            <option v-for="u in options.users" :key="u.id" :value="String(u.id)">
              {{ u.full_name }} (@{{ u.username }})
            </option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">Module</span>
          <select v-model="filters.module" class="input py-2">
            <option value="">All modules</option>
            <option v-for="m in options.modules" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">Action</span>
          <select v-model="filters.action" class="input py-2">
            <option value="">All actions</option>
            <option v-for="a in actionOptions" :key="a.action" :value="a.action">{{ a.action }} ({{ a.count }})</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">Result</span>
          <select v-model="filters.result" class="input py-2">
            <option value="">Any result</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
      </div>
      <p v-if="dateError" class="flex items-center gap-1.5 text-xs text-rose-600">
        <AlertTriangle :size="13" /> {{ dateError }}
      </p>
    </div>

    <!-- List -->
    <div class="card p-4 sm:p-5">
      <div v-if="loading && !records.length" class="flex justify-center py-14 text-slate-400">
        <Loader2 :size="26" class="animate-spin" />
      </div>
      <p v-else-if="error" class="flex items-center gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">
        <AlertTriangle :size="16" /> {{ error }}
      </p>
      <div v-else-if="!records.length" class="flex flex-col items-center justify-center py-14 text-center">
        <Filter v-if="hasFilters" :size="36" class="text-slate-300" />
        <ScrollText v-else :size="36" class="text-slate-300" />
        <p class="mt-3 text-sm text-slate-500">
          {{ hasFilters ? 'No audit records match these filters.' : 'No audit records yet.' }}
        </p>
      </div>

      <div v-else class="relative">
        <!-- Refreshing an existing page: keep rows visible, dim them -->
        <div v-if="loading" class="absolute inset-0 z-10 flex items-start justify-center bg-white/60 pt-10">
          <Loader2 :size="24" class="animate-spin text-slate-400" />
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[880px] text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th class="px-3 py-2.5 font-semibold">Timestamp</th>
                <th class="px-3 py-2.5 font-semibold">User</th>
                <th class="px-3 py-2.5 font-semibold">Role</th>
                <th class="px-3 py-2.5 font-semibold">Module</th>
                <th class="px-3 py-2.5 font-semibold">Action</th>
                <th class="px-3 py-2.5 font-semibold">Description</th>
                <th class="px-3 py-2.5 font-semibold">IP address</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in records"
                :key="r.id"
                class="cursor-pointer border-b border-slate-100 align-top last:border-0 hover:bg-slate-50"
                tabindex="0"
                @click="openDetail(r)"
                @keydown.enter="openDetail(r)"
              >
                <td class="whitespace-nowrap px-3 py-2.5 text-slate-600">{{ formatTime(r.created_at) }}</td>
                <td class="px-3 py-2.5">
                  <p class="font-medium text-slate-800" :class="{ 'italic text-slate-400': r.actor.anonymous }">
                    {{ actorName(r.actor) }}
                  </p>
                  <p v-if="r.actor.username" class="text-xs text-slate-400">
                    @{{ r.actor.username }}<span v-if="r.actor.deleted"> · deleted</span>
                  </p>
                </td>
                <td class="px-3 py-2.5">
                  <span v-if="!r.actor.roles.length" class="text-xs text-slate-300">—</span>
                  <span v-for="role in r.actor.roles" :key="role" class="chip mb-1 mr-1 bg-slate-100 capitalize text-slate-600">
                    {{ roleLabel(role) }}
                  </span>
                </td>
                <td class="px-3 py-2.5">
                  <span class="chip whitespace-nowrap" :class="moduleChip(r.module)">{{ r.module_label }}</span>
                </td>
                <td class="px-3 py-2.5">
                  <!-- line breaks only after dots: "auth." / "password_reset_requested" -->
                  <code class="text-xs text-slate-700"><template v-for="(part, i) in r.action.split('.')" :key="i"><wbr v-if="i" />{{ i ? '.' : '' }}{{ part }}</template></code>
                  <span v-if="r.result === 'failure'" class="chip ml-1 bg-rose-100 text-rose-700">failed</span>
                </td>
                <td class="min-w-[200px] px-3 py-2.5 text-slate-700">{{ r.description }}</td>
                <td class="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-500">{{ r.ip_address || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div class="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="text-slate-500">
            {{ total.toLocaleString() }} record{{ total === 1 ? '' : 's' }} · page {{ page }} of {{ totalPages }}
          </span>
          <div class="flex gap-2">
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page <= 1 || loading" @click="goPage(page - 1)">
              <ChevronLeft :size="14" /> Prev
            </button>
            <button class="btn btn-secondary px-3 py-1.5" :disabled="page >= totalPages || loading" @click="goPage(page + 1)">
              Next <ChevronRight :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Detail drawer -->
    <Teleport to="body">
      <div v-if="detail" class="fixed inset-0 z-50 flex justify-end bg-slate-900/60" @click.self="detail = null">
        <div class="h-full w-full max-w-2xl overflow-auto bg-white p-5 shadow-2xl sm:p-6" role="dialog" aria-label="Audit record details">
          <div class="mb-4 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Audit record #{{ detail.id }}</p>
              <h3 class="mt-1 text-base font-semibold text-slate-900">{{ detail.description }}</h3>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="chip" :class="moduleChip(detail.module)">{{ detail.module_label }}</span>
                <code class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{{ detail.action }}</code>
                <span
                  class="chip"
                  :class="detail.result === 'failure' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'"
                >
                  {{ detail.result === 'failure' ? 'Failed' : 'Success' }}
                </span>
              </div>
            </div>
            <button class="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Close" @click="detail = null">
              <X :size="18" />
            </button>
          </div>

          <div v-if="detailOps.isBusy(detail.id)" class="mb-3 flex items-center gap-2 text-xs text-slate-400">
            <Loader2 :size="14" class="animate-spin" /> Loading full details…
          </div>
          <p v-if="detailError" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{{ detailError }}</p>

          <dl class="grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-slate-200 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs text-slate-500">Timestamp</dt>
              <dd class="text-slate-800">{{ formatTime(detail.created_at) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">Actor</dt>
              <dd class="text-slate-800">
                {{ actorName(detail.actor) }}
                <span v-if="detail.actor.username" class="text-slate-400">(@{{ detail.actor.username }}{{ detail.actor.id ? ` · #${detail.actor.id}` : '' }})</span>
                <span v-if="detail.actor.deleted" class="ml-1 text-xs text-rose-500">account deleted</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">
                Role{{ detail.actor.roles_are_current && detail.actor.roles.length ? ' (current — not recorded at the time)' : ' at the time' }}
              </dt>
              <dd class="capitalize text-slate-800">{{ detail.actor.roles.map(roleLabel).join(', ') || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">Resource</dt>
              <dd class="text-slate-800">
                {{ detail.entity_type }}<span v-if="detail.resource_id"> #{{ detail.resource_id }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-slate-500">IP address</dt>
              <dd class="font-mono text-xs text-slate-800">{{ detail.ip_address || '—' }}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-xs text-slate-500">User agent</dt>
              <dd class="break-all text-xs text-slate-700">{{ detail.user_agent || (detail.format === 1 ? 'Not recorded (older entry)' : '—') }}</dd>
            </div>
          </dl>

          <!-- Before / after -->
          <div class="mt-5">
            <h4 class="mb-2 text-sm font-semibold text-slate-800">
              {{ diffMode === 'created' ? 'New values' : diffMode === 'removed' ? 'Removed values' : 'Changes' }}
            </h4>
            <p v-if="diffMode === 'none'" class="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
              No data change recorded for this event.
            </p>
            <div v-else class="overflow-x-auto rounded-xl border border-slate-200">
              <table class="w-full min-w-[480px] text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th class="w-1/4 px-3 py-2 font-semibold">Field</th>
                    <th v-if="diffMode !== 'created'" class="px-3 py-2 font-semibold">Before</th>
                    <th v-if="diffMode !== 'removed'" class="px-3 py-2 font-semibold">After</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in diffRows"
                    :key="row.field"
                    class="border-b border-slate-100 align-top last:border-0"
                    :class="{ 'bg-amber-50/60': diffMode === 'change' && row.changed }"
                  >
                    <td class="px-3 py-2 font-mono text-xs text-slate-600">{{ row.field }}</td>
                    <td v-if="diffMode !== 'created'" class="px-3 py-2">
                      <pre
                        class="whitespace-pre-wrap break-words font-sans text-xs"
                        :class="diffMode === 'change' && row.changed ? 'text-rose-700 line-through decoration-rose-300' : 'text-slate-700'"
                      >{{ row.before || '—' }}</pre>
                    </td>
                    <td v-if="diffMode !== 'removed'" class="px-3 py-2">
                      <pre
                        class="whitespace-pre-wrap break-words font-sans text-xs"
                        :class="diffMode === 'change' && row.changed ? 'font-semibold text-emerald-700' : 'text-slate-700'"
                      >{{ row.after || '—' }}</pre>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Extra details -->
          <div v-if="detailsJson" class="mt-5">
            <h4 class="mb-2 text-sm font-semibold text-slate-800">Additional details</h4>
            <pre class="overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">{{ detailsJson }}</pre>
          </div>

          <p class="mt-5 text-xs text-slate-400">
            Audit records are read-only. Sensitive values (passwords, tokens, secrets) are never stored or shown.
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>
