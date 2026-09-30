import { useSyncExternalStore } from 'react'
import { authService, currentUserId, type AuthState } from '../auth/AuthService'

export function useAuth(): AuthState {
  return useSyncExternalStore(authService.subscribe, authService.getSnapshot, authService.getSnapshot)
}

export function useCurrentUserId(): string | null {
  return currentUserId(useAuth())
}

export { syncStatusStore, useSyncStatus, type SyncPhase, type SyncStatus } from '../sync/syncStatus'
