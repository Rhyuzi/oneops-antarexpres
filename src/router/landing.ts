import { authStore } from '../stores/auth'

/**
 * First module the current (effective) roles may open, or 'no-access'.
 * Used by the router guard and after Switch Role.
 */
export function landingRouteName(): string {
  if (authStore.can('data_warrior.view')) return 'data-warrior'
  if (authStore.can('number_rechecking.view')) return 'number-rechecking'
  if (authStore.can('loader.view')) return 'kodepos-loader'
  if (authStore.can('master_data.view')) return 'master-data-hubs'
  if (authStore.can('account_management.view')) return 'access-management-accounts'
  if (authStore.can('audit_trail.view')) return 'audit-trail'
  return 'no-access'
}
