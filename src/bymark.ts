import {
  DEFAULT_BYMARK_SETTINGS,
  type AspectRatio,
  type BymarkState,
  type ExportMode,
  type ImageAlignment,
  type ImagePosition,
  type Theme,
  type VisualStyle,
  type CanvasStyle,
  type SceneFocus,
  type SceneCardRatio,
  type SceneBackdropPreset,
  type SocialMetricScale,
  DEFAULT_SCENE_CARD_PADDING,
  SCENE_CARD_PADDING_MIN,
  SCENE_CARD_PADDING_MAX,
  DEFAULT_SCENE_CARD_HEIGHT,
  SCENE_CARD_HEIGHT_MIN,
  SCENE_CARD_HEIGHT_MAX,
  resolveDeviceTheme,
} from './default-settings'
import { normalizeSceneBackdrop } from './sceneBackdrops.ts'
import { filenameBaseFor, normalizeWorkTitle } from './title'
import { isSharedStorageEnabled, loadSharedValue, saveSharedValue, sharedInitialValue } from './sharedStorage.ts'

export type { AspectRatio, BymarkState, ExportMode, ImageAlignment, ImagePosition, Theme, VisualStyle, CanvasStyle, SceneFocus, SceneCardRatio, SceneBackdropPreset, SocialMetricScale } from './default-settings'
export { DEFAULT_AVATAR, DEFAULT_BYMARK_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_IMAGE_SCALE, DEFAULT_SCENE_CARD_PADDING, SCENE_CARD_PADDING_MIN, SCENE_CARD_PADDING_MAX, DEFAULT_SCENE_CARD_HEIGHT, SCENE_CARD_HEIGHT_MIN, SCENE_CARD_HEIGHT_MAX } from './default-settings'
export { normalizeWorkTitle, resolvedTitleFor, textTitleFor, WORK_TITLE_MAX_LENGTH, FILENAME_TITLE_MAX_LENGTH } from './title'

export const DEFAULT_STATE: BymarkState = createDefaultState()

/**
 * The app's built-in baseline. A fresh visitor and “恢复初始化配置” receive
 * the same complete visual preset instead of inheriting the device theme.
 */
export function createDefaultState(initialTheme?: Theme): BymarkState {
  const base = { ...DEFAULT_BYMARK_SETTINGS }
  if (initialTheme) base.theme = initialTheme
  return base
}

const CARD_WIDTH = 800

export const RATIO_HEIGHTS: Record<AspectRatio, number> = {
  '3:4': CARD_WIDTH * 4 / 3,
  '2:3': CARD_WIDTH * 3 / 2,
  '9:16': CARD_WIDTH * 16 / 9,
}

export const ASPECT_PRESETS: Array<{
  ratio: AspectRatio
  name: string
  description: string
}> = [
  {
    ratio: '3:4',
    name: '默认文字思考',
    description: '留白从容，适合完整表达',
  },
  {
    ratio: '2:3',
    name: '抖音图文推荐',
    description: '较 3:4 高 12.5%，为顶部搜索与底部精选区留出安全空间',
  },
  {
    ratio: '9:16',
    name: '全屏发布',
    description: '纵向全屏画幅，适合移动端发布',
  },
]

export const ASPECT_RATIOS: AspectRatio[] = ASPECT_PRESETS.map((preset) => preset.ratio)

export const SETTINGS_STORAGE_KEY = 'bymark-settings-v1'
// Read these previous product keys once so a rename does not discard local work.
const LEGACY_STORAGE_KEYS = ['postmark-settings-v2', 'postmark-state-v1']
const SETTINGS_VERSION = 1
const AVATAR_STORAGE_KEY = 'bymark-avatar-v1'
const AVATAR_DB_NAME = 'bymark-local-assets'
const LEGACY_AVATAR_STORAGE_KEY = 'postmark-avatar-v1'
const LEGACY_AVATAR_DB_NAME = 'postmark-local-assets'
const AVATAR_STORE_NAME = 'assets'
export const IMAGE_ASSET_KEY = 'bymark-image-v1'
export const SCENE_IMAGE_ASSET_KEY = 'bymark-scene-image-v1'

type StoredSettings = {
  version: typeof SETTINGS_VERSION
  updatedAt: string
  state: Partial<BymarkState>
}

type LegacyPublishDetails = {
  showSeries?: boolean
  series?: string
  showEngagement?: boolean
  likes?: string
  comments?: string
  saves?: string
  sceneCardPosition?: 'top' | 'center' | 'bottom'
}

function parseStoredState(stored: string | null): Partial<BymarkState> | null {
  if (!stored) return null
  const parsed = JSON.parse(stored) as Partial<StoredSettings> | Partial<BymarkState>
  if (
    parsed &&
    typeof parsed === 'object' &&
    'state' in parsed &&
    parsed.state &&
    typeof parsed.state === 'object'
  ) {
    return parsed.state as Partial<BymarkState>
  }
  return parsed as Partial<BymarkState>
}

export function normalizeState(parsed: Partial<BymarkState> & LegacyPublishDetails): BymarkState {
  const defaults = createDefaultState()
  const title = normalizeWorkTitle(parsed.title)
  const ratio: AspectRatio = ASPECT_RATIOS.includes(parsed.ratio as AspectRatio)
    ? (parsed.ratio as AspectRatio)
    : defaults.ratio
  const exportMode: ExportMode = parsed.exportMode === 'douyin-cover' ? 'douyin-cover' : 'standard'
  const normalizedRatio: AspectRatio = exportMode === 'douyin-cover' ? '9:16' : ratio
  const theme: Theme = parsed.theme === 'light' || parsed.theme === 'white' || parsed.theme === 'dark' ? parsed.theme : defaults.theme
  const imagePosition: ImagePosition =
    parsed.imagePosition === 'above' || parsed.imagePosition === 'below'
      ? parsed.imagePosition
      : defaults.imagePosition
  const imageAlignment: ImageAlignment =
    parsed.imageAlignment === 'left' || parsed.imageAlignment === 'center'
      ? parsed.imageAlignment
      : defaults.imageAlignment
  const imageScale =
    typeof parsed.imageScale === 'number' && Number.isFinite(parsed.imageScale)
      ? Math.min(160, Math.max(80, Math.round(parsed.imageScale)))
      : defaults.imageScale
  const fontScale =
    typeof parsed.fontScale === 'number' && Number.isFinite(parsed.fontScale)
      ? Math.min(200, Math.max(0, Math.round(parsed.fontScale)))
      : defaults.fontScale
  const lineHeightScale =
    typeof parsed.lineHeightScale === 'number' && Number.isFinite(parsed.lineHeightScale)
      ? Math.min(160, Math.max(80, Math.round(parsed.lineHeightScale)))
      : defaults.lineHeightScale
  const visualStyle: VisualStyle = parsed.visualStyle === 'folio' ? 'folio' : 'default'
  const canvasStyle: CanvasStyle = parsed.canvasStyle === 'scene' ? 'scene' : 'card'
  const sceneBackdrop: SceneBackdropPreset = normalizeSceneBackdrop(parsed.sceneBackdrop)
  const sceneFocus: SceneFocus = parsed.sceneFocus === 'top' || parsed.sceneFocus === 'bottom' ? parsed.sceneFocus : 'center'
  const sceneCardRatio: SceneCardRatio =
    parsed.sceneCardRatio === '1:1' || parsed.sceneCardRatio === '3:4' || parsed.sceneCardRatio === '4:3'
      ? parsed.sceneCardRatio
      : defaults.sceneCardRatio
  const sceneCardScale = typeof parsed.sceneCardScale === 'number' && Number.isFinite(parsed.sceneCardScale)
    ? Math.min(100, Math.max(70, Math.round(parsed.sceneCardScale)))
    : defaults.sceneCardScale
  const sceneCardHeight = typeof parsed.sceneCardHeight === 'number' && Number.isFinite(parsed.sceneCardHeight)
    ? Math.min(SCENE_CARD_HEIGHT_MAX, Math.max(SCENE_CARD_HEIGHT_MIN, Math.round(parsed.sceneCardHeight)))
    : DEFAULT_SCENE_CARD_HEIGHT
  const sceneCardPadding = typeof parsed.sceneCardPadding === 'number' && Number.isFinite(parsed.sceneCardPadding)
    ? Math.min(SCENE_CARD_PADDING_MAX, Math.max(SCENE_CARD_PADDING_MIN, Math.round(parsed.sceneCardPadding)))
    : DEFAULT_SCENE_CARD_PADDING
  const sceneCardX = typeof parsed.sceneCardX === 'number' && Number.isFinite(parsed.sceneCardX)
    ? Math.min(95, Math.max(5, Math.round(parsed.sceneCardX * 100) / 100))
    : defaults.sceneCardX
  const sceneCardY = typeof parsed.sceneCardY === 'number' && Number.isFinite(parsed.sceneCardY)
    ? Math.min(95, Math.max(5, Math.round(parsed.sceneCardY * 100) / 100))
    : defaults.sceneCardY
  const sceneOverlay = typeof parsed.sceneOverlay === 'number' && Number.isFinite(parsed.sceneOverlay)
    ? Math.min(70, Math.max(0, Math.round(parsed.sceneOverlay)))
    : defaults.sceneOverlay
  const state = {
    ...parsed,
    // Page markers are deliberate author choices. Keep them in restored
    // settings and drafts so a chosen page start survives reloads.
    text: typeof parsed.text === 'string' ? parsed.text : defaults.text,
  }
  const socialReplies = typeof parsed.socialReplies === 'string'
    ? parsed.socialReplies.slice(0, 8)
    : typeof parsed.comments === 'string' ? parsed.comments.slice(0, 8) : defaults.socialReplies
  const socialReposts = typeof parsed.socialReposts === 'string' ? parsed.socialReposts.slice(0, 8) : defaults.socialReposts
  const socialLikes = typeof parsed.socialLikes === 'string'
    ? parsed.socialLikes.slice(0, 8)
    : typeof parsed.likes === 'string' ? parsed.likes.slice(0, 8) : defaults.socialLikes
  const socialViews = typeof parsed.socialViews === 'string' ? parsed.socialViews.slice(0, 8) : defaults.socialViews
  const socialMetricScale: SocialMetricScale =
    parsed.socialMetricScale === 'subtle' || parsed.socialMetricScale === 'popular'
      ? parsed.socialMetricScale
      : 'daily'
  delete state.showSeries
  delete state.series
  delete state.showEngagement
  delete state.likes
  delete state.comments
  delete state.saves
  delete state.sceneCardPosition
  return { ...defaults, ...state, title, ratio: normalizedRatio, exportMode, theme, imagePosition, imageAlignment, imageScale, fontScale, lineHeightScale, visualStyle, canvasStyle, sceneBackdrop, sceneFocus, sceneCardRatio, sceneCardScale, sceneCardHeight, sceneCardPadding, sceneCardX, sceneCardY, sceneOverlay, socialReplies, socialReposts, socialLikes, socialViews, socialMetricScale }
}

export function loadState(): BymarkState {
  try {
    if (isSharedStorageEnabled()) {
      const shared = sharedInitialValue('settings')
      return shared?.state ? normalizeState(shared.state) : createDefaultState(resolveDeviceTheme())
    }
    const stored =
      parseStoredState(localStorage.getItem(SETTINGS_STORAGE_KEY)) ??
      LEGACY_STORAGE_KEYS.map((key) => parseStoredState(localStorage.getItem(key))).find(Boolean)
    // 首次启动（没有任何保存偏好）时跟随系统深浅色：
    // 系统深色 → 深色主题；系统浅色 → 暖白主题。纯白主题仅手动切换。
    return stored ? normalizeState(stored) : createDefaultState(resolveDeviceTheme())
  } catch {
    return createDefaultState()
  }
}

let sharedSettingsWrite = Promise.resolve()

export function saveState(state: BymarkState) {
  const stored: StoredSettings = {
    version: SETTINGS_VERSION,
    updatedAt: new Date().toISOString(),
    state,
  }
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Local settings are an enhancement; an unavailable browser storage must
    // never prevent the editor from being usable.
  }
  if (isSharedStorageEnabled()) {
    sharedSettingsWrite = sharedSettingsWrite.catch(() => undefined).then(() =>
      saveSharedValue('settings', JSON.parse(JSON.stringify(stored))),
    )
    void sharedSettingsWrite.catch(console.error)
  }
}

function loadLegacyAvatar() {
  try {
    return localStorage.getItem(AVATAR_STORAGE_KEY) ?? localStorage.getItem(LEGACY_AVATAR_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveLegacyAvatar(avatar: string | null) {
  try {
    if (avatar) {
      localStorage.setItem(AVATAR_STORAGE_KEY, avatar)
    } else {
      localStorage.removeItem(AVATAR_STORAGE_KEY)
    }
  } catch {
    // A large image can exceed the browser's local storage quota.
  }
}

function openAvatarDatabase(name = AVATAR_DB_NAME) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }

    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(AVATAR_STORE_NAME)) {
        database.createObjectStore(AVATAR_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open avatar storage'))
  })
}

function readAvatarFromDatabase(name = AVATAR_DB_NAME, key = AVATAR_STORAGE_KEY) {
  return openAvatarDatabase(name).then(
    (database) =>
      new Promise<string | null>((resolve, reject) => {
        const request = database
          .transaction(AVATAR_STORE_NAME, 'readonly')
          .objectStore(AVATAR_STORE_NAME)
          .get(key)
        request.onsuccess = () => {
          database.close()
          resolve(typeof request.result === 'string' ? request.result : null)
        }
        request.onerror = () => {
          database.close()
          reject(request.error ?? new Error('Unable to read avatar storage'))
        }
      }),
  )
}

function writeAvatarToDatabase(avatar: string | null, name = AVATAR_DB_NAME, key = AVATAR_STORAGE_KEY) {
  return openAvatarDatabase(name).then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const store = database.transaction(AVATAR_STORE_NAME, 'readwrite').objectStore(AVATAR_STORE_NAME)
        const request = avatar ? store.put(avatar, key) : store.delete(key)
        request.onsuccess = () => {
          database.close()
          resolve()
        }
        request.onerror = () => {
          database.close()
          reject(request.error ?? new Error('Unable to save avatar storage'))
        }
      }),
  )
}

export async function loadAvatar() {
  if (isSharedStorageEnabled()) return loadSharedValue('avatar')
  try {
    const stored = await readAvatarFromDatabase()
    if (stored) return stored
    const legacyStored = await readAvatarFromDatabase(LEGACY_AVATAR_DB_NAME, LEGACY_AVATAR_STORAGE_KEY)
    if (legacyStored) {
      void writeAvatarToDatabase(legacyStored).catch(() => {})
      return legacyStored
    }
  } catch {
    // Fall back to the previous localStorage format below.
  }
  return loadLegacyAvatar()
}

export async function saveAvatar(avatar: string | null) {
  if (isSharedStorageEnabled()) {
    await saveSharedValue('avatar', avatar)
    return
  }
  try {
    await Promise.all([
      writeAvatarToDatabase(avatar),
      writeAvatarToDatabase(avatar, LEGACY_AVATAR_DB_NAME, LEGACY_AVATAR_STORAGE_KEY),
    ])
    try {
      localStorage.removeItem(AVATAR_STORAGE_KEY)
      localStorage.removeItem(LEGACY_AVATAR_STORAGE_KEY)
    } catch {
      // IndexedDB already contains the durable local copy.
    }
  } catch {
    saveLegacyAvatar(avatar)
  }
}

export async function loadImageAsset(key: string) {
  if (isSharedStorageEnabled()) return loadSharedValue(key === SCENE_IMAGE_ASSET_KEY ? 'sceneImage' : 'image')
  try {
    return await readAvatarFromDatabase(AVATAR_DB_NAME, key)
  } catch {
    return null
  }
}

export async function saveImageAsset(key: string, value: string | null) {
  if (isSharedStorageEnabled()) {
    await saveSharedValue(key === SCENE_IMAGE_ASSET_KEY ? 'sceneImage' : 'image', value)
    return
  }
  try {
    await writeAvatarToDatabase(value, AVATAR_DB_NAME, key)
  } catch {
    // IndexedDB 不可用时无法持久化，仅保留当前会话内的显示。
  }
}

export function formatTime(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) return time.trim()
  const hours = Number(match[1])
  const minutes = match[2]
  return `${String(hours).padStart(2, '0')}:${minutes}`
}

export function signatureFor(signature: string, userId: string) {
  const customSignature = signature.trim()
  if (customSignature) return customSignature
  return userId.trim().replace(/^@+/, '')
}

export function formatDate(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date.trim()
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (Number.isNaN(value.getTime())) return date.trim()
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

export function currentLocalValues() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  }
}

export function filenameFor(state: BymarkState) {
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(state.date) ? state.date : currentLocalValues().date
  return `${filenameBaseFor(state.title, validDate)}.png`
}
