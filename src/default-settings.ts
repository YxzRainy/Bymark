/**
 * Bymark 的新页面起点。
 *
 * 这份文件只描述“第一次打开时长什么样”：它不会覆盖用户已经保存在
 * 浏览器里的偏好。需要调整默认画幅、主题、信息开关或字体大小时，直接
 * 修改这里即可。
 */
export type Theme = 'dark' | 'light' | 'white'
export type AspectRatio = '2:3' | '3:4' | '9:16'
export type ExportMode = 'standard' | 'douyin-cover'
export type ImagePosition = 'above' | 'below'
export type ImageAlignment = 'left' | 'center'
export type VisualStyle = 'default' | 'folio'
export type CanvasStyle = 'card' | 'scene'
export type SceneFocus = 'top' | 'center' | 'bottom'
export type SceneCardRatio = '4:3' | '1:1' | '3:4'
export type SceneBackdropPreset = 'lagoon' | 'sky' | 'graphite'
import type { SocialMetricScale } from './socialMetrics'
export type { SocialMetricProfile, SocialMetricScale } from './socialMetrics'

const SYSTEM_DEFAULT_THEME: Theme = 'dark'
const THEME_CYCLE: readonly Theme[] = ['light', 'white', 'dark']

export function nextTheme(theme: Theme): Theme {
  const currentIndex = THEME_CYCLE.indexOf(theme)
  return THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length] ?? SYSTEM_DEFAULT_THEME
}

export function themeLabel(theme: Theme): string {
  if (theme === 'light') return '暖米白'
  if (theme === 'white') return '纯白'
  return '深色'
}
export const DEFAULT_IMAGE_SCALE = 126
export const DEFAULT_SCENE_CARD_PADDING = 40
export const SCENE_CARD_PADDING_MIN = 0
export const SCENE_CARD_PADDING_MAX = 100
export const DEFAULT_SCENE_CARD_HEIGHT = 100
export const SCENE_CARD_HEIGHT_MIN = 60
export const SCENE_CARD_HEIGHT_MAX = 100

/**
 * Use the device's preferred color scheme only when no saved preference exists.
 * `matchMedia` is absent in a few non-browser contexts, where we retain dark as
 * the safe, backward-compatible fallback.
 */
export function resolveDeviceTheme(): Theme {
  if (typeof globalThis.matchMedia === 'function') {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return SYSTEM_DEFAULT_THEME
}

export interface BymarkState {
  title: string
  name: string
  userId: string
  text: string
  time: string
  date: string
  location: string
  showTime: boolean
  showDate: boolean
  showLocation: boolean
  showSignature: boolean
  signature: string
  socialReplies: string
  socialReposts: string
  socialLikes: string
  socialViews: string
  socialMetricScale: SocialMetricScale
  theme: Theme
  ratio: AspectRatio
  exportMode: ExportMode
  fontScale: number
  lineHeightScale: number
  imagePosition: ImagePosition
  imageAlignment: ImageAlignment
  imageScale: number
  visualStyle: VisualStyle
  canvasStyle: CanvasStyle
  sceneBackdrop: SceneBackdropPreset
  sceneFocus: SceneFocus
  sceneCardRatio: SceneCardRatio
  sceneCardScale: number
  sceneCardHeight: number
  sceneCardPadding: number
  sceneCardX: number
  sceneCardY: number
  sceneOverlay: number
}

/** 新访客首次打开时使用的内置作者头像。 */
export const DEFAULT_AVATAR = '/default-avatar.png'

/** 内置导出的系统默认值；恢复初始化配置时也会一并恢复。 */
export const DEFAULT_EXPORT_SETTINGS = {
  format: 'png',
  resolution: 2048,
} as const

export const DEFAULT_BYMARK_SETTINGS: Readonly<BymarkState> = {
  title: 'Bymark｜留印',
  name: '失效样本',
  userId: '@sample404',
  text: `留印 | Bymark
为短文字创作者设计的个人化分享图生成器。

它不替你写，也不替你表达。
只把你已经写好的观点、片段和感受，
排成一张带有个人印记的分享图。

头像、署名、时间、地点、图片与版式，
都能按你的方式组合；写完后直接导出，
让短文字带着作者身份一起传播。

少一点模板感，多留一点人的痕迹，
让一句话发出去的时候，也能看得出是谁说的。`,
  time: '22:44',
  date: '2026-08-10',
  location: '杭州',
  showTime: true,
  showDate: true,
  showLocation: true,
  showSignature: true,
  signature: '@失效样本',
  socialReplies: '2',
  socialReposts: '',
  socialLikes: '5',
  socialViews: '307',
  socialMetricScale: 'daily',
  theme: SYSTEM_DEFAULT_THEME,
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  imagePosition: 'below',
  imageAlignment: 'left',
  imageScale: DEFAULT_IMAGE_SCALE,
  visualStyle: 'default',
  canvasStyle: 'card',
  sceneBackdrop: 'lagoon',
  sceneFocus: 'center',
  sceneCardRatio: '3:4',
  sceneCardScale: 100,
  sceneCardHeight: DEFAULT_SCENE_CARD_HEIGHT,
  sceneCardPadding: DEFAULT_SCENE_CARD_PADDING,
  sceneCardX: 50,
  sceneCardY: 50,
  sceneOverlay: 32,
}
