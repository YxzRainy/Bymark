import assert from 'node:assert/strict'
import './social-metrics.mjs'
import { brandProfileFor } from '../src/brandTemplates.ts'
import { filenameBaseFor, normalizeWorkTitle, resolvedTitleFor } from '../src/title.ts'
import { createNextIssueState } from '../src/nextIssue.ts'
import { DEFAULT_BYMARK_SETTINGS, DEFAULT_EXPORT_SETTINGS, DEFAULT_IMAGE_SCALE, resolveDeviceTheme } from '../src/default-settings.ts'
import { normalizeSceneBackdrop, SCENE_BACKDROPS } from '../src/sceneBackdrops.ts'
import { imageScaleLimitForFrame } from '../src/imageScale.ts'
import { compareVersions, resolveVersionUpdate } from '../src/version.ts'
import { WORKSPACE_VERSION, createWorkspaceExport, mergeById, parseWorkspaceExport } from '../src/workspace.ts'
import {
  PAGE_BREAK_MARKER,
  paginateMarkdown,
  paginateMarkdownDetailed,
  setManualBreakBefore,
} from '../src/pagination.ts'

const originalMatchMedia = globalThis.matchMedia
try {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  })
  assert.equal(resolveDeviceTheme(), 'light')

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  })
  assert.equal(resolveDeviceTheme(), 'dark')
} finally {
  if (originalMatchMedia) {
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: originalMatchMedia })
  } else {
    delete globalThis.matchMedia
  }
}

assert.equal(DEFAULT_BYMARK_SETTINGS.theme, 'dark')
assert.equal(DEFAULT_BYMARK_SETTINGS.lineHeightScale, 100)
assert.equal(DEFAULT_BYMARK_SETTINGS.imageScale, DEFAULT_IMAGE_SCALE)
assert.equal(DEFAULT_BYMARK_SETTINGS.visualStyle, 'default')
assert.equal(DEFAULT_BYMARK_SETTINGS.sceneBackdrop, 'lagoon')
assert.equal(DEFAULT_BYMARK_SETTINGS.sceneCardRatio, '3:4')
assert.equal(DEFAULT_BYMARK_SETTINGS.sceneCardHeight, 100)
assert.equal(DEFAULT_BYMARK_SETTINGS.sceneCardPadding, 40)
assert.equal(DEFAULT_BYMARK_SETTINGS.socialReplies, '2')
assert.equal(DEFAULT_BYMARK_SETTINGS.socialReposts, '')
assert.equal(DEFAULT_BYMARK_SETTINGS.socialLikes, '5')
assert.equal(DEFAULT_BYMARK_SETTINGS.socialViews, '307')
assert.equal(DEFAULT_BYMARK_SETTINGS.socialMetricScale, 'daily')
assert.equal(SCENE_BACKDROPS.length, 3)
assert.equal(normalizeSceneBackdrop('sky'), 'sky')
assert.equal(normalizeSceneBackdrop('sunset'), 'lagoon')
assert.equal(normalizeSceneBackdrop('unknown'), 'lagoon')
assert.deepEqual(DEFAULT_EXPORT_SETTINGS, { format: 'png', resolution: 2048 })
assert.equal(imageScaleLimitForFrame({ contentWidth: 452, contentHeight: 676, imageAspectRatio: 1.44, heightBasis: 42 }), 110)
assert.equal(imageScaleLimitForFrame({ contentWidth: 620, contentHeight: 584, imageAspectRatio: 1.44, heightBasis: 38 }), 160)
assert.equal(imageScaleLimitForFrame({ contentWidth: 665, contentHeight: 800, imageAspectRatio: 1.375, heightBasis: 47.8 }), 126)
assert.equal(imageScaleLimitForFrame({ contentWidth: 300, contentHeight: 700, imageAspectRatio: 4, heightBasis: 42 }), 80)
assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
assert.ok(compareVersions('v1.0.0', '1.0.0-beta.2') > 0)
assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0)
assert.equal(compareVersions('not-a-version', '1.0.0'), null)
assert.deepEqual(
  resolveVersionUpdate('0.1.0', { version: '0.2.0', url: 'https://example.com', source: 'release' }),
  { currentVersion: '0.1.0', version: '0.2.0', url: 'https://example.com', source: 'release' },
)
assert.equal(resolveVersionUpdate('0.2.0', { version: '0.2.0', url: 'https://example.com', source: 'release' }), null)

const state = {
  title: '作品标题',
  name: '作者',
  userId: '@author',
  text: '正文',
  time: '12:00',
  date: '2026-01-01',
  location: '杭州',
  showTime: true,
  showDate: true,
  showLocation: true,
  showSignature: true,
  signature: '签名',
  theme: 'dark',
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  imagePosition: 'below',
  imageAlignment: 'center',
  imageScale: 100,
  visualStyle: 'default',
  canvasStyle: 'card',
  sceneBackdrop: 'lagoon',
  sceneFocus: 'center',
  sceneCardRatio: '4:3',
  sceneCardScale: 100,
  sceneCardHeight: 78,
  sceneCardPadding: 64,
  sceneCardX: 50,
  sceneCardY: 50,
  sceneOverlay: 32,
  socialReplies: '2',
  socialReposts: '',
  socialLikes: '5',
  socialViews: '307',
  socialMetricScale: 'daily',
}

const profile = brandProfileFor(state)
assert.equal(profile.name, '作者')
assert.equal(profile.lineHeightScale, 100)
assert.equal(profile.visualStyle, 'default')
assert.equal(profile.sceneBackdrop, 'lagoon')
assert.equal(profile.sceneCardHeight, 78)
assert.equal(profile.sceneCardPadding, 64)
assert.equal(profile.socialMetricScale, 'daily')
assert.equal(brandProfileFor({ ...state, socialMetricScale: 'viral' }).socialMetricScale, 'viral')
assert.equal(brandProfileFor({ ...state, socialMetricScale: 'rising' }).socialMetricScale, 'rising')
assert.equal(resolvedTitleFor(state), '作品标题')
assert.equal(filenameBaseFor(state.title, state.date), 'bymark-作品标题-2026-01-01')
assert.equal(filenameBaseFor(' 一次关于“内容 / 商业”的思考？ ', state.date), 'bymark-一次关于内容-商业的思考-2026-01-01')
assert.equal(filenameBaseFor('', state.date), 'bymark-2026-01-01')
assert.equal(normalizeWorkTitle('标题'.repeat(30)), '标题'.repeat(20))
assert.equal(resolvedTitleFor({ title: '', text: '正文第一行\n第二行' }), '正文第一行')

const payload = createWorkspaceExport({ state, avatar: null, image: 'data:image/png;base64,x', sceneImage: null, drafts: [{ id: 'draft-1' }], archives: [], brandTemplates: [] })
assert.equal(parseWorkspaceExport(payload).version, WORKSPACE_VERSION)
assert.deepEqual(parseWorkspaceExport({ ...payload, version: 1, archives: undefined }).archives, [])
assert.equal(parseWorkspaceExport({ ...payload, state: { ...state, visualStyle: undefined } }).state.visualStyle, 'default')
assert.equal(parseWorkspaceExport({ ...payload, state: { ...state, sceneBackdrop: undefined } }).state.sceneBackdrop, 'lagoon')
assert.equal(parseWorkspaceExport({ ...payload, state: { ...state, socialMetricScale: 'viral' } }).state.socialMetricScale, 'viral')
assert.equal(parseWorkspaceExport({ ...payload, state: { ...state, socialMetricScale: 'rising' } }).state.socialMetricScale, 'rising')
assert.equal(parseWorkspaceExport({ ...payload, state: { ...state, socialMetricScale: undefined } }).state.socialMetricScale, 'daily')
assert.deepEqual(mergeById([{ id: 'draft-1', value: 'old' }], [{ id: 'draft-1', value: 'new' }, { id: 'draft-2' }]), [
  { id: 'draft-1', value: 'new' },
  { id: 'draft-2' },
])
assert.deepEqual(
  mergeById(
    [{ id: 'draft-1', value: 'local-newer', updatedAt: '2026-08-30T10:00:00.000Z' }],
    [
      { id: 'draft-1', value: 'imported-older', updatedAt: '2026-08-30T09:00:00.000Z' },
      { id: 'draft-2', value: 'imported-new', updatedAt: '2026-08-30T09:00:00.000Z' },
    ],
  ),
  [
    { id: 'draft-1', value: 'local-newer', updatedAt: '2026-08-30T10:00:00.000Z' },
    { id: 'draft-2', value: 'imported-new', updatedAt: '2026-08-30T09:00:00.000Z' },
  ],
)
assert.throws(() => parseWorkspaceExport({ ...payload, version: 99 }), /版本不受支持/)

const longPages = paginateMarkdown('观点。'.repeat(500), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.ok(longPages.length >= 2)
assert.equal(longPages.join(''), '观点。'.repeat(500))

const paragraphContinuationSource = [
  '仔细想了下，我自己不就是个本地部署的小模型吗。手机号差不多就是 API，打过去基本能调用，国家免费预训练九年，高中大学开始付费微调，最后效果似乎有点不太行，出来后发现算力完全不够用。',
  '小时候乱说话没人管，后来被社会奖励惩罚几轮，慢慢就对齐了。有的严重过拟合，只会考试。有的训练集比较野，实践经验比较强。',
  '自带多模态、联网搜索，实在不知道还能问旁边另一个模型。推理成本一天三顿饭，还得睡八个小时，连续不关机一两天以后，幻觉率明显上升。',
  '上下文一般，几天前的事情说忘就忘，还特别吃环境，饿了降智，困了降智，喝杯咖啡可以临时超频，连续跑几天直接开始胡说八道，甚至现在时不时有人直接宕机。',
  '有时候明明知道答案，就是懒得推理，你催急了还会拒绝服务，有的型号擅长 Coding，有的支持绘图，还有些模型最大的特长是特别会跟别的模型聊天。',
  '最麻烦的是这个模型情绪会影响模型性能，同一个 Prompt，早上问和凌晨两点问，输出完全不是一回事。而且参数还会自己变，二十岁和三十岁调用的明明是同一个 API，结果可能已经不是一个模型了。',
  '最神奇的是，两个兼容的本地小模型放一起，还能自己接着聊。',
].join('\n\n')
const paragraphContinuationPages = paginateMarkdownDetailed(`${paragraphContinuationSource}\n\n${paragraphContinuationSource}`, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.ok(paragraphContinuationPages.length >= 2)
assert.ok(paragraphContinuationPages[0].fillRatio > 0.89)
assert.equal(
  paragraphContinuationPages.map((page) => page.text).join('\n\n').replace(/\s+/g, ''),
  `${paragraphContinuationSource}\n\n${paragraphContinuationSource}`.replace(/\s+/g, ''),
)

const compactLineHeightPages = paginateMarkdown('观点。'.repeat(400), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 80,
  canvasStyle: 'card',
  hasImage: false,
})
const spaciousLineHeightPages = paginateMarkdown('观点。'.repeat(400), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 160,
  canvasStyle: 'card',
  hasImage: false,
})
assert.ok(spaciousLineHeightPages.length > compactLineHeightPages.length)

const compactFontPages = paginateMarkdown('在这里留下你的文字。'.repeat(320), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 80,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
const defaultFontPages = paginateMarkdown('在这里留下你的文字。'.repeat(320), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.ok(compactFontPages.length < defaultFontPages.length)

const manualPages = paginateMarkdown(`第一页${PAGE_BREAK_MARKER}第二页`, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.deepEqual(manualPages, ['第一页', '第二页'])

const detailedManualPages = paginateMarkdownDetailed(`第一页${PAGE_BREAK_MARKER}第二页`, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.equal(detailedManualPages[1].manualBreakBefore, true)
assert.equal(setManualBreakBefore(`第一页${PAGE_BREAK_MARKER}第二页`, detailedManualPages[1], false).includes(PAGE_BREAK_MARKER), false)

const folioShortPost = `实际上，AI 根本不用替代我们。
它只需要把我们的技术，从稀缺变成廉价。

当一个苦练十年的能力，
别人按一下回车就能做到 70%。

真正开始消失的，是这项能力的稀缺性，
必然有会导致内卷剩下的 30%。

更麻烦的是，没人知道剩下那 30%，还能稀缺多久。`
const folioAutomaticPages = paginateMarkdownDetailed(folioShortPost, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  hasImage: false,
})
assert.equal(folioAutomaticPages.length, 1)
const folioParagraphHeavyPost = Array.from(
  { length: 10 },
  (_, index) => `第 ${index + 1} 段：${'留白'.repeat(6)}`,
).join('\n\n')
const folioParagraphHeavyFullPages = paginateMarkdownDetailed(folioParagraphHeavyPost, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  hasImage: false,
})
assert.equal(folioParagraphHeavyFullPages.length, 1)
const folioParagraphHeavyScenePages = paginateMarkdownDetailed(folioParagraphHeavyPost, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'scene',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  hasImage: false,
})
assert.ok(folioParagraphHeavyScenePages.length > 1)
assert.equal(
  folioParagraphHeavyScenePages.map((page) => page.text).join('\n\n').replace(/\s+/g, ''),
  folioParagraphHeavyPost.replace(/\s+/g, ''),
)

const folioWideSceneShortPost = `我用 **留印** 做这类图，已经一个多月了，
最近有几篇内容被更多人看到，
也有人开始使用类似的版式。

他们没有原始工具时，只能用 AI 改图，
导致文字、头像和署名经常不够清晰。`
const folioWideSceneShortPages = paginateMarkdownDetailed(folioWideSceneShortPost, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'scene',
  visualStyle: 'folio',
  sceneCardRatio: '4:3',
  hasImage: false,
})
assert.equal(folioWideSceneShortPages.length, 1)

const sceneHeightPaginationSource = '卡片高度会参与分页。'.repeat(120)
const fullSceneHeightPages = paginateMarkdownDetailed(sceneHeightPaginationSource, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'scene',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  sceneCardHeight: 100,
  hasImage: false,
})
const compactSceneHeightPages = paginateMarkdownDetailed(sceneHeightPaginationSource, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'scene',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  sceneCardHeight: 60,
  hasImage: false,
})
assert.ok(compactSceneHeightPages.length > fullSceneHeightPages.length)

const folioPinnedSource = `${folioShortPost.slice(0, 43)}${PAGE_BREAK_MARKER}${folioShortPost.slice(43)}`
const folioPinnedPages = paginateMarkdownDetailed(folioPinnedSource, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  visualStyle: 'folio',
  sceneCardRatio: '3:4',
  hasImage: false,
})
assert.equal(folioPinnedPages[1].manualBreakBefore, true)
const folioUnpinnedPages = paginateMarkdownDetailed(
  setManualBreakBefore(folioPinnedSource, folioPinnedPages[1], false),
  {
    ratio: '3:4', exportMode: 'standard', fontScale: 100, lineHeightScale: 100, canvasStyle: 'card', visualStyle: 'folio', sceneCardRatio: '3:4', hasImage: false,
  },
)
assert.equal(folioUnpinnedPages.some((page) => page.manualBreakBefore), false)
assert.equal(folioUnpinnedPages.length, 1)

const automaticDetails = paginateMarkdownDetailed('第一段。'.repeat(420), {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.ok(automaticDetails.length > 1)
const pinnedSource = setManualBreakBefore('第一段。'.repeat(420), automaticDetails[1], true)
assert.ok(pinnedSource.includes(PAGE_BREAK_MARKER))
const pinnedDetails = paginateMarkdownDetailed(pinnedSource, {
  ratio: '3:4',
  exportMode: 'standard',
  fontScale: 100,
  lineHeightScale: 100,
  canvasStyle: 'card',
  hasImage: false,
})
assert.equal(pinnedDetails[1].manualBreakBefore, true)

const nextIssue = createNextIssueState({ ...state, text: '上一期正文' }, { time: '08:30', date: '2026-08-24' })
assert.equal(nextIssue.title, '')
assert.equal(nextIssue.text, '')
assert.equal(nextIssue.date, '2026-08-24')
assert.equal(nextIssue.name, state.name)
assert.equal(nextIssue.ratio, state.ratio)

console.log('Unit checks passed.')
