import type { Settings } from '../types'

const KEYS = {
  bearerToken: 'sicepat.bearerToken',
  permissionToken: 'sicepat.permissionToken',
  userId: 'sicepat.userId',
} as const

export function loadSettings(): Settings {
  return {
    bearerToken: localStorage.getItem(KEYS.bearerToken) ?? '',
    permissionToken: localStorage.getItem(KEYS.permissionToken) ?? '',
    userId: localStorage.getItem(KEYS.userId) ?? '',
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(KEYS.bearerToken, settings.bearerToken)
  localStorage.setItem(KEYS.permissionToken, settings.permissionToken)
  localStorage.setItem(KEYS.userId, settings.userId)
}

export function clearSettings(): void {
  localStorage.removeItem(KEYS.bearerToken)
  localStorage.removeItem(KEYS.permissionToken)
  localStorage.removeItem(KEYS.userId)
}
