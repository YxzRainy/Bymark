import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'
const artifacts = path.resolve('test-results')
await mkdir(artifacts, { recursive: true })

const browser = await chromium.launch({ headless: true })
const failures = []
const checks = []

function check(condition, label, detail = '') {
  checks.push(label)
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function pngChunkTypes(buffer) {
  const types = []
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    types.push(type)
    offset += length + 12
    if (type === 'IEND') break
  }
  return types
}

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'light',
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await desktop.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

await page.addInitScript(() => {
  window.__initialLayoutFrames = []
  const startedAt = performance.now()
  const capture = () => {
    const editor = document.querySelector('.editor-panel')?.getBoundingClientRect()
    const library = document.querySelector('.draft-library')?.getBoundingClientRect()
    window.__initialLayoutFrames.push({
      elapsed: performance.now() - startedAt,
      editorBottom: editor?.bottom ?? null,
      libraryBottom: library?.bottom ?? null,
      viewportBottom: innerHeight,
    })
    if (performance.now() - startedAt < 500) requestAnimationFrame(capture)
  }
  requestAnimationFrame(capture)
})

await page.goto(baseURL, { waitUntil: 'networkidle' })
await page.waitForTimeout(550)
const initialLayoutFrames = await page.evaluate(() => window.__initialLayoutFrames ?? [])
const paintedLayoutFrames = initialLayoutFrames.filter((frame) =>
  frame.editorBottom !== null && frame.libraryBottom !== null,
)
const initialSidebarMaxDelta = paintedLayoutFrames.reduce((maximum, frame) => Math.max(
  maximum,
  Math.abs(frame.editorBottom - frame.viewportBottom),
  Math.abs(frame.libraryBottom - frame.viewportBottom),
), 0)
check(
  paintedLayoutFrames.length > 0 && initialSidebarMaxDelta <= 1,
  '刷新后的第一帧两侧边栏即延伸至视口底部',
  JSON.stringify({ initialSidebarMaxDelta, frames: paintedLayoutFrames.slice(0, 8) }),
)
await page.screenshot({ path: path.join(artifacts, 'desktop-initial.png') })

check(
  (await page.locator('link[rel="icon"][href="/favicon.ico"]').count()) === 1,
  '标签页图标已指向 favicon.ico',
)
check(
  (await page.locator('link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]').count()) === 1,
  'iPhone 主屏图标已配置',
)
const iconAssets = await page.evaluate(async () =>
  Promise.all(
    ['/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/site.webmanifest'].map(
      async (asset) => ({ asset, ok: (await fetch(asset)).ok }),
    ),
  ),
)
check(iconAssets.every(({ ok }) => ok), '所有高清图标资源均可访问', JSON.stringify(iconAssets))
const defaultAvatarCornerAlpha = await page.evaluate(async () => {
  const image = new Image()
  image.src = '/default-avatar.png'
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  context?.drawImage(image, 0, 0)
  return context?.getImageData(0, 0, 1, 1).data[3] ?? null
})
check(defaultAvatarCornerAlpha === 0, '默认头像圆形外侧为透明，不在浅色模式留下黑边', String(defaultAvatarCornerAlpha))

await page.waitForFunction(() => Boolean(localStorage.getItem('bymark-settings-v1')))
// 首次启动主题跟随系统深浅色（与 loadState 的 resolveDeviceTheme 行为一致）
const systemDefaultTheme = await page.evaluate(() =>
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
)
const initialLocalSettings = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('bymark-settings-v1') ?? 'null'),
)
check(
  initialLocalSettings?.version === 1 &&
    initialLocalSettings?.state?.title === 'Bymark｜留印' &&
    initialLocalSettings?.state?.ratio === '3:4' &&
    initialLocalSettings?.state?.theme === systemDefaultTheme &&
    initialLocalSettings?.state?.fontScale === 100 &&
    initialLocalSettings?.state?.lineHeightScale === 100 &&
    initialLocalSettings?.state?.socialMetricScale === 'daily' &&
    initialLocalSettings?.state?.imagePosition === 'below' &&
    initialLocalSettings?.state?.imageAlignment === 'left' &&
    initialLocalSettings?.state?.imageScale === 126 &&
    initialLocalSettings?.state?.sceneBackdrop === 'lagoon' &&
    initialLocalSettings?.state?.sceneCardHeight === 100 &&
    initialLocalSettings?.state?.sceneCardPadding === 40 &&
    initialLocalSettings?.state?.name === '失效样本' &&
    initialLocalSettings?.state?.userId === '@sample404' &&
    initialLocalSettings?.state?.showSignature === true,
  '首次打开使用完整的内置系统默认状态与设置',
  JSON.stringify({ systemDefaultTheme, initialLocalSettings }),
)

const manuallySelectedTheme = systemDefaultTheme === 'dark' ? 'light' : 'dark'
// 主题为三档循环（暖米白 → 纯白 → 深色），循环点击直到进入目标主题
const cycleThemeTo = async (target) => {
  for (let i = 0; i < 3; i += 1) {
    if (await page.locator('.app-shell').evaluate((node, t) => node.classList.contains(`ui-${t}`), target)) return
    await page.getByRole('button', { name: /切换到/ }).first().click()
    await page.waitForTimeout(150)
  }
  await page.waitForFunction((t) => document.querySelector('.app-shell')?.classList.contains(`ui-${t}`), target)
}
await cycleThemeTo(manuallySelectedTheme)

// 内边距经由 Vue 响应式驱动 CSS 变量，滑杆 fill 后样式会晚一拍落地，
// 需要轮询等待 computed padding 变为目标值再断言。
const waitForInnerPadding = async (selector, expected) => {
  await page.waitForFunction(({ selector, expected }) => {
    const node = document.querySelector(selector)
    if (!node) return false
    const style = getComputedStyle(node)
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join('|') === expected
  }, { selector, expected }, { timeout: 5000 })
}
await page.reload({ waitUntil: 'networkidle' })
check(
  await page.locator('.app-shell').evaluate((node, theme) => node.classList.contains(`ui-${theme}`), manuallySelectedTheme),
  '手动切换后的主题优先从本地设置恢复',
  manuallySelectedTheme,
)
await page.getByRole('button', { name: '恢复初始化配置', exact: true }).click()
await page.waitForTimeout(220)
await page.getByRole('tab', { name: '导出' }).click()
check((await page.getByLabel('昵称').inputValue()) === '失效样本', '可将当前作品恢复为初始化作者设置')
await page.getByRole('tab', { name: '内容' }).click()
check((await page.locator('#bymark-title').inputValue()) === 'Bymark｜留印', '恢复初始化配置会还原作品标题')
check((await page.getByLabel('正文', { exact: true }).inputValue()).startsWith('留印 | Bymark'), '恢复初始化配置会还原项目默认文字')
check((await page.locator('.post-avatar img:not(.pagination-probe *)').getAttribute('src')) === '/default-avatar.png', '恢复初始化配置会还原项目默认头像')
check(
  await page.locator('.app-shell').evaluate((node) => node.classList.contains('ui-dark')),
  '恢复初始化配置会还原内置主题',
)
check(
  await page.evaluate(() => {
    const exportPreferences = JSON.parse(localStorage.getItem('bymark-export-preferences-v1') ?? 'null')
    return exportPreferences?.format === 'png' && exportPreferences?.resolution === 2048
  }),
  '恢复初始化配置会还原内置导出设置',
)

check((await page.title()) === '留印', '页面标题正确')
check(await page.locator('.brand-lockup').isVisible(), '品牌与核心用途首屏可见')
check((await page.locator('.brand-lockup h1').innerText()) === '留印', '桌面品牌标题保持单一且简洁')
check(
  (await page.locator('img.brand-mark').getAttribute('src')) === '/icon-192.png',
  '页面品牌图标与网站 ico 使用同一图案',
)
check(
  (await page.locator('.post-avatar img:not(.pagination-probe *)').getAttribute('src')) === '/default-avatar.png',
  '首次打开使用项目内置头像，而非依赖浏览器本地数据',
)
check(await page.locator('.export-button').isVisible(), '导出入口首屏可见')
const contentHeaderLayout = await page.locator('.content-label-line').evaluate((node) => ({
  alignItems: getComputedStyle(node).alignItems,
  labelLineHeight: getComputedStyle(node.querySelector('.field-label')).lineHeight,
  metricsLineHeight: getComputedStyle(node.querySelector('.text-metrics')).lineHeight,
  metricsMargin: getComputedStyle(node.querySelector('.text-metrics')).marginBottom,
  metricItemMargins: Array.from(node.querySelectorAll('.text-metrics > span')).map((item) => getComputedStyle(item).marginBottom),
}))
check(
  contentHeaderLayout.alignItems === 'center' &&
    contentHeaderLayout.labelLineHeight === '18px' &&
    contentHeaderLayout.metricsLineHeight === '18px' &&
    contentHeaderLayout.metricsMargin === '0px' &&
    contentHeaderLayout.metricItemMargins.every((margin) => margin === '0px'),
  '正文标题与全部字数统计使用同一条水平中线',
  JSON.stringify(contentHeaderLayout),
)
check((await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').count()) === 1, '仅有一张最终导出卡片')
check(await page.getByRole('button', { name: '打开草稿抽屉' }).isHidden(), '桌面端不显示移动草稿入口')
await page.waitForFunction(() => {
  const editorBottom = document.querySelector('.editor-panel')?.getBoundingClientRect().bottom
  const libraryBottom = document.querySelector('.draft-library')?.getBoundingClientRect().bottom
  return editorBottom !== undefined && libraryBottom !== undefined &&
    Math.abs(editorBottom - innerHeight) <= 1 && Math.abs(libraryBottom - innerHeight) <= 1
})
const sidebarExtent = await page.evaluate(() => {
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
  return {
    viewportBottom: innerHeight,
    editorBottom: rect('.editor-panel')?.bottom,
    libraryBottom: rect('.draft-library')?.bottom,
  }
})
check(
  Math.abs(sidebarExtent.editorBottom - sidebarExtent.viewportBottom) <= 1 &&
    Math.abs(sidebarExtent.libraryBottom - sidebarExtent.viewportBottom) <= 1,
  '桌面两侧边栏完整延伸至视口底部',
  JSON.stringify(sidebarExtent),
)
await page.getByRole('tab', { name: '版式' }).click()
check(await page.getByRole('button', { name: 'Bymark', exact: true }).isVisible(), '版式选择位于画幅上方并默认保留 Bymark')
check((await page.locator('.visual-style-picker').getByRole('button').count()) === 2, '样式选择器仅保留必要选项')
check((await page.locator('.visual-style-swatch').count()) === 0, '样式选择器移除装饰性预览图')
check((await page.getByRole('group', { name: '布局' }).getByRole('button').allTextContents()).join('|') === '铺满|悬浮', '铺满与悬浮作为独立布局选项常驻版式面板')
await page.getByRole('button', { name: 'X', exact: true }).click()
// 样式切换走过渡动画，folio class 会延迟一帧添加
await page.waitForFunction(() => document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.classList.contains('post-card-folio') === true, null, { timeout: 5000 })
check(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-folio')), 'X / Twitter 样式进入独立的社交卡片布局')
check(!(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-scene'))), '切换 X / Twitter 不会自动进入场景')
check(await page.getByRole('button', { name: '铺满', exact: true }).getAttribute('aria-pressed') === 'true', 'X / Twitter 沿用当前铺满呈现方式')
check(await page.getByLabel('选择场景背景图片').isHidden(), '满版时隐藏场景背景控制')
const folioFullLayout = await page.locator('.post-card-folio .post-card-inner').first().evaluate((node) => {
  const style = getComputedStyle(node)
  return {
    width: style.width,
    height: style.height,
    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
  }
})
check(
  folioFullLayout.padding.join('|') === '40px|40px|15px|40px',
  'X / Twitter 满版使用上、左右 40px 与下方 15px 的内边距',
  JSON.stringify(folioFullLayout),
)
await page.getByRole('button', { name: '悬浮', exact: true }).click()
await page.locator('[data-testid="export-card"].post-card-scene:not([data-pagination-probe])').waitFor({ state: 'visible' })
await page.getByRole('tab', { name: '内容' }).click()
const socialMetricsDisclosure = page.getByRole('button', { name: '互动数据', exact: true })
const socialMetricsRandomizer = page.locator('.social-metrics-random-button')
const socialMetricsHeaderLayout = await page.evaluate(() => {
  const trigger = document.querySelector('.social-metrics-disclosure .settings-disclosure-trigger')?.getBoundingClientRect()
  const action = document.querySelector('.social-metrics-random-button')?.getBoundingClientRect()
  return trigger && action
    ? {
        actionOnRight: action.left >= trigger.right,
        centered: Math.abs((trigger.top + trigger.bottom) / 2 - (action.top + action.bottom) / 2) <= 1,
      }
    : null
})
check(
  socialMetricsHeaderLayout?.actionOnRight && socialMetricsHeaderLayout?.centered,
  '互动数据的随机生成按钮位于标题右侧并水平对齐',
  JSON.stringify(socialMetricsHeaderLayout),
)
check((await socialMetricsDisclosure.getAttribute('aria-expanded')) === 'false', '互动数据默认保持收起')
await socialMetricsRandomizer.click()
check((await socialMetricsDisclosure.getAttribute('aria-expanded')) === 'false', '随机生成按钮不会展开互动数据')
await socialMetricsDisclosure.click()
check((await page.locator('.social-metrics-grid input').count()) === 4, '展开互动数据后显示四项数据输入框')
check(
  await page.locator('.social-metrics-scale-picker button.active').evaluate((node) => node.textContent === '日常'),
  '互动数据默认使用日常随机规模',
)
await page.getByRole('button', { name: '克制', exact: true }).click()
check(
  await page.locator('.social-metrics-scale-picker button.active').evaluate((node) => node.textContent === '克制'),
  '可切换为克制随机规模',
)
await page.getByRole('tab', { name: '版式' }).click()
await page.getByRole('button', { name: /^场景微调/ }).click()
const folioPaddingControl = page.locator('#bymark-scene-card-padding')
check(
  await folioPaddingControl.getAttribute('min') === '0' &&
    await folioPaddingControl.getAttribute('max') === '100' &&
    await folioPaddingControl.inputValue() === '40',
  'X / Twitter 卡片内边距默认 40%，可调节至 0%',
)
const folioPaddingAtDefault = await page.locator('.post-card-folio .post-card-inner').first().evaluate((node) => {
  const style = getComputedStyle(node)
  return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
})
await folioPaddingControl.fill('70')
await waitForInnerPadding('.post-card-folio .post-card-inner', '43.4px|47.6px|35px|47.6px')
const folioPaddingAt70 = await page.locator('.post-card-folio .post-card-inner').first().evaluate((node) => {
  const style = getComputedStyle(node)
  return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
})
check(
  folioPaddingAt70.every((value, index) => Number.parseFloat(value) > Number.parseFloat(folioPaddingAtDefault[index])),
  '调节 X / Twitter 卡片内边距会同步放大四周留白',
  JSON.stringify({ folioPaddingAtDefault, folioPaddingAt70 }),
)
await folioPaddingControl.fill('40')
await waitForInnerPadding('.post-card-folio .post-card-inner', '24.8px|27.2px|20px|27.2px')
const folioDefaultLayout = await page.locator('.post-card-folio .post-card-inner').first().evaluate((inner) => {
  const style = getComputedStyle(inner)
  const avatar = inner.querySelector('.post-avatar')
  const content = inner.querySelector('.post-content')
  const copy = inner.querySelector('.post-copy')
  const actions = inner.querySelector('.post-social-actions')
  const actionsStyle = actions ? getComputedStyle(actions) : null
  const innerBounds = inner.getBoundingClientRect()
  const actionBounds = actions?.getBoundingClientRect()
  return {
    width: style.width,
    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    avatarWidth: avatar ? getComputedStyle(avatar).width : '',
    contentMarginTop: content ? getComputedStyle(content).marginTop : '',
    copyFontSize: copy ? getComputedStyle(copy).fontSize : '',
    actionsPadding: actionsStyle ? [actionsStyle.paddingTop, actionsStyle.paddingBottom] : [],
    actionsBottomGap: actionBounds ? innerBounds.bottom - actionBounds.bottom : Number.NaN,
  }
})
check(
  folioDefaultLayout.width === '576px' &&
    folioDefaultLayout.padding.join('|') === '24.8px|27.2px|20px|27.2px' &&
    folioDefaultLayout.avatarWidth === '76px' &&
    folioDefaultLayout.contentMarginTop === '24px' &&
    folioDefaultLayout.copyFontSize === '19.32px' &&
    folioDefaultLayout.actionsPadding.join('|') === '22px|24px' &&
    folioDefaultLayout.actionsBottomGap <= 1,
  'X / Twitter 场景卡保持紧凑留白与贴底互动栏',
  JSON.stringify(folioDefaultLayout),
)
await folioPaddingControl.fill('0')
await waitForInnerPadding('.post-card-folio .post-card-inner', '0px|0px|0px|0px')
check(
  (await page.locator('.post-card-folio .post-card-inner').first().evaluate((node) => {
    const style = getComputedStyle(node)
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].every((value) => value === '0px')
  })),
  'X / Twitter 卡片内边距可收至 0%',
)
await folioPaddingControl.fill('40')
check(
  await page.locator('.post-card-folio .post-card-inner').first().evaluate((node) => getComputedStyle(node).borderRadius) === '5px',
  'X / Twitter 内侧卡片使用 5px 圆角',
)
check(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-dark')), 'X / Twitter 样式保留当前深色主题')
await cycleThemeTo('light')
await page.getByRole('button', { name: 'Bymark', exact: true }).click()
await page.getByRole('button', { name: 'X', exact: true }).click()
check(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-light')), 'X / Twitter 样式不会覆盖当前浅色主题')
check(await page.locator('.post-social-actions svg:not(.pagination-probe *)').count() === 6, 'X / Twitter 样式显示底部六个互动按钮')
check(await page.locator('.post-social-meta:not(.pagination-probe *)').count() === 0, 'X / Twitter 样式移除日期时间等附加信息')
check(await page.locator('.post-social-subscription-mark:not(.pagination-probe *)').count() === 1, 'X / Twitter 样式使用指定右上角 X 标志')
check(await page.getByLabel('选择场景背景图片').isVisible(), 'X / Twitter 样式支持自定义背景图片')
await cycleThemeTo('dark')
await page.getByRole('button', { name: 'Bymark', exact: true }).click()
await page.getByRole('button', { name: '铺满', exact: true }).click()
await page.locator('[data-testid="export-card"].post-card-3-4:not([data-pagination-probe])').waitFor({ state: 'visible' })
// 切回默认样式走过渡动画，folio class 会延迟一帧移除
await page.waitForFunction(() => document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.classList.contains('post-card-folio') === false, null, { timeout: 5000 })
check(!(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-folio'))), '切回默认样式后恢复当前卡片结构')
check(await page.getByRole('button', { name: '3:4 · 默认文字思考', exact: true }).isVisible(), '3:4 是默认文字思考画幅')
check((await page.locator('.ratio-segmented button').count()) === 4, '画幅与平台集中在版式面板')
for (const presetName of ['2:3 · 抖音图文推荐', '9:16 · 全屏发布']) {
  check(await page.getByRole('button', { name: presetName, exact: true }).isVisible(), `${presetName} 预设说明清晰`)
}
check(
  await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.clientHeight === 1067),
  '默认画幅为 3:4 文字思考',
)

const initialVisuals = await page.evaluate(() => {
  const style = (selector) => getComputedStyle(document.querySelector(selector))
  const avatar = document.querySelector('.post-avatar')
  return {
    appBackground: style('.app-shell').backgroundColor,
    panelBackground: style('.editor-panel').backgroundColor,
    controlBackground: style('.font-scale-control').backgroundColor,
    cardBackground: style('[data-testid="export-card"]').backgroundColor,
    cardRadius: style('[data-testid="export-card"]').borderRadius,
    cardShadow: style('[data-testid="export-card"]').boxShadow,
    avatarBackground: style('.post-avatar').backgroundColor,
    avatarBorder: style('.post-avatar').borderTopColor,
    avatarWidth: style('.post-avatar').width,
    nameSize: style('.post-name').fontSize,
    idSize: style('.post-id').fontSize,
  }
})
check(initialVisuals.appBackground === 'rgb(11, 12, 13)', '深色模式使用纯净近黑工作台', initialVisuals.appBackground)
check(
  initialVisuals.panelBackground === 'rgb(17, 18, 20)',
  '深色编辑面板与背景有清晰层级',
  initialVisuals.panelBackground,
)
check(initialVisuals.controlBackground === 'rgb(22, 24, 27)', '深色输入控件层级清晰', initialVisuals.controlBackground)
check(initialVisuals.cardBackground === 'rgb(21, 22, 23)', '深色卡片不与工作台融成一片', initialVisuals.cardBackground)
check(
  initialVisuals.avatarBackground === 'rgba(0, 0, 0, 0)' && initialVisuals.avatarBorder === 'rgb(21, 22, 23)',
  '深色导出头像使用透明底与深色描边',
  JSON.stringify(initialVisuals),
)
check(initialVisuals.cardRadius === '2px', '导出卡片圆角固定为 2px', initialVisuals.cardRadius)
check(
  initialVisuals.cardShadow.includes('rgba(0, 0, 0, 0.16)') && initialVisuals.cardShadow.includes('0px 1px 4px'),
  '导出卡片使用指定阴影',
  initialVisuals.cardShadow,
)
check(
  initialVisuals.avatarWidth === '76px' && initialVisuals.nameSize === '22px' && initialVisuals.idSize === '17px',
  '作者头像与身份信息尺寸已强化',
  JSON.stringify(initialVisuals),
)
check(
  (await page.locator('.post-card-inner').first().evaluate((node) => getComputedStyle(node).paddingRight)) === '68px',
  '3:4 默认预设使用对称阅读边距',
)
check(
  (await page.locator('.post-content:not(.pagination-probe *)').evaluate((node) => {
    const style = getComputedStyle(node)
    return style.marginTop === '24px'
  })),
  '3:4 默认预设将正文与作者区间距收紧至 24px',
)
check(
  (await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).marginLeft)) === '5px',
  '正文文字向右移动 5px',
)
await page.getByRole('button', { name: /^高级/ }).click()
const fontScaleDefaults = await page.locator('#bymark-font-scale').evaluate((node) => ({
  value: node.value,
  min: node.min,
  max: node.max,
  step: node.step,
}))
check(
  fontScaleDefaults.value === '100' &&
    fontScaleDefaults.min === '0' &&
    fontScaleDefaults.max === '200' &&
    fontScaleDefaults.step === '1',
  '字体大小默认 100%，支持 0–200% 无级调节',
  JSON.stringify(fontScaleDefaults),
)
check(
  await page.getByRole('button', { name: /标准/ }).getAttribute('aria-pressed') === 'true',
  '默认字体大小明确选中标准档位',
)
await page.getByRole('button', { name: '字体缩小 1%' }).click()
check((await page.locator('#bymark-font-scale').inputValue()) === '99', '减号按钮每次将字体缩小 1%')
await page.getByRole('button', { name: '字体放大 1%' }).click()
check((await page.locator('#bymark-font-scale').inputValue()) === '100', '加号按钮每次将字体放大 1%')
const lineHeightDefaults = await page.locator('#bymark-line-height-scale').evaluate((node) => ({
  value: node.value,
  min: node.min,
  max: node.max,
  step: node.step,
}))
check(
  lineHeightDefaults.value === '100' &&
    lineHeightDefaults.min === '80' &&
    lineHeightDefaults.max === '160' &&
    lineHeightDefaults.step === '1',
  '文字行高默认 100%，支持 80–160% 调节',
  JSON.stringify(lineHeightDefaults),
)
const defaultCopyLineHeight = await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight))
await page.getByRole('button', { name: '行高增加 1%' }).click()
const increasedCopyLineHeight = await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight))
check(
  (await page.locator('#bymark-line-height-scale').inputValue()) === '101' && increasedCopyLineHeight > defaultCopyLineHeight,
  '行高加号每次增加 1% 并实时更新正文',
  `${defaultCopyLineHeight} → ${increasedCopyLineHeight}`,
)
await page.getByRole('button', { name: '行高减小 1%' }).click()
check((await page.locator('#bymark-line-height-scale').inputValue()) === '100', '行高减号每次减少 1%')
const fontControlPlacement = await page.evaluate(() => {
  const textArea = document.querySelector('#bymark-text')
  const fontControl = document.querySelector('#bymark-font-scale')
  return {
    sameSection: textArea?.closest('.editor-tab-panel') !== fontControl?.closest('.editor-tab-panel'),
    belowText: (fontControl?.getBoundingClientRect().top ?? 0) > (textArea?.getBoundingClientRect().bottom ?? 0),
  }
})
check(
  fontControlPlacement.sameSection,
  '文字密度与文字大小调节集中在版式面板',
  JSON.stringify(fontControlPlacement),
)
await page.getByRole('tab', { name: '导出' }).click()
check(await page.getByRole('switch', { name: '显示签名' }).isVisible(), '签名开关在作者档案中可见')
check(await page.locator('#bymark-signature').isVisible(), '内置演示状态默认显示签名输入框')
await page.waitForTimeout(80)
check((await page.locator('.post-signature:not(.pagination-probe *)').textContent()) === '@失效样本', '内置演示状态显示预设签名')
const signatureVisuals = await page.locator('.post-signature:not(.pagination-probe *)').evaluate((node) => {
  const style = getComputedStyle(node)
  const rowStyle = getComputedStyle(node.parentElement)
  return {
    position: style.position,
    fontSize: style.fontSize,
    color: style.color,
    overflow: style.overflow,
    whiteSpace: style.whiteSpace,
    textOverflow: style.textOverflow,
    rowDisplay: rowStyle.display,
    rowAlignItems: rowStyle.alignItems,
  }
})
const signatureBox = await page.locator('.post-signature:not(.pagination-probe *)').boundingBox()
const metaBox = await page.locator('.post-meta:not(.pagination-probe *)').boundingBox()
const signatureCardBox = await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').boundingBox()
check(
  signatureVisuals.position === 'static' &&
    signatureVisuals.rowDisplay === 'flex' &&
    signatureVisuals.rowAlignItems === 'baseline',
  '签名与时间信息保持同一行',
  JSON.stringify(signatureVisuals),
)
check(
  Math.abs((signatureBox?.y ?? 0) + (signatureBox?.height ?? 0) - ((metaBox?.y ?? 0) + (metaBox?.height ?? 0))) <= 2,
  '签名与左侧时间基线对齐',
  JSON.stringify({ signatureBox, metaBox }),
)
const signatureRightGutter =
  (signatureCardBox?.x ?? 0) + (signatureCardBox?.width ?? 0) - ((signatureBox?.x ?? 0) + (signatureBox?.width ?? 0))
const scaledOuterGutter = 68 * ((signatureCardBox?.width ?? 0) / 800)
check(
  Math.abs(signatureRightGutter - scaledOuterGutter) <= 2,
  '签名与右侧边缘保持 68px，对齐左侧时间边距',
  JSON.stringify({ signatureCardBox, signatureBox, signatureRightGutter, scaledOuterGutter }),
)
check(
  Number.parseFloat(signatureVisuals.fontSize) >= 12 && Number.parseFloat(signatureVisuals.fontSize) <= 14,
  '签名字号保持弱化',
  signatureVisuals.fontSize,
)
check(
  signatureVisuals.overflow === 'visible' &&
    signatureVisuals.whiteSpace === 'nowrap' &&
    signatureVisuals.textOverflow === 'clip',
  '签名保持单行且不会在导出克隆中被省略号截断',
  JSON.stringify(signatureVisuals),
)
check(signatureVisuals.color === 'rgba(255, 255, 255, 0.36)', '深色模式签名使用低对比度白色', signatureVisuals.color)
await page.getByLabel('签名文字').fill('@这是一段用于验证窄空间署名完整显示且绝不换行或截断的长签名')
await page.waitForTimeout(80)
const longSignatureLayout = await page.locator('.post-signature:not(.pagination-probe *)').evaluate((node) => {
  const style = getComputedStyle(node)
  return {
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    fontSize: Number.parseFloat(style.fontSize),
    whiteSpace: style.whiteSpace,
  }
})
check(
  longSignatureLayout.whiteSpace === 'nowrap' &&
    longSignatureLayout.scrollWidth <= longSignatureLayout.clientWidth + 1 &&
    longSignatureLayout.scrollHeight <= longSignatureLayout.clientHeight + 1 &&
    longSignatureLayout.fontSize < 13,
  '窄空间中的长签名会缩小为完整单行，不会换行或被裁切',
  JSON.stringify(longSignatureLayout),
)
await page.getByLabel('签名文字').fill('404')
check((await page.locator('.post-signature:not(.pagination-probe *)').textContent()) === '404', '自定义签名优先显示')
await page.getByRole('switch', { name: '显示签名' }).click()
check((await page.locator('.post-signature:not(.pagination-probe *)').count()) === 0, '关闭签名后卡片不显示签名')
await page.getByRole('switch', { name: '显示签名' }).click()
await page.getByRole('tab', { name: '版式' }).click()
const initialCopySize = await page
  .locator('.post-copy:not(.pagination-probe *)')
  .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))
check(
  initialCopySize === 19.32,
  '默认 3:4 正文在 100% 设置下使用增加 5% 后的 19.32px 基准字号',
  String(initialCopySize),
)
if (!(await page.locator('#bymark-font-scale').isVisible().catch(() => false))) {
  await page.getByRole('button', { name: /高级/ }).first().click()
}
const fontScale = page.locator('#bymark-font-scale')
await fontScale.waitFor({ state: 'visible' })
await fontScale.press('Home')
await page.waitForTimeout(80)
const reducedCopySize = await page
  .locator('.post-copy:not(.pagination-probe *)')
  .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))
check(reducedCopySize < initialCopySize, '文字大小滑杆可实时缩小正文', `${initialCopySize} → ${reducedCopySize}`)
for (let step = 0; step < 100; step += 1) await fontScale.press('ArrowRight')
check((await fontScale.inputValue()) === '100', '文字大小滑杆可恢复默认值', await fontScale.inputValue())
check((await page.locator('#bymark-font').count()) === 0, '编辑器不再提供多余的字体选择')
check(
  (await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).fontFamily)).includes('PingFang SC'),
  '正文固定使用苹方（macOS）',
)
let sourceModulesAvailable = false
try {
  const sourceResponse = await fetch(new URL('/src/App.tsx', baseURL))
  sourceModulesAvailable = sourceResponse.ok && (sourceResponse.headers.get('content-type') ?? '').includes('javascript')
} catch {
  sourceModulesAvailable = false
}
const exportFontMetrics = sourceModulesAvailable ? await page.evaluate(async () => {
  let stylePropertiesForExport
  let toSvg
  try {
    ;[{ stylePropertiesForExport }, { toSvg }] = await Promise.all([
      import('/src/App.tsx'),
      import('/node_modules/.vite/deps/html-to-image.js'),
    ])
  } catch {
    return null
  }
  const card = document.querySelector('[data-testid="export-card"]')
  const copy = document.querySelector('.post-copy')
  const computedFontSize = Number.parseFloat(getComputedStyle(copy).fontSize)
  const svgUrl = await toSvg(card, {
    width: 800,
    height: 800 * 4 / 3,
    backgroundColor: '#151617',
    includeStyleProperties: stylePropertiesForExport(),
  })
  const source = decodeURIComponent(svgUrl.slice(svgUrl.indexOf(',') + 1))
  const start = source.indexOf('class="post-copy"')
  const clonedStyle = source.slice(start, start + 3000)
  const clonedFontSize = Number.parseFloat(/font: [^;]*?([\d.]+)px\s*\//.exec(clonedStyle)?.[1] ?? 'NaN')
  return { computedFontSize, clonedFontSize }
}) : null
check(
  exportFontMetrics === null || exportFontMetrics.computedFontSize === exportFontMetrics.clonedFontSize,
  '导出克隆保持与实时预览完全相同的文字尺寸和换行度量',
  exportFontMetrics ? JSON.stringify(exportFontMetrics) : '生产构建不暴露源码模块，跳过内部导入校验',
)

await page.getByRole('tab', { name: '内容' }).click()
const titleInput = page.locator('#bymark-title')
const titleSettingsToggle = page.getByRole('button', { name: '作品标题 可选', exact: true })
const openTitleSettings = async () => {
  if ((await titleSettingsToggle.getAttribute('aria-expanded')) !== 'true') await titleSettingsToggle.click()
}
const bodyInput = page.getByLabel('正文', { exact: true })
check((await bodyInput.getAttribute('placeholder')) === '在这里留下你的文字。', '正文空状态与预览提示保持一致')
check((await titleSettingsToggle.getAttribute('aria-expanded')) === 'false', '作品标题默认收起，不打断写作')
await openTitleSettings()
check((await titleInput.getAttribute('placeholder')) === '留空时取正文首行', '展开后仅显示紧凑的作品标题输入框')
await titleInput.fill('仅用于管理的作品标题')
await titleInput.press('Enter')
check(await bodyInput.evaluate((node) => document.activeElement === node), '标题按 Enter 后直接进入正文编辑')
check(!(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').textContent())?.includes('仅用于管理的作品标题'), '作品标题默认不渲染到卡片画面')
await titleInput.fill('Bymark｜留印')
await bodyInput.fill('中文 A， B\n')
check(
  (await page.getByTestId('text-metrics').textContent())?.replace(/\s+/g, ' ').includes('8 字符'),
  '正文统计以单一字符数呈现',
  (await page.getByTestId('text-metrics').textContent()) ?? '',
)
check(
  (await page.getByTestId('text-metrics').textContent())?.replace(/\s+/g, ' ').includes('约 1 分钟'),
  '正文统计保留预计阅读时长',
  (await page.getByTestId('text-metrics').textContent()) ?? '',
)
await bodyInput.fill('这是需要强调的文字')
await bodyInput.evaluate((node) => node.setSelectionRange(2, 6))
await bodyInput.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B')
check(
  (await bodyInput.inputValue()) === '这是**需要强调**的文字',
  '⌘/Ctrl + B 会将选区转为 Markdown 加粗',
  await bodyInput.inputValue(),
)
check((await page.locator('.post-copy:not(.pagination-probe *) strong').textContent()) === '需要强调', 'Markdown 加粗会在卡片预览中按样式显示')
const boldVisuals = await page.locator('.post-copy:not(.pagination-probe *) strong').evaluate((node) => {
  const style = getComputedStyle(node)
  return { color: style.color, fontWeight: Number(style.fontWeight) }
})
check(
  boldVisuals.color === 'rgb(255, 255, 255)' && boldVisuals.fontWeight >= 900,
  '加粗在深色卡片使用 900 字重与纯白对比',
  JSON.stringify(boldVisuals),
)
await bodyInput.fill('# 一级标题\n\n正文内容')
check((await page.locator('.post-copy:not(.pagination-probe *) h1').textContent()) === '一级标题', 'Markdown 一级标题在卡片中正确渲染')
const headingVisuals = await page.locator('.post-copy:not(.pagination-probe *) h1').evaluate((node) => {
  const style = getComputedStyle(node)
  return { fontSize: Number.parseFloat(style.fontSize), fontWeight: Number(style.fontWeight), textStrokeWidth: style.webkitTextStrokeWidth }
})
check(
  headingVisuals.fontSize > 19 && headingVisuals.fontWeight >= 800 && headingVisuals.textStrokeWidth !== '0px',
  '一级标题同时具备放大和清晰的加粗效果',
  JSON.stringify(headingVisuals),
)
await bodyInput.fill('这段文字需要倾斜显示')
await bodyInput.evaluate((node) => node.setSelectionRange(2, 6))
await page.getByRole('button', { name: '斜体' }).click()
await page.waitForTimeout(60) // focusSelection 通过 rAF 异步恢复选区，先等它落地再继续输入
check(
  (await bodyInput.inputValue()) === '这段*文字需要*倾斜显示',
  '斜体按钮会将选区转为 Markdown 斜体',
  await bodyInput.inputValue(),
)
const italicVisuals = await page.locator('.post-copy:not(.pagination-probe *) em').evaluate((node) => {
  const style = getComputedStyle(node)
  return { fontStyle: style.fontStyle, fontSynthesis: style.fontSynthesis }
})
check(
  italicVisuals.fontStyle.includes('oblique') && italicVisuals.fontSynthesis === 'style',
  '斜体为缺少原生字形的中文字体启用可见的倾斜样式',
  JSON.stringify(italicVisuals),
)
await bodyInput.fill('第一项\n第二项')
await bodyInput.evaluate((node) => node.setSelectionRange(0, node.value.length))
await page.getByRole('button', { name: '无序列表' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check(
  (await bodyInput.inputValue()) === '• 第一项\n• 第二项',
  '无序列表按钮会为多行选区逐行插入圆点',
  await bodyInput.inputValue(),
)
check((await page.locator('.post-copy:not(.pagination-probe *) ul > li').count()) === 2, '无序列表在卡片预览中渲染为两个项目')
check(
  (await page.locator('.post-copy:not(.pagination-probe *) ul').evaluate((node) => getComputedStyle(node).listStyleType)) === 'disc',
  '无序列表在卡片预览中显示项目符号',
)
await page.getByRole('button', { name: '无序列表' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check((await bodyInput.inputValue()) === '第一项\n第二项', '再次点击无序列表可移除项目符号', await bodyInput.inputValue())
await bodyInput.fill('第一项\n\n第二项')
await bodyInput.evaluate((node) => node.setSelectionRange(0, node.value.length))
await page.getByRole('button', { name: '无序列表' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check(
  (await bodyInput.inputValue()) === '• 第一项\n\n• 第二项',
  '无序列表保留段落间的空行，不生成空白列表项',
  await bodyInput.inputValue(),
)
await page.getByRole('button', { name: '无序列表' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check((await bodyInput.inputValue()) === '第一项\n\n第二项', '带空行的无序列表可完整移除项目符号', await bodyInput.inputValue())
await bodyInput.fill('第一项\n第二项')
await bodyInput.evaluate((node) => node.setSelectionRange(0, node.value.length))
await page.getByRole('button', { name: '有序列表' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check(
  (await bodyInput.inputValue()) === '1. 第一项\n2. 第二项',
  '有序列表按钮会为多行选区连续编号',
  await bodyInput.inputValue(),
)
check((await page.locator('.post-copy:not(.pagination-probe *) ol > li').count()) === 2, '有序列表在卡片预览中渲染为两个项目')
check(
  (await page.locator('.post-copy:not(.pagination-probe *) ol').evaluate((node) => getComputedStyle(node).listStyleType)) === 'decimal',
  '有序列表在卡片预览中显示连续编号',
)
await bodyInput.fill('要加粗的文字')
await bodyInput.evaluate((node) => {
  node.setSelectionRange(0, 3)
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 160,
    clientY: 260,
  }))
})
const textFormatMenu = page.getByRole('menu', { name: '正文编辑菜单', exact: true })
check(await textFormatMenu.isVisible(), '正文选区右键可打开上下文菜单')
check(
  await page.evaluate(() => {
    const menu = document.querySelector('.text-context-menu')?.getBoundingClientRect()
    const input = document.querySelector('#bymark-text')?.getBoundingClientRect()
    return Boolean(menu && input && menu.left >= input.left && menu.top >= input.top)
  }),
  '上下文菜单从右键位置展开',
)
check(
  await textFormatMenu.getByRole('menuitem', { name: '复制', exact: false }).isVisible() &&
    await textFormatMenu.getByRole('menuitem', { name: '粘贴', exact: false }).isVisible() &&
    await textFormatMenu.getByRole('menuitem', { name: '无序列表', exact: true }).isVisible() &&
    await textFormatMenu.getByRole('menuitem', { name: '有序列表', exact: true }).isVisible(),
  '上下文菜单提供剪贴板与列表格式操作',
)
await textFormatMenu.getByRole('menuitem', { name: '复制', exact: false }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check((await page.evaluate(() => navigator.clipboard.readText())) === '要加粗', '上下文菜单可复制所选文字')
await bodyInput.evaluate((node) => {
  node.setSelectionRange(0, 3)
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 160,
    clientY: 260,
  }))
})
await textFormatMenu.getByRole('menuitem', { name: '加粗', exact: false }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地，避免与下一次 fill 竞态
check(
  (await bodyInput.inputValue()) === '**要加粗**的文字',
  '右键格式菜单会保留选区并应用加粗',
  await bodyInput.inputValue(),
)
await bodyInput.fill('待粘贴')
await page.evaluate(() => navigator.clipboard.writeText('插入'))
await bodyInput.evaluate((node) => {
  node.setSelectionRange(1, 1)
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 160,
    clientY: 260,
  }))
})
await textFormatMenu.getByRole('menuitem', { name: '粘贴', exact: false }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
await page.waitForFunction(() => document.querySelector('#bymark-text')?.value === '待插入粘贴', null, { timeout: 8000 })
check((await bodyInput.inputValue()) === '待插入粘贴', '上下文菜单可在光标位置粘贴文字')
await bodyInput.fill('选中文字也能格式化')
await bodyInput.evaluate((node) => {
  node.setSelectionRange(0, 4)
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 180, clientY: 260 }))
})
check(!(await textFormatMenu.isVisible()), '选择文字不会自动弹出工具条')
await bodyInput.evaluate((node) => {
  node.setSelectionRange(node.value.length, node.value.length)
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 190,
    clientY: 280,
  }))
})
check(await textFormatMenu.isVisible(), '正文空白位置右键同样可打开上下文菜单')
check(
  await textFormatMenu.getByRole('menuitem', { name: '剪切', exact: false }).isDisabled() &&
    await textFormatMenu.getByRole('menuitem', { name: '复制', exact: false }).isDisabled(),
  '空白位置右键时，依赖选区的操作会禁用',
)
await page.keyboard.press('Escape')
check(!(await textFormatMenu.isVisible()), '按 Escape 可关闭上下文菜单')
await bodyInput.fill('跨行的重点句，\n依然应该被完整强调。')
await bodyInput.evaluate((node) => node.setSelectionRange(0, node.value.length))
await page.getByRole('button', { name: '加粗' }).click()
await page.waitForTimeout(60) // 等待 rAF 选区恢复落地
check(
  (await bodyInput.inputValue()) === '**跨行的重点句，\n依然应该被完整强调。**',
  '跨行选区加粗保留一对完整 Markdown 标记',
  await bodyInput.inputValue(),
)
check(
  (await page.locator('.post-copy:not(.pagination-probe *) strong').textContent()) === '跨行的重点句，\n依然应该被完整强调。',
  '跨行加粗不会把 Markdown 标记输出到卡片',
  (await page.locator('.post-copy:not(.pagination-probe *)').textContent()) ?? '',
)
check((await page.locator('.post-copy:not(.pagination-probe *) strong').count()) === 1, '跨行加粗作为一个连续的强调片段渲染')
await bodyInput.fill('保留  两个空格\n\n以及一整行的空白。')
check(
  (await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).whiteSpace)) === 'break-spaces',
  '卡片预览逐个保留空格',
  await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).whiteSpace),
)
// fill 后分页测量会短暂冻结预览显示旧文本，需等空白行真正渲染再断言
await page.waitForFunction(() => document.querySelectorAll('.markdown-blank-line:not(.pagination-probe *)').length === 1, null, { timeout: 5000 })
check((await page.locator('.markdown-blank-line:not(.pagination-probe *)').count()) === 1, '卡片预览保留输入中的空白行')
await bodyInput.fill(`${Array.from({ length: 240 }, (_, index) => String(index + 1)).join(',')},`)
await page.waitForTimeout(80)
const continuousNumberLayout = await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const tokens = []
  let textNode
  while ((textNode = walker.nextNode())) {
    for (const match of textNode.data.matchAll(/\d{2,}/g)) {
      const range = document.createRange()
      range.setStart(textNode, match.index ?? 0)
      range.setEnd(textNode, (match.index ?? 0) + match[0].length)
      tokens.push({
        value: match[0],
        lineCount: new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size,
      })
    }
  }
  return {
    overflowWrap: getComputedStyle(node).overflowWrap,
    splitTokens: tokens.filter((token) => token.lineCount > 1).map((token) => token.value),
    tokenCount: tokens.length,
  }
})
check(
  continuousNumberLayout.overflowWrap === 'break-word' &&
    continuousNumberLayout.tokenCount > 20 &&
    continuousNumberLayout.splitTokens.length === 0,
  '连续逗号数字只会在逗号处换行，不会在数字中间断开',
  JSON.stringify(continuousNumberLayout),
)
await bodyInput.fill('# 标题\n\n**重点**和 _斜体_，还有 `代码`。\n> 引用内容\n- 第一项\n1. 第二项\n[链接文字](https://example.com)')
const quoteVisuals = await page.locator('.post-copy:not(.pagination-probe *) blockquote').evaluate((node) => {
  const style = getComputedStyle(node)
  return {
    background: style.backgroundColor,
    borderLeftColor: style.borderLeftColor,
    borderLeftWidth: style.borderLeftWidth,
    paddingLeft: style.paddingLeft,
  }
})
check(
  quoteVisuals.background !== 'rgba(0, 0, 0, 0)' &&
    quoteVisuals.borderLeftColor === 'rgb(123, 157, 53)' &&
    Number.parseFloat(quoteVisuals.borderLeftWidth) >= 3 &&
    Number.parseFloat(quoteVisuals.paddingLeft) >= 16,
  '引用使用橄榄色左侧标记与浅色底的注释块样式',
  JSON.stringify(quoteVisuals),
)
const copyBodyButton = page.getByRole('button', { name: '复制正文（不含 Markdown 格式）', exact: true })
await copyBodyButton.click()
await page.waitForFunction(() => document.querySelector('.copy-body-button')?.textContent?.includes('已复制'))
const copiedBody = await page.evaluate(() => navigator.clipboard.readText())
check(
  copiedBody === '标题\n\n重点和 斜体，还有 代码。\n引用内容\n第一项\n第二项\n链接文字',
  '复制正文会移除 Markdown 标记，只保留文字内容',
  copiedBody,
)
const copyButtonLayout = await page.locator('.copy-body-button').evaluate((node) => {
  const button = node.getBoundingClientRect()
  const fieldNode = document.querySelector('#bymark-text')
  const field = fieldNode?.getBoundingClientRect()
  return {
    isInsideField: Boolean(field && button.right <= field.right - 8 && button.bottom <= field.bottom - 8),
    hasSpaceForText: Boolean(fieldNode && Number.parseFloat(getComputedStyle(fieldNode).paddingBottom) >= button.height + 12),
  }
})
check(copyButtonLayout.isInsideField && copyButtonLayout.hasSpaceForText, '复制正文按钮固定在输入框右下角且不遮挡内容', JSON.stringify(copyButtonLayout))
await bodyInput.fill('短句也值得被认真留下。')
await page.waitForTimeout(240)
const compactEditorLayout = await page.evaluate(() => {
  const textArea = document.querySelector('#bymark-text')
  return {
    height: textArea?.clientHeight ?? 0,
    scrollHeight: textArea?.scrollHeight ?? 0,
    panelScrollHeight: document.querySelector('.editor-groups')?.scrollHeight ?? 0,
  }
})
const expandedText = Array.from(
  { length: 16 },
  (_, index) => `第 ${index + 1} 段短文字，用来验证正文输入框会完整展开。`,
).join('\n')
await bodyInput.fill(expandedText)
await page.waitForTimeout(40)
const immediateExpandedEditorLayout = await page.evaluate(() => {
  const textArea = document.querySelector('#bymark-text')
  return {
    height: textArea?.clientHeight ?? 0,
    scrollHeight: textArea?.scrollHeight ?? 0,
    targetHeight: Number.parseFloat(textArea?.style.height ?? '0'),
    transition: textArea ? getComputedStyle(textArea).transition : '',
  }
})
check(
  immediateExpandedEditorLayout.transition.includes('height') &&
    immediateExpandedEditorLayout.targetHeight >= immediateExpandedEditorLayout.scrollHeight &&
    immediateExpandedEditorLayout.height < immediateExpandedEditorLayout.targetHeight,
  '长文本输入后平滑扩展至完整目标高度',
  JSON.stringify({ compactEditorLayout, immediateExpandedEditorLayout }),
)
await page.waitForTimeout(260)
const expandedEditorLayout = await page.evaluate(() => {
  const textArea = document.querySelector('#bymark-text')
  const style = textArea ? getComputedStyle(textArea) : null
  return {
    height: textArea?.clientHeight ?? 0,
    scrollHeight: textArea?.scrollHeight ?? 0,
    panelScrollHeight: document.querySelector('.editor-groups')?.scrollHeight ?? 0,
    overflowY: style?.overflowY ?? '',
  }
})
check(
  expandedEditorLayout.height > compactEditorLayout.height,
  '正文输入框会随内容自动展开',
  JSON.stringify({ compactEditorLayout, expandedEditorLayout }),
)
check(
  expandedEditorLayout.scrollHeight <= expandedEditorLayout.height + 2,
  '展开后的正文不需要内部滚动',
  JSON.stringify(expandedEditorLayout),
)
check(
  expandedEditorLayout.panelScrollHeight >= compactEditorLayout.panelScrollHeight,
  '正文增长时内容面板会自然扩展',
  JSON.stringify({ compactEditorLayout, expandedEditorLayout }),
)
check(expandedEditorLayout.overflowY === 'hidden', '正文输入框隐藏内部滚动条', expandedEditorLayout.overflowY)

await bodyInput.fill(
  Array.from({ length: 28 }, (_, index) => `第 ${index + 1} 行用于验证输入框底部连续输入。`).join('\n'),
)
await page.waitForTimeout(80)
await bodyInput.evaluate((node) => {
  node.focus()
  node.setSelectionRange(node.value.length, node.value.length)
  const scroller = document.querySelector('.editor-groups')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
})
const bottomTypingSamples = []
for (const chunk of ['\n继续输入一', '\n继续输入二', '\n继续输入三', '\n继续输入四', '\n继续输入五']) {
  await page.keyboard.insertText(chunk)
  await page.waitForTimeout(24)
  bottomTypingSamples.push(await page.evaluate(() => {
    const input = document.querySelector('#bymark-text')
    const scroller = document.querySelector('.editor-groups')
    const box = input?.getBoundingClientRect()
    return {
      bottom: Math.round(box?.bottom ?? 0),
      panelScrollTop: Math.round(scroller?.scrollTop ?? 0),
      inputScrollTop: Math.round(input?.scrollTop ?? 0),
    }
  }))
}
const bottomPositions = bottomTypingSamples.map(({ bottom }) => bottom)
check(
  Math.max(...bottomPositions) - Math.min(...bottomPositions) <= 1 &&
    bottomTypingSamples.every(({ inputScrollTop }) => inputScrollTop === 0) &&
    bottomTypingSamples.every((sample, index) => index === 0 || sample.panelScrollTop >= bottomTypingSamples[index - 1].panelScrollTop),
  '在输入框底部连续输入时保持稳定，不发生上下跳动',
  JSON.stringify(bottomTypingSamples),
)
await bodyInput.fill('')
await page.waitForTimeout(40)
const shrinkingEditorLayout = await bodyInput.evaluate((node) => ({
  height: node.clientHeight,
  targetHeight: Number.parseFloat(node.style.height),
  transition: getComputedStyle(node).transition,
}))
check(
  shrinkingEditorLayout.transition.includes('height') &&
    shrinkingEditorLayout.height > shrinkingEditorLayout.targetHeight &&
    shrinkingEditorLayout.targetHeight <= compactEditorLayout.height + 2,
  '清空长正文后输入框平滑收起',
  JSON.stringify({ compactEditorLayout, shrinkingEditorLayout }),
)
await page.waitForTimeout(220)
const clearedEditorLayout = await bodyInput.evaluate((node) => ({
  height: node.clientHeight,
  scrollHeight: node.scrollHeight,
  inlineHeight: node.style.height,
}))
check(
  clearedEditorLayout.height <= compactEditorLayout.height + 2 &&
    clearedEditorLayout.scrollHeight <= clearedEditorLayout.height + 2,
  '清空长正文后输入框会恢复默认高度',
  JSON.stringify({ compactEditorLayout, clearedEditorLayout }),
)
await page.setViewportSize({ width: 1280, height: 1000 })
await page.waitForTimeout(100)
const resizedEditorLayout = await bodyInput.evaluate((node) => ({
  height: node.clientHeight,
  scrollHeight: node.scrollHeight,
}))
check(
  resizedEditorLayout.scrollHeight <= resizedEditorLayout.height + 2,
  '窗口宽度变化后正文仍完整显示',
  JSON.stringify(resizedEditorLayout),
)
await page.setViewportSize({ width: 1440, height: 1000 })
await page.waitForTimeout(100)

await page.getByRole('tab', { name: '导出' }).click()
await page.getByLabel('昵称').fill('留印测试者')
await page.getByLabel('账号 ID').fill('@bymark_test')
await page.getByRole('tab', { name: '内容' }).click()
await bodyInput.fill('第一段中文与 English ✨\n\n第二段保留手动换行。')
await page.waitForFunction(() => document.querySelector('.post-copy:not(.pagination-probe *)')?.textContent?.includes('English ✨'), null, { timeout: 5000 })
check((await page.locator('.post-name:not(.pagination-probe *)').textContent()) === '留印测试者', '昵称实时同步且不附加 @ 前缀')
check((await page.locator('.post-id:not(.pagination-probe *)').textContent()) === '@bymark_test', 'ID 实时同步')
check((await page.locator('.post-copy:not(.pagination-probe *)').textContent())?.includes('English ✨'), '中英文与 emoji 实时同步')
check(
  (await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).whiteSpace)) === 'break-spaces',
  '手动换行与空格按原文保留',
)

await titleInput.fill('')
const firstDraftText = '草稿甲｜把一个片段保留下来。\n\n回头时，仍然知道自己想说什么。'
const secondDraftText = '草稿乙｜稍后再写。'
await bodyInput.fill(firstDraftText)
await page.waitForFunction(() => document.querySelectorAll('.draft-row').length === 1, null, { timeout: 3000 })
await page.getByRole('button', { name: '新建草稿', exact: true }).click()
await page.waitForFunction(() => document.querySelector('#bymark-text')?.value === '')
check((await bodyInput.inputValue()) === '', '新建草稿会清空当前编辑区')
check((await page.locator('.draft-row').count()) === 1, '新建前会保留已有草稿')
await bodyInput.fill(secondDraftText)
await page.getByRole('button', { name: '使用草稿：草稿乙｜稍后再写。', exact: true }).waitFor({ state: 'visible' })
check((await page.locator('.draft-row').count()) === 2, '可保存多条本地草稿')
await page.getByRole('button', { name: '使用草稿：草稿甲｜把一个片段保留下来。', exact: true }).click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, firstDraftText)
check((await bodyInput.inputValue()) === firstDraftText, '可一键把草稿放回当前卡片')
await page.getByRole('button', { name: '使用草稿：草稿乙｜稍后再写。', exact: true }).locator('time').click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, secondDraftText)
check((await bodyInput.inputValue()) === secondDraftText, '点击草稿卡片的编辑时间也能切换草稿')
await page.getByRole('button', { name: '使用草稿：草稿甲｜把一个片段保留下来。', exact: true }).click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, firstDraftText)
await page.getByRole('button', { name: '重命名草稿：草稿甲｜把一个片段保留下来。', exact: true }).click()
await page.locator('.draft-title-input').fill('重新命名的片段')
await page.locator('.draft-title-input').press('Enter')
await page.getByText('重新命名的片段', { exact: true }).waitFor({ state: 'visible' })
check(await page.getByText('重新命名的片段', { exact: true }).isVisible(), '草稿可单独重命名')
check((await titleInput.inputValue()) === '重新命名的片段', '草稿库重命名会同步作品标题输入框')
await bodyInput.fill('自动暂存的未完成片段。')
await page.getByRole('button', { name: '使用草稿：草稿乙｜稍后再写。', exact: true }).click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, secondDraftText)
check((await bodyInput.inputValue()) === secondDraftText, '切换草稿后正文完整替换')
check((await page.locator('.draft-row').count()) === 2, '切换草稿前会把未保存修改写回当前完整草稿')
await page.getByRole('button', { name: '使用草稿：重新命名的片段', exact: true }).click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, '自动暂存的未完成片段。')
await bodyInput.fill('草稿甲的新修改')
await page.getByRole('button', { name: '使用草稿：草稿乙｜稍后再写。', exact: true }).click()
await page.waitForFunction((text) => document.querySelector('#bymark-text')?.value === text, secondDraftText)
await bodyInput.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
check((await bodyInput.inputValue()) === secondDraftText, '切换草稿后撤销不会污染另一份草稿')
await page.reload({ waitUntil: 'networkidle' })
await page.getByText('重新命名的片段', { exact: true }).waitFor({ state: 'visible' })
check(await page.getByText('重新命名的片段', { exact: true }).isVisible(), '刷新后仍可读取本地草稿')
await page.getByRole('button', { name: '删除草稿：草稿乙｜稍后再写。', exact: true }).click()
await page.waitForFunction(() => document.querySelectorAll('.draft-row').length === 1)
check(await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).isVisible(), '删除草稿后提供撤销入口')
await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click()
await page.waitForFunction(() => document.querySelectorAll('.draft-row').length === 2)
check((await page.locator('.draft-row').count()) === 2, '撤销可恢复被删除草稿')

await page.getByRole('button', { name: '下一期', exact: true }).click()
await page.waitForFunction(() => document.querySelectorAll('.draft-row').length === 3)
check((await page.locator('.draft-row').count()) === 3, '下一期会创建独立草稿并保留上一期')
check(await page.getByRole('button', { name: '使用草稿：未命名草稿', exact: true }).isVisible(), '下一期创建空白作品标题')
await page.getByRole('tab', { name: '内容' }).click()
check((await titleInput.inputValue()) === '', '下一期清空作品标题')
check((await bodyInput.inputValue()) === '', '下一期清空正文内容')
await page.locator('.draft-row-active .draft-delete-button').click()
await page.waitForFunction(() => document.querySelectorAll('.draft-row').length === 2)
await page.locator('.draft-open-button').first().click()

const draftLibraryLayout = await page.locator('.draft-library').evaluate((node) => {
  const editor = document.querySelector('.editor-panel')
  const box = node.getBoundingClientRect()
  const editorBox = editor?.getBoundingClientRect()
  return {
    top: Math.round(box.top),
    width: Math.round(box.width),
    startsAfterEditor: Boolean(editorBox && box.left >= editorBox.right),
  }
})
check(
  draftLibraryLayout.top === 0 && draftLibraryLayout.width >= 280 && draftLibraryLayout.startsAfterEditor,
  '草稿库固定在预览右侧，不再占用编辑区底部',
  JSON.stringify(draftLibraryLayout),
)
check((await page.locator('.draft-library select').count()) === 0, '草稿库不提供难理解的分类状态')
check((await page.locator('.draft-filters').count()) === 0, '草稿库不提供额外筛选')
await page.getByRole('button', { name: '收起草稿', exact: true }).click()
await page.waitForTimeout(240)
check((await page.locator('.draft-library').evaluate((node) => Math.round(node.getBoundingClientRect().width))) <= 60, '草稿库可收起为右侧窄栏')
await page.getByRole('button', { name: '展开草稿', exact: true }).click()
await page.waitForTimeout(240)
check((await page.locator('.draft-row').count()) === 2, '展开后直接显示全部草稿')

await page.getByRole('tab', { name: '导出' }).click()
await page.waitForTimeout(32)
const advancedRevealMotion = await page.locator('#editor-tab-publish').evaluate((node) => ({
  display: getComputedStyle(node).display,
  tab: node.getAttribute('role'),
}))
check(
  advancedRevealMotion.display !== 'none' && advancedRevealMotion.tab === 'tabpanel',
  '发布信息通过独立标签进入，不与正文设置混排',
  JSON.stringify(advancedRevealMotion),
)

// 时间控件为滚轮选择器：打开面板后点击目标小时与分钟
await page.locator('#bymark-time').click()
await page.getByRole('option', { name: '15 时' }).click()
await page.getByRole('option', { name: '16 分' }).click()
await page.getByRole('button', { name: '完成' }).click()
// 日期控件为日历选择器：翻月到目标日期后点击
await page.locator('#bymark-date').click()
const qaTargetDay = page.locator('[data-date="2026-12-09"]')
for (let i = 0; i < 12 && !(await qaTargetDay.isVisible().catch(() => false)); i += 1) {
  await page.getByRole('button', { name: '下个月' }).click()
  await page.waitForTimeout(60)
}
await qaTargetDay.click()
await page.locator('#bymark-location').fill('上海')
check((await page.locator('.post-meta:not(.pagination-probe *)').textContent()) === '15:16 · Dec 9, 2026 · 上海', '时间日期地点格式正确')
await page.getByRole('switch', { name: '地点' }).click()
check((await page.locator('.post-meta:not(.pagination-probe *)').textContent()) === '15:16 · Dec 9, 2026', '关闭地点后分隔符自动重组')
await page.getByRole('switch', { name: '地点' }).click()
check((await page.locator('.post-meta:not(.pagination-probe *)').textContent()) === '15:16 · Dec 9, 2026 · 上海', '地点开关可恢复')
await page.getByRole('switch', { name: '时间' }).click()
check((await page.locator('.post-meta:not(.pagination-probe *)').textContent()) === 'Dec 9, 2026 · 上海', '关闭时间后无多余分隔符')
await page.getByRole('switch', { name: '日期' }).click()
check((await page.locator('.post-meta:not(.pagination-probe *)').textContent()) === '上海', '仅显示地点时无分隔符')
await page.getByRole('switch', { name: '地点' }).click()
check((await page.locator('.post-meta:not(.pagination-probe *)').count()) === 0, '元信息可全部关闭且不留空白内容')
await page.getByRole('switch', { name: '时间' }).click()
await page.getByRole('switch', { name: '日期' }).click()
await page.getByRole('switch', { name: '地点' }).click()

const expectedCurrent = await page.evaluate(() => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  }
})
await page.getByRole('button', { name: '使用当前时间' }).click()
check((await page.locator('#bymark-time .time-picker-value').innerText()) === expectedCurrent.time, '自动获取设备当前时间')
check((await page.locator('#bymark-date span').innerText()) === expectedCurrent.date.replaceAll('-', '/'), '自动获取设备当前日期')
// 时间控件为滚轮选择器：打开面板后点击目标小时与分钟
await page.locator('#bymark-time').click()
await page.getByRole('option', { name: '15 时' }).click()
await page.getByRole('option', { name: '16 分' }).click()
await page.getByRole('button', { name: '完成' }).click()
// 日期控件为日历选择器：翻月到目标日期后点击
await page.locator('#bymark-date').click()
{
  const qaTargetDay = page.locator('[data-date="2026-12-09"]')
  for (let i = 0; i < 12 && !(await qaTargetDay.isVisible().catch(() => false)); i += 1) {
    await page.getByRole('button', { name: '下个月' }).click()
    await page.waitForTimeout(60)
  }
  await qaTargetDay.click()
}
check((await page.getByText('发布细节', { exact: true }).count()) === 0, '已移除发布细节设置')
check((await page.getByRole('switch', { name: '显示系列编号' }).count()) === 0, '已移除系列编号功能')
check((await page.getByRole('switch', { name: '显示互动区域' }).count()) === 0, '已移除互动区域功能')

await page.getByRole('tab', { name: '版式' }).click()
if (!(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-light')))) {
  await cycleThemeTo('light')
}
check(
  await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-light')),
  '浅色主题生效',
)
// 主题切换带 180ms 背景过渡，等过渡落定再取色，避免拿到中间帧
await page.waitForFunction(() => getComputedStyle(document.querySelector('.app-shell')).backgroundColor === 'rgb(247, 241, 231)', null, { timeout: 5000 })
const lightVisuals = await page.evaluate(() => {
  const style = (selector) => getComputedStyle(document.querySelector(selector))
  return {
    rootBackground: getComputedStyle(document.documentElement).backgroundColor,
    appBackground: style('.app-shell').backgroundColor,
    panelBackground: style('.editor-panel').backgroundColor,
    cardBackground: style('[data-testid="export-card"]').backgroundColor,
    signatureColor: style('.post-signature').color,
  }
})
check(lightVisuals.appBackground === 'rgb(247, 241, 231)', '浅色工作台使用暖米白底色', lightVisuals.appBackground)
check(lightVisuals.rootBackground === 'rgb(233, 223, 208)', '浅色主题圆角外侧不再露出黑色根背景', JSON.stringify(lightVisuals))
check(lightVisuals.panelBackground === 'rgb(247, 241, 231)', '浅色编辑面板为暖米白', lightVisuals.panelBackground)
check(lightVisuals.cardBackground === 'rgb(247, 241, 231)', '浅色导出卡片为暖米白', lightVisuals.cardBackground)
const lightThemeButton = page.locator('.brand-lockup .quick-theme')
await page.mouse.move(800, 800)
await page.waitForTimeout(220)
check(
  (await lightThemeButton.evaluate((node) => getComputedStyle(node).boxShadow)) === 'none',
  '浅色模式主题按钮默认无阴影',
)
await lightThemeButton.hover()
await page.waitForTimeout(220)
check(
  (await lightThemeButton.evaluate((node) => getComputedStyle(node).boxShadow)) !== 'none',
  '浅色模式主题按钮悬停后渐显阴影',
)
check(
  lightVisuals.signatureColor === 'rgba(0, 0, 0, 0.34)',
  '浅色模式签名使用低对比度深灰',
  lightVisuals.signatureColor,
)
await page.screenshot({ path: path.join(artifacts, 'desktop-light.png') })
await cycleThemeTo('dark')

for (const preset of [
  { ratio: '3:4', name: '默认文字思考', height: 1067 },
  { ratio: '9:16', name: '全屏发布', height: 1422 },
  { ratio: '2:3', name: '抖音图文推荐', height: 1200 },
]) {
  if (preset.ratio === '3:4') {
    await page.getByRole('button', { name: '3:4 · 默认文字思考', exact: true }).click()
  } else {
  await page.getByRole('button', { name: `${preset.ratio} · ${preset.name}`, exact: true }).click()
  }
  await page.waitForTimeout(80)
  const dimensions = await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
  }))
  check(dimensions.width === 800 && dimensions.height === preset.height, `${preset.ratio} 画布尺寸正确`)
  if (preset.ratio === '9:16') {
    check((await page.locator('.safe-area-guide').count()) === 0, '9:16 预览不显示发布安全区')
    await page.screenshot({ path: path.join(artifacts, 'desktop-9-16.png') })
    const verticalDownloadPromise = page.waitForEvent('download')
    await page.locator('.export-button').click()
    const verticalDownload = await verticalDownloadPromise
    await verticalDownload.saveAs(path.join(artifacts, 'export-9-16.png'))
    check((await verticalDownload.failure()) === null, '9:16 PNG 下载成功')
    await page.waitForTimeout(120)
  }
}

await page.getByRole('button', { name: '3:4 · 默认文字思考', exact: true }).click()
const fixture = path.join(artifacts, 'desktop-initial.png')
await page.getByLabel('选择内容配图').setInputFiles(fixture)
await page.getByRole('tab', { name: '导出' }).click()
await page.getByLabel('选择头像图片').setInputFiles(fixture)
await page.locator('.post-avatar img:not(.pagination-probe *)').waitFor({ state: 'visible' })
await page.locator('.post-image-wrap img:not(.pagination-probe *)').waitFor({ state: 'visible' })
check((await page.locator('.post-avatar img:not(.pagination-probe *)').count()) === 1, '头像上传后立即预览')
check((await page.locator('.post-image-wrap img:not(.pagination-probe *)').count()) === 1, '正文配图上传后立即预览')
const avatarRendering = await page.evaluate(() => {
  const upload = document.querySelector('.upload-preview.avatar-preview img')
  const preview = document.querySelector('.post-avatar img:not(.pagination-probe *)')
  const uploadStyle = upload ? getComputedStyle(upload) : null
  const previewStyle = preview ? getComputedStyle(preview) : null
  return {
    uploadFit: uploadStyle?.objectFit,
    uploadTransform: uploadStyle?.transform,
    previewFit: previewStyle?.objectFit,
    previewTransform: previewStyle?.transform,
  }
})
check(
  avatarRendering.uploadFit === 'cover' &&
    avatarRendering.previewFit === 'cover' &&
    avatarRendering.uploadTransform === 'none' &&
    avatarRendering.previewTransform === 'none',
  '上传头像与卡片头像使用一致的裁切和缩放规则',
  JSON.stringify(avatarRendering),
)
const imageRadii = await page.evaluate(() => ({
  wrapper: getComputedStyle(document.querySelector('.post-image-wrap')).borderRadius,
  image: getComputedStyle(document.querySelector('.post-image-wrap img')).borderRadius,
  wrapperBorderWidth: getComputedStyle(document.querySelector('.post-image-wrap')).borderTopWidth,
  wrapperShadow: getComputedStyle(document.querySelector('.post-image-wrap')).boxShadow,
}))
check(
  imageRadii.wrapper === '6px' && imageRadii.image === '6px',
  '正文配图使用更小的圆角',
  JSON.stringify(imageRadii),
)
check(
  imageRadii.wrapperBorderWidth === '0px' &&
    imageRadii.wrapperShadow === 'rgba(99, 99, 99, 0.2) 0px 2px 8px 0px',
  '正文配图移除边框并使用指定阴影',
  JSON.stringify(imageRadii),
)
check(
  (await page.locator('.post-image-wrap img:not(.pagination-probe *)').evaluate((image) => getComputedStyle(image).objectFit)) === 'contain',
  '正文配图完整展示而不裁切',
)
await page.getByRole('tab', { name: '版式' }).click()
await page.getByRole('button', { name: /^图片布局/ }).click()
check(
  await page.getByRole('group', { name: '配图位置' }).isVisible() &&
    (await page.getByRole('button', { name: '文字下方', exact: true }).getAttribute('aria-pressed')) === 'true',
  '配图位置默认在文字下方',
)
check(
  await page.getByRole('group', { name: '图片对齐' }).isVisible() &&
    (await page.getByRole('button', { name: '左对齐', exact: true }).getAttribute('aria-pressed')) === 'true',
  '图片默认与头像左侧对齐',
)
check(
  await page.locator('.post-image-wrap:not(.pagination-probe *)').evaluate((image) => {
    const avatar = document.querySelector('.post-avatar')
    if (!avatar) return false
    return Math.abs(image.getBoundingClientRect().left - avatar.getBoundingClientRect().left) <= 1
  }),
  '插入配图后，默认尺寸与头像左侧对齐',
)
await page.locator('#bymark-image-scale').fill('100')
await page.getByRole('button', { name: '图片放大 10%' }).click()
check((await page.locator('#bymark-image-scale').inputValue()) === '110', '配图缩放支持快捷放大 10%')
await page.getByRole('button', { name: '图片缩小 10%' }).click()
check((await page.locator('#bymark-image-scale').inputValue()) === '100', '配图缩放支持快捷缩小 10%')
const imageScaleLayout = await page.locator('.image-scale-control').evaluate((control) => {
  const controlRect = control.getBoundingClientRect()
  const rangeRect = control.querySelector('input')?.getBoundingClientRect()
  return { controlWidth: controlRect.width, controlHeight: controlRect.height, rangeWidth: rangeRect?.width ?? 0 }
})
check(
  imageScaleLayout.controlHeight <= 40 && imageScaleLayout.rangeWidth > imageScaleLayout.controlWidth * 0.6,
  '配图缩放保持紧凑且滑杆占据主要宽度',
  JSON.stringify(imageScaleLayout),
)
const imageFrameAt100 = await page.locator('.post-image-wrap:not(.pagination-probe *)').evaluate((frame) => {
  const { width, height } = frame.getBoundingClientRect()
  return { width, height }
})
const imageScaleComparisonValue = Math.min(120, Number(await page.locator('#bymark-image-scale').getAttribute('max')))
await page.locator('#bymark-image-scale').fill(String(imageScaleComparisonValue))
const enlargedImageFrame = await page.locator('.post-image-wrap:not(.pagination-probe *)').evaluate((frame) => {
  const { width, height } = frame.getBoundingClientRect()
  const image = frame.querySelector('img')?.getBoundingClientRect()
  return { width, height, imageWidth: image?.width, imageHeight: image?.height }
})
check(
  imageScaleComparisonValue > 100 &&
    enlargedImageFrame.width > imageFrameAt100.width &&
    enlargedImageFrame.height > imageFrameAt100.height &&
    enlargedImageFrame.width === enlargedImageFrame.imageWidth &&
    enlargedImageFrame.height === enlargedImageFrame.imageHeight,
  '配图缩放会连同适配原图比例的图片卡片一起调整',
  JSON.stringify({ imageScaleComparisonValue, imageFrameAt100, enlargedImageFrame }),
)
const defaultImageScaleMax = Number(await page.locator('#bymark-image-scale').getAttribute('max'))
await page.locator('#bymark-image-scale').fill(String(defaultImageScaleMax))
const imageMaximumBoundary = await page.evaluate(() => {
  const image = document.querySelector('.post-image-wrap')?.getBoundingClientRect()
  const avatar = document.querySelector('.post-avatar')?.getBoundingClientRect()
  return { imageLeft: image?.left, avatarLeft: avatar?.left }
})
check(
  (imageMaximumBoundary.imageLeft ?? 0) >= (imageMaximumBoundary.avatarLeft ?? 0) - 1,
  '配图缩放到最大时不会越过头像与正文的左边界',
  JSON.stringify(imageMaximumBoundary),
)
await page.getByRole('button', { name: '2:3 · 抖音图文推荐', exact: true }).click()
await page.waitForFunction(() => Number(document.querySelector('#bymark-image-scale')?.max) < 160)
const safeImageScaleMax = Number(await page.locator('#bymark-image-scale').getAttribute('max'))
await page.locator('#bymark-image-scale').fill(String(safeImageScaleMax))
const imageMaximumGeometry = await page.locator('.post-image-wrap:not(.pagination-probe *)').evaluate((frame) => {
  const image = frame.querySelector('img')
  const { width, height } = frame.getBoundingClientRect()
  const imageAspectRatio = image.naturalWidth / image.naturalHeight
  return { height, renderedImageHeight: Math.min(height, width / imageAspectRatio) }
})
check(
  safeImageScaleMax <= defaultImageScaleMax && imageMaximumGeometry.height <= imageMaximumGeometry.renderedImageHeight + 1,
  '配图缩放上限会根据画幅与原图比例收紧，图片卡片不高于实际图片',
  JSON.stringify({ safeImageScaleMax, defaultImageScaleMax, imageMaximumGeometry }),
)
await page.getByRole('button', { name: '3:4 · 默认文字思考', exact: true }).click()
const restoredImageScaleMax = Number(await page.locator('#bymark-image-scale').getAttribute('max'))
await page.locator('#bymark-image-scale').fill(String(restoredImageScaleMax))
await page.getByRole('button', { name: '左对齐', exact: true }).click()
const imageLeftAlignment = await page.evaluate(() => {
  const image = document.querySelector('.post-image-wrap')?.getBoundingClientRect()
  const avatar = document.querySelector('.post-avatar')?.getBoundingClientRect()
  return { imageLeft: image?.left, avatarLeft: avatar?.left }
})
check(
  Math.abs((imageLeftAlignment.imageLeft ?? 0) - (imageLeftAlignment.avatarLeft ?? 0)) <= 1,
  '左对齐时图片左边缘与头像垂直对齐',
  JSON.stringify(imageLeftAlignment),
)
await page.getByRole('button', { name: '文字上方', exact: true }).click()
// 分页重测量期间预览可能短暂冻结，等待结构真正切换
await page.waitForFunction(() => {
  const content = document.querySelector('.post-content:not(.pagination-probe *)')
  return content ? Array.from(content.children).map((node) => node.className).join(',') === 'post-image-wrap post-image-above post-image-align-left,post-copy' : false
}, null, { timeout: 5000 })
check(
  (await page.locator('.post-content:not(.pagination-probe *)').evaluate((content) =>
    Array.from(content.children).map((node) => node.className),
  )).join(',') === 'post-image-wrap post-image-above post-image-align-left,post-copy',
  '配图可切换至文字上方',
)
await page.screenshot({ path: path.join(artifacts, 'desktop-with-image.png') })
await page.getByRole('button', { name: '删除配图' }).click()
check((await page.locator('.post-image-wrap:not(.pagination-probe *)').count()) === 0, '正文配图删除后区域完全消失')
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '导出' }).click()
await page.locator('.post-avatar img:not(.pagination-probe *)').waitFor({ state: 'visible' })
check((await page.locator('.post-avatar img:not(.pagination-probe *)').count()) === 1, '刷新后恢复本地记忆头像')
await page.getByRole('button', { name: '恢复默认头像' }).click()
check(
  (await page.locator('.post-avatar img:not(.pagination-probe *)').getAttribute('src')) === '/default-avatar.png',
  '头像删除后恢复项目内置头像',
)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(80)
check(
  (await page.locator('.post-avatar img:not(.pagination-probe *)').getAttribute('src')) === '/default-avatar.png',
  '恢复默认头像后刷新保持项目内置头像',
)
check(await page.evaluate(() => localStorage.getItem('bymark-avatar-v1') === null), '删除头像后清理本地记忆')

await bodyInput.fill('留印'.repeat(140))
await page.waitForTimeout(120)
check(!(await page.locator('.export-button').isDisabled()), '默认字号下 280 字正文可完整导出')

await bodyInput.fill('过长正文'.repeat(500))
await page.waitForTimeout(100)
// 分页测量为异步流程：等待桌面轨道渲染出多页后再计数（移动端轨道是独立副本，需排除）
await page.waitForFunction(() => document.querySelectorAll('.page-director-desktop .preview-page-track button').length > 1, null, { timeout: 15000 })
const automaticPageCount = await page.locator('.page-director-desktop .preview-page-track button').count()
check(automaticPageCount > 1, '长正文会自动拆分为连续多页', String(automaticPageCount))
check(await page.getByRole('region', { name: '连续图文导演台' }).isVisible(), '多页内容显示连续图文导演台')
check(!(await page.locator('.export-button').isDisabled()), '长正文分页后仍可完整导出')
const firstPageFontSize = await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).fontSize)
await page.getByRole('tab', { name: new RegExp(`查看第 ${automaticPageCount} 页`) }).click()
const lastPageFontSize = await page.locator('.post-copy:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).fontSize)
check(
  firstPageFontSize === lastPageFontSize,
  '分页正文始终使用文字大小设置，不再按单页字数自动缩放',
  `${firstPageFontSize} / ${lastPageFontSize}`,
)
await page.getByRole('tab', { name: /查看第 1 页/ }).click()
// 翻页走 Transition out-in 动画，旧卡离场后新卡才入场，页码随之更新
await page.waitForFunction(() => document.querySelector('.post-page-number:not(.pagination-probe *)')?.textContent?.startsWith('01 /'), null, { timeout: 5000 })
check(
  (await page.locator('.post-page-number:not(.pagination-probe *)').textContent()) === `01 / ${String(automaticPageCount).padStart(2, '0')}`,
  '多页卡片显示稳定页码',
  (await page.locator('.post-page-number:not(.pagination-probe *)').textContent()) ?? '',
)
await page.getByRole('button', { name: '下一页', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.post-page-number:not(.pagination-probe *)')?.textContent?.startsWith('02 /'), null, { timeout: 5000 })
check((await page.locator('.post-page-number:not(.pagination-probe *)').textContent())?.startsWith('02 /'), '页面轨道可切换预览页')
await page.getByRole('tab', { name: '第 1 页' }).click()
await page.screenshot({ path: path.join(artifacts, 'desktop-pagination.png') })
const numericSequence = `${Array.from({ length: 530 }, (_, index) => String(index + 1)).join(',')},`
await bodyInput.fill(numericSequence)
await page.waitForTimeout(180)
await page.waitForTimeout(900)
const footerFit = await page.evaluate(() => {
  const copy = document.querySelector('.post-copy')?.getBoundingClientRect()
  const footerContent = document.querySelector('.post-meta')?.getBoundingClientRect()
  return {
    pageCount: document.querySelectorAll('.page-director-desktop .preview-page-track button').length,
    gap: copy && footerContent ? footerContent.top - copy.bottom : null,
  }
})
check(
  footerFit.pageCount === 2 && footerFit.gap !== null && footerFit.gap >= 12 && footerFit.gap <= 28,
  '自动分页会将连续正文排至距页脚模块约 20px 再换页',
  JSON.stringify(footerFit),
)
const numericFirstPage = await page.locator('.post-copy:not(.pagination-probe *)').textContent()
check(
  numericFirstPage.endsWith('461,'),
  '连续数字分页以真实卡片高度为准，不会在 461 后提前留出整行空白',
  numericFirstPage.slice(-32),
)
await page.getByRole('tab', { name: '查看第 2 页', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.post-page-number:not(.pagination-probe *)')?.textContent?.startsWith('02 /'), null, { timeout: 5000 })
await page.waitForTimeout(120)
const numericSecondPage = await page.locator('.post-copy:not(.pagination-probe *)').textContent()
check(
  `${numericFirstPage}${numericSecondPage}` === numericSequence &&
    numericFirstPage.endsWith(',') &&
    numericSecondPage.length > 0,
  '切换第 2 页会续接显示剩余正文，不重复或遗漏分页内容',
  JSON.stringify({ firstEnd: numericFirstPage.slice(-24), secondStart: numericSecondPage.slice(0, 24) }),
)
const editorScrollLayout = await page.evaluate(() => {
  const panel = document.querySelector('.editor-panel')
  const groups = document.querySelector('.editor-groups')
  const exportArea = document.querySelector('.export-dock')
  groups?.scrollTo({ top: groups.scrollHeight })
  const groupsBox = groups?.getBoundingClientRect()
  const exportBox = exportArea?.getBoundingClientRect()
  return {
    panelOverflowY: panel ? getComputedStyle(panel).overflowY : '',
    groupsOverflowY: groups ? getComputedStyle(groups).overflowY : '',
    exportPosition: exportArea ? getComputedStyle(exportArea).position : '',
    groupsBottom: groupsBox?.bottom ?? 0,
    exportTop: exportBox?.top ?? 0,
  }
})
check(
  editorScrollLayout.panelOverflowY === 'hidden' &&
    editorScrollLayout.groupsOverflowY === 'auto' &&
    editorScrollLayout.exportPosition === 'relative',
  '长正文时仅设置区滚动，导出栏不再覆盖表单',
  JSON.stringify(editorScrollLayout),
)
check(
  editorScrollLayout.groupsBottom <= editorScrollLayout.exportTop,
  '滚动内容的可见边界始终止于导出栏上方',
  JSON.stringify(editorScrollLayout),
)
check(
  await page.locator('.post-signature:not(.pagination-probe *)').evaluate((node) => {
    const style = getComputedStyle(node)
    const footer = node.closest('.post-footer')?.getBoundingClientRect()
    const signature = node.getBoundingClientRect()
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Boolean(footer) &&
      signature.bottom <= (footer?.bottom ?? 0) + 1
  }),
  '正文过长时签名仍保持在卡片底部且可见',
)
await bodyInput.fill('短句也值得被认真留下。\n\nBymark, Aug 2026. ✦')
await page.waitForTimeout(100)
check(!(await page.locator('.export-button').isDisabled()), '正文恢复合理长度后可导出')

await page.locator('.export-settings-button').click()
await page.getByRole('button', { name: '1K', exact: true }).click()
await page.locator('.export-settings-button').click()
await page.locator('.archive-button').click()
await page.getByRole('dialog', { name: /已归档/ }).waitFor({ state: 'visible' })
check((await page.locator('.archive-dialog-item').count()) === 1, '归档在编辑器内以弹窗列表展示')
check((await page.getByRole('button', { name: '查看', exact: true }).count()) === 1, '单篇归档提供查看入口')
check(await page.locator('.archive-dialog-item-actions').evaluate((actions) => {
  const labels = Array.from(actions.querySelectorAll('button')).map((button) => button.textContent?.trim())
  return labels.join('|') === '删除|查看'
}), '单篇归档的删除按钮位于查看按钮左侧')
const archiveDownloadPromise = page.waitForEvent('download')
await page.getByRole('button', { name: '导出全部为MD', exact: true }).click()
const archiveDownload = await archiveDownloadPromise
const archivePath = path.join(artifacts, archiveDownload.suggestedFilename())
await archiveDownload.saveAs(archivePath)
const archiveCollection = await readFile(archivePath, 'utf8')
check(archiveDownload.suggestedFilename().endsWith('.md') && archiveCollection.includes('短句也值得被认真留下。'), '可一键导出全部归档 Markdown')
await page.getByRole('button', { name: '查看', exact: true }).click()
check(await page.locator('.archive-dialog-reading-body').getByText('短句也值得被认真留下。', { exact: false }).isVisible(), '单篇归档可在弹窗内完整查看')
await page.getByRole('button', { name: '返回已归档', exact: true }).click()
await page.getByRole('button', { name: /删除归档：/ }).click()
await page.locator('.archive-dialog-item').waitFor({ state: 'detached' })
check((await page.locator('.archive-dialog-item').count()) === 0, '可从归档列表删除单篇归档')
await page.getByRole('button', { name: '关闭归档', exact: true }).last().click()
await page.waitForFunction(() => document.querySelector('.archive-dialog')?.classList.contains('archive-dialog-leave-to'))
// 轮询等过渡真正产生视觉变化，避免在动画首帧（opacity 仍为 1）取样
await page.waitForFunction(() => {
  const panel = document.querySelector('.archive-dialog .archive-dialog-panel')
  return panel !== null && Number.parseFloat(getComputedStyle(panel).opacity) < 1
}, null, { timeout: 5000 })
const closingArchiveVisuals = await page.locator('.archive-dialog').evaluate((dialog) => {
  const panel = dialog.querySelector('.archive-dialog-panel')
  const backdrop = dialog.querySelector('.archive-dialog-backdrop')
  return {
    className: dialog.className,
    panelOpacity: panel ? Number.parseFloat(getComputedStyle(panel).opacity) : 1,
    panelTransform: panel ? getComputedStyle(panel).transform : 'none',
    backdropOpacity: backdrop ? Number.parseFloat(getComputedStyle(backdrop).opacity) : 1,
  }
})
check(
  closingArchiveVisuals.className.includes('archive-dialog-leave-active') &&
    closingArchiveVisuals.panelOpacity < 1 &&
    closingArchiveVisuals.panelTransform !== 'none' &&
    closingArchiveVisuals.backdropOpacity < 1,
  '关闭归档时遮罩与面板播放消失动画',
  JSON.stringify(closingArchiveVisuals),
)
await page.locator('.archive-dialog').waitFor({ state: 'detached' })
await page.locator('.app-shell').waitFor({ state: 'visible' })
await bodyInput.fill('短句也值得被认真留下。\n\nBymark, Aug 2026. ✦')
await page.getByRole('tab', { name: '版式' }).click()
const readCardContentLayout = () => page.locator('.post-card-inner').first().evaluate((inner) => {
  const author = inner.querySelector('.post-author')
  const avatar = inner.querySelector('.post-avatar')
  const name = inner.querySelector('.post-name')
  const id = inner.querySelector('.post-id')
  const content = inner.querySelector('.post-content')
  const copy = inner.querySelector('.post-copy')
  const footer = inner.querySelector('.post-footer')
  const styleFor = (node) => node ? getComputedStyle(node) : null
  const innerStyle = getComputedStyle(inner)
  const authorStyle = styleFor(author)
  const avatarStyle = styleFor(avatar)
  const nameStyle = styleFor(name)
  const idStyle = styleFor(id)
  const contentStyle = styleFor(content)
  const copyStyle = styleFor(copy)
  const footerStyle = styleFor(footer)
  return {
    padding: [innerStyle.paddingTop, innerStyle.paddingRight, innerStyle.paddingBottom, innerStyle.paddingLeft],
    authorGap: authorStyle?.gap,
    avatar: [avatarStyle?.width, avatarStyle?.height, avatarStyle?.fontSize],
    nameFontSize: nameStyle?.fontSize,
    idFontSize: idStyle?.fontSize,
    contentMarginTop: contentStyle?.marginTop,
    copy: [copyStyle?.fontFamily, copyStyle?.fontSize, copyStyle?.lineHeight, copyStyle?.fontWeight, copyStyle?.letterSpacing],
    footerPaddingTop: footerStyle?.paddingTop,
  }
})
const plainCardContentLayout = await readCardContentLayout()
await page.getByRole('button', { name: '悬浮', exact: true }).click()
await page.locator('.post-card-scene .post-card-inner').first().waitFor({ state: 'visible' })
const sceneCardContentLayout = await readCardContentLayout()
const sceneContentWithoutPadding = { ...sceneCardContentLayout, padding: undefined }
const plainContentWithoutPadding = { ...plainCardContentLayout, padding: undefined }
check(
  JSON.stringify(sceneContentWithoutPadding) === JSON.stringify(plainContentWithoutPadding) &&
    sceneCardContentLayout.padding.every((value, index) => Number.parseFloat(value) < Number.parseFloat(plainCardContentLayout.padding[index])),
  '场景模式保留内容排版，并默认收紧内侧卡片四周留白',
  JSON.stringify({ plainCardContentLayout, sceneCardContentLayout }),
)
await page.getByRole('button', { name: /^场景微调/ }).click()
const scenePaddingControl = page.locator('#bymark-scene-card-padding')
check(
  await scenePaddingControl.getAttribute('min') === '0' &&
    await scenePaddingControl.getAttribute('max') === '100' &&
    await scenePaddingControl.inputValue() === '40',
  '场景卡片内边距默认 40%，并提供 0% 至 100% 的独立调节范围',
)
await scenePaddingControl.fill('0')
await waitForInnerPadding('.post-card-scene .post-card-inner', '0px|0px|0px|0px')
const compactScenePadding = await page.locator('.post-card-scene .post-card-inner').first().evaluate((node) => {
  const style = getComputedStyle(node)
  return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
})
check(
  compactScenePadding.every((value, index) => Number.parseFloat(value) < Number.parseFloat(sceneCardContentLayout.padding[index])),
  '卡片内边距可收至 0%，并同步移除四周留白',
  JSON.stringify({ sceneCardContentLayout, compactScenePadding }),
)
const sceneHeightControl = page.locator('#bymark-scene-card-height')
check(
  await sceneHeightControl.getAttribute('min') === '60' &&
    await sceneHeightControl.getAttribute('max') === '100' &&
    await sceneHeightControl.getAttribute('step') === '1' &&
    await sceneHeightControl.inputValue() === '100',
  '场景卡片高度默认 100%，可在 60% 至 100% 之间无级调节',
)
const fullHeightSceneCardBox = await page.locator('.post-card-scene .post-card-inner').first().boundingBox()
await sceneHeightControl.fill('72')
await page.waitForFunction(() =>
  document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.style.getPropertyValue('--scene-card-height-scale') === '0.72',
null, { timeout: 5000 })
const shortenedSceneCardBox = await page.locator('.post-card-scene .post-card-inner').first().boundingBox()
check(
  Boolean(fullHeightSceneCardBox && shortenedSceneCardBox) &&
    Math.abs((fullHeightSceneCardBox?.y ?? 0) - (shortenedSceneCardBox?.y ?? 0)) <= 1 &&
    (shortenedSceneCardBox?.height ?? 0) < (fullHeightSceneCardBox?.height ?? 0) &&
    Math.abs((fullHeightSceneCardBox?.width ?? 0) - (shortenedSceneCardBox?.width ?? 0)) <= 1 &&
    ((shortenedSceneCardBox?.y ?? 0) + (shortenedSceneCardBox?.height ?? 0)) <
      ((fullHeightSceneCardBox?.y ?? 0) + (fullHeightSceneCardBox?.height ?? 0)),
  '调节卡片高度时保持顶部与宽度不变，仅移动底边',
  JSON.stringify({ fullHeightSceneCardBox, shortenedSceneCardBox }),
)
await sceneHeightControl.fill('100')
await page.waitForFunction(() =>
  document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.style.getPropertyValue('--scene-card-height-scale') === '1',
null, { timeout: 5000 })
const sceneCardRatioButtons = page.getByRole('group', { name: '文字卡片比例' }).getByRole('button')
check(
  (await sceneCardRatioButtons.allTextContents()).map((label) => label.trim()).join('|') === '3:4|1:1|4:3',
  '场景卡片默认使用 3:4，并将 3:4 与 4:3 的位置互换',
)
check(await sceneCardRatioButtons.first().evaluate((button) => button.classList.contains('active')), '3:4 是默认场景卡片比例')
const builtInBackdrops = page.getByRole('radiogroup', { name: '内置渐变背景' }).getByRole('radio')
check((await builtInBackdrops.count()) === 3, '场景图片右侧仅提供三款内置渐变背景')
await page.getByRole('radio', { name: '石墨蓝灰', exact: true }).click()
check((await page.getByRole('radio', { name: '石墨蓝灰', exact: true }).getAttribute('aria-checked')) === 'true', '可直接选择内置渐变背景')
check(
  (await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => getComputedStyle(node).backgroundImage)).includes('linear-gradient'),
  '内置渐变同步渲染到最终导出卡片',
)
await page.getByLabel('选择场景背景图片').setInputFiles(fixture)
await page.locator('.post-scene-image:not(.pagination-probe *)').waitFor({ state: 'visible' })
check((await page.getByRole('radio', { name: '石墨蓝灰', exact: true }).getAttribute('aria-checked')) === 'false', '上传图片后切换为图片背景源')
check(await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.classList.contains('post-card-scene')), '场景图片模式进入最终导出卡片')
await page.getByRole('group', { name: '文字卡片比例' }).getByRole('button', { name: '1:1', exact: true }).click()
await page.waitForFunction(() => document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.style.getPropertyValue('--scene-card-ratio') === '1 / 1', null, { timeout: 5000 })
await page.locator('#bymark-scene-card-scale').evaluate((node) => {
  node.value = '82'
  node.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForFunction(() => document.querySelector('[data-testid="export-card"]:not([data-pagination-probe])')?.style.getPropertyValue('--scene-card-scale') === '0.82', null, { timeout: 5000 })
check((await page.getByRole('group', { name: '画面焦点' }).count()) === 0, '场景布局不再展示冗余画面焦点')
check((await page.locator('.post-scene-image:not(.pagination-probe *)').evaluate((node) => getComputedStyle(node).objectPosition)) === '50% 50%', '场景背景图片保持居中裁切')
check((await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => node.style.getPropertyValue('--scene-card-scale'))) === '0.82', '场景文字卡片可等比缩放')
const sceneCardVisuals = await page.locator('.post-card-scene .post-card-inner').first().evaluate((node) => {
  const style = getComputedStyle(node)
  return {
    backgroundColor: style.backgroundColor,
    borderRadius: style.borderRadius,
    opacity: style.opacity,
    scale: style.scale,
    aspectRatio: style.aspectRatio,
    boxShadow: style.boxShadow,
  }
})
check(sceneCardVisuals.backgroundColor === 'rgb(21, 22, 23)' && sceneCardVisuals.opacity === '1', '场景文字卡片使用完全不透明的背景', JSON.stringify(sceneCardVisuals))
check(sceneCardVisuals.borderRadius === '5px', '默认场景内侧卡片使用 5px 圆角', sceneCardVisuals.borderRadius)
check(
  sceneCardVisuals.boxShadow.includes('rgba(0, 0, 0, 0.44)') &&
    sceneCardVisuals.boxShadow.includes('0px 24px 64px'),
  '深色场景文字卡在明暗背景上都有双向分界',
  sceneCardVisuals.boxShadow,
)
check(sceneCardVisuals.scale === '0.82', '场景文字卡片缩放保持统一比例', sceneCardVisuals.scale)
check(sceneCardVisuals.aspectRatio === '1 / 1', '文字卡片比例可独立于导出画幅设置', sceneCardVisuals.aspectRatio)
const sceneCardBox = await page.locator('.post-card-scene .post-card-inner').first().boundingBox()
if (sceneCardBox) {
  await page.mouse.move(sceneCardBox.x + sceneCardBox.width / 2, sceneCardBox.y + sceneCardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sceneCardBox.x + sceneCardBox.width / 2 + 36, sceneCardBox.y + sceneCardBox.height / 2 + 48)
  await page.mouse.up()
}
const sceneCardPosition = await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => ({
  x: node.style.getPropertyValue('--scene-card-x'),
  y: node.style.getPropertyValue('--scene-card-y'),
}))
check(sceneCardPosition.x !== '50%' && sceneCardPosition.y !== '50%', '场景文字卡片可直接拖动到任意位置', JSON.stringify(sceneCardPosition))
await page.screenshot({ path: path.join(artifacts, 'desktop-scene.png') })
await page.getByRole('button', { name: '删除场景背景' }).click()
await page.getByRole('button', { name: '铺满', exact: true }).click()

await page.getByRole('button', { name: '3:4 · 默认文字思考', exact: true }).click()
await page.locator('.export-settings-button').click()
await page.getByRole('button', { name: '2K', exact: true }).click()
await page.locator('.export-settings-button').click()
await page.getByRole('tab', { name: '内容' }).click()
await openTitleSettings()
await titleInput.fill('一次关于“内容 / 商业”的思考？')
await page.getByRole('tab', { name: '导出' }).click()
await page.locator('#bymark-date').click()
{
  const qaExportTargetDay = page.locator('[data-date="2026-08-10"]')
  for (let i = 0; i < 12 && !(await qaExportTargetDay.isVisible().catch(() => false)); i += 1) {
    await page.getByRole('button', { name: '上个月' }).click()
    await page.waitForTimeout(60)
  }
  await qaExportTargetDay.click()
}
await page.locator('.export-settings-button').click()
check(await page.getByRole('group', { name: '导出时间' }).isVisible(), '导出时间设置位于导出选项下方')
check((await page.getByRole('button', { name: '已设置时间', exact: true }).getAttribute('aria-pressed')) === 'true', '导出默认使用已设置时间')
await page.locator('.export-settings-button').click()
const downloadPromise = page.waitForEvent('download')
await page.locator('.export-button').click()
const download = await downloadPromise
const suggested = download.suggestedFilename()
const exportedPngPath = path.join(artifacts, suggested)
await download.saveAs(exportedPngPath)
check(suggested === 'bymark-一次关于内容-商业的思考-2026-08-10-2k.png', 'PNG 文件名使用保留的作品日期与清晰度', suggested)
check((await download.failure()) === null, 'PNG 下载成功')
const exportedPng = await readFile(exportedPngPath)
check(
  exportedPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'PNG 下载内容具有真实 PNG 文件签名',
  exportedPng.subarray(0, 8).toString('hex'),
)
check(
  exportedPng.readUInt32BE(16) === 1536 && exportedPng.readUInt32BE(20) === 2048,
  '2K 3:4 PNG 严格导出为 1536 × 2048px',
  JSON.stringify({ width: exportedPng.readUInt32BE(16), height: exportedPng.readUInt32BE(20) }),
)
const exportedPngChunks = pngChunkTypes(exportedPng)
check(
  exportedPngChunks.includes('sRGB'),
  'PNG 写入标准 sRGB 颜色配置',
  exportedPngChunks.join(', '),
)
await page.locator('.export-settings-button').click()
const jpgFormat = page.getByRole('button', { name: 'JPG', exact: true })
check(await jpgFormat.isVisible(), '导出设置可切换 JPG 格式')
await jpgFormat.click()
check((await jpgFormat.getAttribute('aria-pressed')) === 'true', 'JPG 导出格式明确选中')
await page.getByRole('button', { name: '1K', exact: true }).click()
const exportSummaryPixels = (await page.locator('.export-summary').textContent()) ?? ''
check(
  exportSummaryPixels.includes('768 × 1024') && exportSummaryPixels.includes('约 '),
  '导出前明确显示目标像素与文件大小估算',
  exportSummaryPixels,
)
check(
  (await page.locator('.export-summary').textContent())?.includes('· 约 '),
  '导出说明保留文件大小估算语义，不使用模糊的像素密度表述',
)
const copyImageButton = page.getByRole('button', { name: '复制当前页图片' })
check(await copyImageButton.isVisible(), '提供复制当前页图片入口')
check((await copyImageButton.textContent()).trim() === '复制', '复制图片按钮使用简洁文案“复制”')
await copyImageButton.hover()
check(
  await copyImageButton.evaluate((node) => getComputedStyle(node, '::after').content.includes('复制当前页为图片')),
  '悬停复制按钮提示“复制当前页为图片”',
)
check(
  await copyImageButton.evaluate((node) => {
    const tooltip = getComputedStyle(node, '::after')
    // right: 0 表示提示右缘贴齐按钮右缘；left 的 used value 是解析后的像素而非 auto
    return tooltip.right === '0px' && Number.parseFloat(tooltip.left) < 0
  }),
  '复制图片提示右对齐，避免在导出面板右侧被裁切',
)
await page.getByRole('button', { name: '4K', exact: true }).click()

await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '导出' }).click()
check((await page.locator('.export-settings-button strong').textContent()) === '4K JPG', 'localStorage 恢复 JPG 导出格式与分辨率')
check((await page.getByLabel('昵称').inputValue()) === '留印测试者', 'localStorage 恢复昵称')
check((await page.locator('#bymark-series').count()) === 0, '本地设置不再恢复已移除的系列编号')
check(
  (await page.getByRole('switch', { name: '显示签名' }).getAttribute('aria-checked')) === 'true',
  'localStorage 恢复签名开关',
)
check((await page.locator('#bymark-signature').inputValue()) === '404', 'localStorage 恢复自定义签名')
await page.getByRole('tab', { name: '版式' }).click()
await page.getByRole('button', { name: /^高级/ }).click()
check((await page.locator('#bymark-font-scale').inputValue()) === '100', 'localStorage 恢复文字大小设置')
check((await page.locator('#bymark-line-height-scale').inputValue()) === '100', 'localStorage 恢复文字行高设置')
await page.getByRole('tab', { name: '内容' }).click()
check((await bodyInput.inputValue()).includes('短句也值得'), 'localStorage 恢复正文')
const persistedSettings = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('bymark-settings-v1') ?? 'null'),
)
check(
  persistedSettings?.version === 1 &&
    persistedSettings?.state?.name === '留印测试者' &&
    persistedSettings?.state?.showSignature === true,
  '所有修改写入带版本的本地设置记录',
  JSON.stringify(persistedSettings),
)

await page.getByRole('tab', { name: '导出' }).click()
await page.getByLabel('昵称').fill('模板作者')
await page.getByRole('tab', { name: '版式' }).click()
await page.getByRole('button', { name: /保存为预设/ }).click()
await page.getByLabel('预设名称').fill('我的抖音版式')
await page.getByRole('button', { name: '保存预设', exact: true }).click()
await page.getByText('我的抖音版式', { exact: true }).waitFor({ state: 'visible' })
check(await page.getByText('我的抖音版式', { exact: true }).isVisible(), '可自定义名称保存当前设置预设')
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '版式' }).click()
await page.getByText('我的抖音版式', { exact: true }).waitFor({ state: 'visible' })
check(await page.getByText('我的抖音版式', { exact: true }).isVisible(), '命名预设会持久保存到本地')
await page.getByRole('tab', { name: '导出' }).click()
await page.getByLabel('昵称').fill('临时作者')
await page.getByRole('tab', { name: '内容' }).click()
await bodyInput.fill('这段正文不应被预设替换。')
await page.getByRole('tab', { name: '版式' }).click()
await page.getByRole('button', { name: '应用设置预设：我的抖音版式' }).click()
await page.getByRole('tab', { name: '导出' }).click()
check((await page.getByLabel('昵称').inputValue()) === '模板作者', '应用品牌模板会恢复作者身份')
await page.getByRole('tab', { name: '内容' }).click()
check((await bodyInput.inputValue()) === '这段正文不应被预设替换。', '应用设置预设不会覆盖当前正文')
await bodyInput.fill('版本历史测试一')
await page.waitForTimeout(900)
check((await page.locator('.draft-history-toggle').count()) === 0, '草稿列表不显示额外历史版本操作')

const workspaceDownloadPromise = page.waitForEvent('download')
await page.getByRole('button', { name: /备份工作区/ }).click()
const workspaceDownload = await workspaceDownloadPromise
const workspacePath = path.join(artifacts, workspaceDownload.suggestedFilename())
await workspaceDownload.saveAs(workspacePath)
const workspacePayload = JSON.parse(await readFile(workspacePath, 'utf8'))
check(workspacePayload.format === 'bymark-workspace' && workspacePayload.version === 2, '工作区备份使用带版本的 JSON 格式')
check(Array.isArray(workspacePayload.drafts) && Array.isArray(workspacePayload.archives) && 'sceneImage' in workspacePayload, '工作区备份包含草稿、归档与场景资源字段')
await page.getByLabel('选择工作区备份文件').setInputFiles(workspacePath)
await page.getByText('工作区已恢复', { exact: false }).waitFor({ state: 'visible' })
check(await page.getByText('工作区已恢复', { exact: false }).isVisible(), '工作区备份可重新恢复并合并本地内容')

const desktopMetrics = await page.evaluate(() => ({
  innerWidth,
  innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  editor: document.querySelector('.editor-panel')?.getBoundingClientRect().toJSON(),
  preview: document.querySelector('.preview-panel')?.getBoundingClientRect().toJSON(),
}))
const cardBox = await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').boundingBox()
check(desktopMetrics.scrollWidth <= desktopMetrics.innerWidth, '桌面端无横向滚动')
check(
  Math.abs((desktopMetrics.editor?.bottom ?? 0) - desktopMetrics.innerHeight) <= 1,
  '桌面编辑器持续延伸至视口底部',
  JSON.stringify({ editorBottom: desktopMetrics.editor?.bottom, innerHeight: desktopMetrics.innerHeight }),
)
check((desktopMetrics.preview?.right ?? Infinity) <= desktopMetrics.innerWidth + 1, '桌面预览区未被裁切')
check(
  (cardBox?.y ?? -1) >= 0 && (cardBox?.y ?? Infinity) + (cardBox?.height ?? Infinity) <= desktopMetrics.innerHeight + 1,
  '桌面首屏可完整看到最终卡片',
  JSON.stringify({ cardBox, innerHeight: desktopMetrics.innerHeight }),
)

await page.setViewportSize({ width: 1280, height: 720 })
await page.waitForTimeout(120)
const compactBox = await page.locator('[data-testid="export-card"]:not([data-pagination-probe])').boundingBox()
const compactWidth = await page.evaluate(() => document.documentElement.scrollWidth)
check(compactWidth <= 1280, '1280×720 桌面视口无横向滚动')
check(
  (compactBox?.y ?? -1) >= 0 && (compactBox?.y ?? Infinity) + (compactBox?.height ?? Infinity) <= 721,
  '1280×720 桌面视口完整显示卡片',
  JSON.stringify(compactBox),
)
await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png') })

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})
const mobilePage = await mobile.newPage()
const mobileErrors = []
mobilePage.on('pageerror', (error) => mobileErrors.push(error.message))
await mobilePage.goto(baseURL, { waitUntil: 'networkidle' })
await mobilePage.screenshot({ path: path.join(artifacts, 'mobile-editor.png') })
const mobileDraftTrigger = mobilePage.getByRole('button', { name: '展开草稿入口' })
check(await mobileDraftTrigger.isVisible(), '手机端左下角显示草稿抽屉入口')
check(
  await mobilePage.locator('.draft-library').evaluate((node) => node.getBoundingClientRect().right <= 0),
  '手机端草稿默认收进左侧抽屉',
)
await mobileDraftTrigger.click()
await mobilePage.waitForTimeout(340)
check(await mobilePage.getByRole('button', { name: '打开草稿抽屉' }).isVisible(), '点击图标后草稿入口展开为完整按钮')
await mobilePage.getByRole('button', { name: '打开草稿抽屉' }).click()
await mobilePage.waitForTimeout(340)
const mobileDrawerOpen = await mobilePage.evaluate(() => {
  const drawer = document.querySelector('.draft-library')?.getBoundingClientRect()
  return {
    left: drawer?.left,
    height: drawer?.height,
    viewportHeight: innerHeight,
    backdropOpacity: getComputedStyle(document.querySelector('.draft-mobile-backdrop')).opacity,
    scrollLocked: document.documentElement.classList.contains('draft-drawer-open'),
  }
})
check(
  Math.abs(mobileDrawerOpen.left ?? 99) <= 1 &&
    Math.abs((mobileDrawerOpen.height ?? 0) - mobileDrawerOpen.viewportHeight) <= 1 &&
    mobileDrawerOpen.backdropOpacity === '1' &&
    mobileDrawerOpen.scrollLocked,
  '手机端草稿从左侧完整滑出并锁定背景',
  JSON.stringify(mobileDrawerOpen),
)
check(await mobilePage.locator('.draft-mobile-footer-close').isVisible(), '手机端侧栏底部提供左箭头关闭入口')
check(await mobilePage.getByRole('button', { name: /备份工作区/ }).isVisible(), '手机端草稿抽屉仍可备份工作区')
check(await mobilePage.getByRole('button', { name: /恢复工作区/ }).isVisible(), '手机端草稿抽屉仍可恢复工作区')
check(await mobilePage.locator('.workspace-summary').isHidden(), '手机端侧栏底部不显示工作区说明')
await mobilePage.locator('.draft-mobile-footer-close').click()
await mobilePage.waitForTimeout(340)
check(await mobilePage.getByRole('button', { name: '展开草稿入口' }).isVisible(), '点击抽屉外的关闭按钮后草稿胶囊收回为图标')
check(
  await mobilePage.locator('.draft-library').evaluate((node) => node.getBoundingClientRect().right <= 0),
  '手机端草稿抽屉可由关闭按钮收回',
)
const mobileMetrics = await mobilePage.evaluate(() => ({
  innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  innerHeight,
  editorTop: document.querySelector('.editor-panel')?.getBoundingClientRect().top,
  previewTop: document.querySelector('.preview-panel')?.getBoundingClientRect().top,
  editorHeight: document.querySelector('.editor-panel')?.getBoundingClientRect().height,
}))
check(mobileMetrics.scrollWidth <= mobileMetrics.innerWidth, '手机端无横向滚动')
check(
  mobileMetrics.scrollHeight <= mobileMetrics.innerHeight + 1,
  '手机端编辑页不会在导出栏下方产生额外留白',
  JSON.stringify(mobileMetrics),
)
check(
  (await mobilePage.getByRole('tab', { name: '编辑' }).getAttribute('aria-selected')) === 'true',
  '手机端默认进入编辑模式',
)
const mobileHeaderOrder = await mobilePage.evaluate(() => {
  const brand = document.querySelector('.mobile-brand-lockup')?.getBoundingClientRect()
  const switcher = document.querySelector('.mobile-mode-switch')?.getBoundingClientRect()
  return { brandTop: brand?.top, brandBottom: brand?.bottom, switchTop: switcher?.top }
})
check(
  (mobileHeaderOrder.brandTop ?? Infinity) === 0 && (mobileHeaderOrder.brandBottom ?? Infinity) <= (mobileHeaderOrder.switchTop ?? -Infinity),
  '手机端将留印与主题切换置顶，编辑和预览切换置于其下',
  JSON.stringify(mobileHeaderOrder),
)
check((await mobilePage.locator('.mobile-brand-lockup h1').innerText()) === '留印', '手机品牌标题不重复展示英文名')
check(
  await mobilePage
    .locator('.preview-panel')
    .boundingBox()
    .then((box) => (box?.x ?? 0) < -1000),
  '编辑时预览不占用页面滚动空间',
)
check(
  (await mobilePage.locator('.export-button').evaluate((node) => node.getBoundingClientRect().height)) >= 44,
  '手机端主按钮触控高度合格',
)
await mobilePage.getByRole('tab', { name: '版式' }).click()
await mobilePage.getByRole('button', { name: '9:16 · 全屏发布', exact: true }).click()
await mobilePage.getByRole('tab', { name: '预览' }).click()
const mobileDraftTransitionFrames = await mobilePage.evaluate(async () => {
  const trigger = document.querySelector('.draft-mobile-trigger')
  const frames = []
  for (let index = 0; index < 20; index += 1) {
    await new Promise(requestAnimationFrame)
    const rect = trigger?.getBoundingClientRect()
    frames.push({
      opacity: Number(getComputedStyle(trigger).opacity),
      bottom: rect?.bottom,
      visualViewportBottom: (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight),
    })
  }
  return frames
})
check(
  mobileDraftTransitionFrames.every((frame) =>
    frame.opacity >= 0.99 && Math.abs((frame.visualViewportBottom ?? 0) - (frame.bottom ?? 0) - 16) <= 1,
  ),
  '编辑和预览切换期间草稿入口始终固定在左下角且不消失',
  JSON.stringify(mobileDraftTransitionFrames),
)
await mobilePage.waitForTimeout(100)
check(
  (await mobilePage.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')) === 'true',
  '手机端可切换到预览模式',
)
check(await mobilePage.locator('.editor-panel').isHidden(), '预览模式收起编辑表单')
await mobilePage.screenshot({ path: path.join(artifacts, 'mobile-preview.png') })
check(await mobilePage.locator('[data-testid="export-card"]:not([data-pagination-probe])').isVisible(), '手机端预览可正常操作与查看')
const mobileDirectorPlacement = await mobilePage.evaluate(() => {
  const director = document.querySelector('.page-director')?.getBoundingClientRect()
  const drafts = document.querySelector('.draft-mobile-trigger')?.getBoundingClientRect()
  const exportButton = document.querySelector('.mobile-preview-export')?.getBoundingClientRect()
  return director && drafts && exportButton
    ? {
        intersects: director.left < drafts.right && director.right > drafts.left &&
          director.top < drafts.bottom && director.bottom > drafts.top,
        exportGap: director.top - exportButton.bottom,
      }
    : null
})
check(
  mobileDirectorPlacement === null || !mobileDirectorPlacement.intersects,
  '手机端分页导演台不与草稿入口重叠',
  JSON.stringify(mobileDirectorPlacement),
)
check(
  mobileDirectorPlacement === null || (mobileDirectorPlacement.exportGap >= 4 && mobileDirectorPlacement.exportGap <= 10),
  '手机端分页导演台紧贴导出按钮下方',
  JSON.stringify(mobileDirectorPlacement),
)
const mobilePreviewAlignment = await mobilePage.evaluate(() => {
  const viewport = document.querySelector('.preview-viewport')?.getBoundingClientRect()
  const heading = document.querySelector('.preview-heading')?.getBoundingClientRect()
  const card = document.querySelector('[data-testid="export-card"]')?.getBoundingClientRect()
  return viewport && heading && card
    ? {
        leftGap: card.left - viewport.left,
        rightGap: viewport.right - card.right,
        headingLeftGap: Math.abs(heading.left - card.left),
        headingRightGap: Math.abs(heading.right - card.right),
      }
    : null
})
check(
  mobilePreviewAlignment !== null &&
    Math.abs(mobilePreviewAlignment.leftGap - mobilePreviewAlignment.rightGap) <= 1 &&
    mobilePreviewAlignment.headingLeftGap <= 1 &&
    mobilePreviewAlignment.headingRightGap <= 1,
  '手机端 9:16 预览与标题左、右边缘对齐并水平居中',
  JSON.stringify(mobilePreviewAlignment),
)
check((await mobilePage.locator('.safe-area-guide').count()) === 0, '手机端 9:16 预览不显示发布安全区')
const mobilePreviewHeadingGap = await mobilePage.evaluate(() => {
  const heading = document.querySelector('.preview-heading')?.getBoundingClientRect()
  const card = document.querySelector('[data-testid="export-card"]')?.getBoundingClientRect()
  return heading && card ? card.top - heading.bottom : null
})
check(
  mobilePreviewHeadingGap !== null && mobilePreviewHeadingGap >= 0 && mobilePreviewHeadingGap <= 14,
  '手机端实时预览信息紧贴卡片上方',
  String(mobilePreviewHeadingGap),
)
await mobilePage.getByRole('button', { name: '展开草稿入口' }).click()
await mobilePage.getByRole('button', { name: '打开草稿抽屉' }).click()
await mobilePage.waitForTimeout(340)
check(
  await mobilePage.locator('.draft-library').evaluate((node) => Math.abs(node.getBoundingClientRect().left) <= 1),
  '手机端预览模式也可打开草稿抽屉',
)
await mobilePage.getByRole('button', { name: '关闭草稿抽屉', exact: true }).last().click()
await mobilePage.waitForTimeout(340)
const mobilePublishPlacement = await mobilePage.evaluate(() => {
  const archive = document.querySelector('.mobile-preview-archive')?.getBoundingClientRect()
  const publish = document.querySelector('.mobile-preview-export')?.getBoundingClientRect()
  const card = document.querySelector('[data-testid="export-card"]')?.getBoundingClientRect()
  const drafts = document.querySelector('.draft-mobile-trigger')?.getBoundingClientRect()
  return {
    archiveTop: archive?.top,
    archiveBottom: archive?.bottom,
    publishTop: publish?.top,
    publishBottom: publish?.bottom,
    cardBottom: card?.bottom,
    draftsTop: drafts?.top,
  }
})
check(
  (mobilePublishPlacement.archiveTop ?? -Infinity) >= (mobilePublishPlacement.cardBottom ?? Infinity) &&
    (mobilePublishPlacement.archiveTop ?? Infinity) - (mobilePublishPlacement.cardBottom ?? -Infinity) <= 12 &&
    (mobilePublishPlacement.publishTop ?? -Infinity) >= (mobilePublishPlacement.archiveBottom ?? Infinity) &&
    (mobilePublishPlacement.publishBottom ?? Infinity) < (mobilePublishPlacement.draftsTop ?? Infinity),
  '手机端归档与导出按钮依次紧贴卡片下方，并为草稿入口留出空间',
  JSON.stringify(mobilePublishPlacement),
)
check(await mobilePage.getByRole('button', { name: '导出图片', exact: false }).isVisible(), '手机端预览可直接导出')
check(await mobilePage.getByRole('button', { name: '归档', exact: true }).isVisible(), '手机端预览可直接归档')
check(await mobilePage.evaluate(() => {
  const archive = document.querySelector('.mobile-preview-archive')
  const exportButton = document.querySelector('.mobile-preview-export')
  if (!archive || !exportButton) return false
  return getComputedStyle(archive).backgroundColor === 'rgb(23, 24, 26)' &&
    getComputedStyle(exportButton).backgroundColor === 'rgb(117, 141, 56)'
}), '手机端归档为黑色按钮，导出为主题强调绿按钮')
check(
  await mobilePage.evaluate(() => {
    const heading = document.querySelector('.preview-heading')?.getBoundingClientRect()
    const card = document.querySelector('[data-testid="export-card"]')?.getBoundingClientRect()
    return Boolean(heading && card && heading.bottom <= card.top)
  }),
  '9:16 预览保留完整标题区域，不与卡片重叠',
)
await mobilePage.waitForTimeout(100)
const mobileVerticalDimensions = await mobilePage.locator('[data-testid="export-card"]:not([data-pagination-probe])').evaluate((node) => ({
  width: node.clientWidth,
  height: node.clientHeight,
}))
check(mobileVerticalDimensions.width === 800 && mobileVerticalDimensions.height === 1422, '手机端可切换 9:16 画布')
check(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机端 9:16 无横向溢出')
await mobilePage.screenshot({ path: path.join(artifacts, 'mobile-9-16.png') })
await mobilePage.getByRole('tab', { name: '编辑' }).click()
check(await mobilePage.locator('.editor-panel').isVisible(), '手机端可从预览返回编辑')
await mobilePage.getByRole('tab', { name: '内容' }).click()
check(
  (await mobilePage.getByLabel('正文', { exact: true }).inputValue()).includes('留印 | Bymark'),
  '切回编辑后保留当前输入内容',
)

const migration = await browser.newContext({ viewport: { width: 1200, height: 900 } })
await migration.addInitScript(() => {
  localStorage.setItem(
    'postmark-state-v1',
    JSON.stringify({
      name: '旧版本作者',
      ratio: '9:16',
      fontScale: 106,
      showDate: false,
    }),
  )
})
const migrationPage = await migration.newPage()
await migrationPage.goto(baseURL, { waitUntil: 'networkidle' })
await migrationPage.waitForFunction(() => Boolean(localStorage.getItem('bymark-settings-v1')))
await migrationPage.getByRole('tab', { name: '导出' }).click()
check((await migrationPage.getByLabel('昵称').inputValue()) === '旧版本作者', '旧版本地设置可自动迁移')
await migrationPage.getByRole('tab', { name: '版式' }).click()
check(
  await migrationPage.getByRole('button', { name: '9:16 · 全屏发布', exact: true }).isVisible(),
  '旧版画幅设置迁移后保持有效',
)
check(
  await migrationPage.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('bymark-settings-v1') ?? 'null')
    return saved?.version === 1 && saved?.state?.fontScale === 106 && saved?.state?.showDate === false
  }),
  '旧版状态写入新的本地设置文件',
)

const avatarFallback = await browser.newContext({ viewport: { width: 900, height: 700 } })
await avatarFallback.addInitScript(() => {
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined })
  localStorage.setItem('bymark-avatar-v1', 'data:image/png;base64,avatar-fallback-test')
})
const avatarFallbackPage = await avatarFallback.newPage()
await avatarFallbackPage.goto(baseURL, { waitUntil: 'networkidle' })
check(
  (await avatarFallbackPage.locator('.post-avatar img:not(.pagination-probe *)').getAttribute('src')) === 'data:image/png;base64,avatar-fallback-test',
  '禁用 IndexedDB 后刷新仍能从统一 fallback key 恢复头像',
)

check(consoleErrors.length === 0, '桌面浏览器无运行时错误', consoleErrors.join(' | '))
check(mobileErrors.length === 0, '手机浏览器无运行时错误', mobileErrors.join(' | '))

await migration.close()
await avatarFallback.close()
await mobile.close()
await desktop.close()
await browser.close()

console.log(`QA checks: ${checks.length}`)
if (failures.length) {
  console.error(`Failures (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('All functional and viewport checks passed.')
