<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Loader2, Shield, X } from 'lucide-vue-next'
import {
  getFolderPermissions,
  putFolderPermissions,
  errorMessage,
  type PermissionRow,
  type RoleRow,
} from '../../lib/storageApi'
import LoadingButton from '../LoadingButton.vue'
import { useAsyncAction } from '../../composables/useAsyncAction'

const props = defineProps<{ folderId: number; folderName: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const roles = ref<RoleRow[]>([])
const rows = ref<PermissionRow[]>([])
const loading = ref(true)
const error = ref('')

const CAPS: Array<{ key: keyof PermissionRow; label: string }> = [
  { key: 'can_view', label: 'View' },
  { key: 'can_create_folder', label: 'Create folder' },
  { key: 'can_upload', label: 'Upload' },
  { key: 'can_download', label: 'Download' },
  { key: 'can_preview', label: 'Preview' },
  { key: 'can_rename', label: 'Rename' },
  { key: 'can_move', label: 'Move' },
  { key: 'can_delete', label: 'Delete' },
  { key: 'can_manage_permissions', label: 'Manage permissions' },
]

function rowFor(roleId: number): PermissionRow {
  let row = rows.value.find((r) => r.role_id === roleId)
  if (!row) {
    const role = roles.value.find((r) => r.id === roleId)
    row = {
      role_id: roleId,
      role_name: role?.name || `role-${roleId}`,
      can_view: false,
      can_create_folder: false,
      can_upload: false,
      can_download: false,
      can_preview: false,
      can_rename: false,
      can_move: false,
      can_delete: false,
      can_manage_permissions: false,
    }
    rows.value.push(row)
  }
  return row
}

function ensureAllRows(): void {
  for (const role of roles.value) rowFor(role.id)
}

onMounted(async () => {
  try {
    const data = await getFolderPermissions(props.folderId)
    roles.value = data.roles
    rows.value = data.permissions
    ensureAllRows()
  } catch (err) {
    error.value = errorMessage(err, 'Could not load permissions.')
  } finally {
    loading.value = false
  }
})

const saveAction = useAsyncAction(async (): Promise<void> => {
  error.value = ''
  try {
    // Only send rows with at least one capability set.
    const payload = rows.value
      .filter((r) => CAPS.some((c) => r[c.key] === true))
      .map((r) => {
        const out: Record<string, unknown> = { role_id: r.role_id }
        for (const c of CAPS) out[c.key] = Boolean(r[c.key])
        return out
      })
    await putFolderPermissions(props.folderId, payload as never)
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = errorMessage(err, 'Save failed.')
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      @click.self="emit('close')"
    >
      <div class="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div class="flex items-center gap-3 border-b border-slate-200 px-5 py-3.5">
          <Shield :size="20" class="text-indigo-600" />
          <div class="flex-1">
            <p class="font-semibold text-slate-900">Folder permissions</p>
            <p class="text-xs text-slate-400">{{ folderName }}</p>
          </div>
          <button class="rounded-lg p-2 text-slate-400 hover:bg-slate-100" @click="emit('close')">
            <X :size="18" />
          </button>
        </div>

        <div class="overflow-auto p-5">
          <div v-if="loading" class="flex justify-center py-10 text-slate-400">
            <Loader2 :size="26" class="animate-spin" />
          </div>

          <div v-else>
            <p class="mb-4 rounded-xl bg-indigo-50 px-4 py-3 text-xs text-indigo-800">
              These settings override inherited permissions for this folder and everything inside
              it. Leave every box unchecked for a role to remove its explicit grant (the role then
              inherits from the parent folder). <strong>Super Admin</strong> always has full access.
            </p>

            <div class="overflow-x-auto rounded-xl border border-slate-200">
              <table class="w-full min-w-[720px] text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th class="px-4 py-2.5 font-semibold">Role</th>
                    <th
                      v-for="cap in CAPS"
                      :key="cap.key"
                      class="px-2 py-2.5 text-center font-semibold"
                      :title="cap.label"
                    >
                      {{ cap.label.replace('can_', '').replace(/_/g, ' ') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="role in roles"
                    :key="role.id"
                    class="border-b border-slate-100 last:border-0 hover:bg-slate-50/60"
                  >
                    <td class="px-4 py-2.5">
                      <p class="font-medium capitalize text-slate-800">
                        {{ role.name.replace(/_/g, ' ') }}
                      </p>
                      <p v-if="role.description" class="text-xs text-slate-400">{{ role.description }}</p>
                    </td>
                    <td v-for="cap in CAPS" :key="cap.key" class="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        class="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        :checked="Boolean(rowFor(role.id)[cap.key])"
                        @change="rowFor(role.id)[cap.key] = !rowFor(role.id)[cap.key] as never"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {{ error }}
            </p>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
          <button class="btn btn-secondary" @click="emit('close')">Cancel</button>
          <LoadingButton
            class="btn btn-primary"
            loading-text="Saving…"
            :loading="saveAction.pending"
            :disabled="loading"
            @click="saveAction.run()"
          >
            Save permissions
          </LoadingButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>
