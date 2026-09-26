import type { Archive } from './archives'
import type { BrandTemplate } from './brandTemplates'
import type { BymarkState } from './bymark'
import type { Draft } from './drafts'

const ENDPOINT = '/__bymark_shared_storage'
const MIGRATED_KEY = 'bymark-shared-storage-migrated-v1'

export interface SharedSnapshot {
  settings: { state: Partial<BymarkState>; updatedAt?: string } | null
  avatar: string | null
  image: string | null
  sceneImage: string | null
  exportPreferences: { format: string; resolution: number } | null
  drafts: Draft[]
  archives: Archive[]
  brandTemplates: BrandTemplate[]
}

type SharedKind = keyof SharedSnapshot
type InitialSnapshot = Pick<SharedSnapshot, 'settings' | 'exportPreferences'>
let enabled = false
let initialSnapshot: InitialSnapshot | null = null

export function needsLocalMigration(): boolean {
  return localStorage.getItem(MIGRATED_KEY) !== '1'
}

export async function hasSharedStorage(): Promise<boolean> {
  try {
    const response = await fetch(`${ENDPOINT}?probe=1`, { cache: 'no-store' })
    return response.headers.get('X-Bymark-Shared-Storage') === '1'
  } catch {
    return false
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options })
  if (!response.ok) {
    throw new Error(`Shared storage request failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

export function isSharedStorageEnabled() {
  return enabled
}

export function sharedInitialValue<K extends keyof InitialSnapshot>(kind: K): InitialSnapshot[K] {
  if (!initialSnapshot) throw new Error('Shared storage has not been initialized')
  return initialSnapshot[kind]
}

export async function loadSharedValue<K extends SharedKind>(kind: K): Promise<SharedSnapshot[K]> {
  return request<SharedSnapshot[K]>(`${ENDPOINT}?kind=${encodeURIComponent(kind)}`)
}

export async function saveSharedValue(kind: SharedKind, value: unknown, id?: string): Promise<void> {
  await request(`${ENDPOINT}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id, value }),
  })
}

export async function removeSharedValue(kind: 'drafts' | 'archives' | 'brandTemplates', id: string): Promise<void> {
  await request(ENDPOINT, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id }),
  })
}

export async function initializeSharedStorage(local: SharedSnapshot): Promise<void> {
  const migrating = needsLocalMigration()
  const hasLocalData = Boolean(
    local.settings || local.avatar || local.image || local.sceneImage || local.exportPreferences ||
    local.drafts.length || local.archives.length || local.brandTemplates.length,
  )
  let snapshot: InitialSnapshot
  if (migrating && hasLocalData) {
    snapshot = await request<InitialSnapshot>(`${ENDPOINT}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(local),
    })
  } else {
    const [settings, exportPreferences] = await Promise.all([
      loadSharedValue('settings'),
      loadSharedValue('exportPreferences'),
    ])
    snapshot = { settings, exportPreferences }
  }
  if (migrating) {
    localStorage.setItem(MIGRATED_KEY, '1')
  } else {
    // A page can close before its final asynchronous settings write finishes.
    // The per-origin copy lets the next visit finish that write without
    // replacing a newer change made on another port.
    try {
      const pending = JSON.parse(localStorage.getItem('bymark-settings-v1') ?? 'null') as SharedSnapshot['settings']
      if (pending?.updatedAt && pending.updatedAt > (snapshot.settings?.updatedAt ?? '')) {
        await saveSharedValue('settings', pending)
        snapshot.settings = pending
      }
    } catch { /* An invalid local backup cannot replace the shared copy. */ }
  }
  initialSnapshot = snapshot
  enabled = true
}
