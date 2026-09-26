import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ headless: true })

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await page.goto(process.env.BYMARK_URL || 'http://127.0.0.1:5174', { waitUntil: 'domcontentloaded' })
  const trigger = page.locator('.draft-mobile-trigger')
  await trigger.waitFor()
  await page.locator('#bymark-text').fill('草稿入口动画测试')
  await page.waitForFunction(() => Boolean(document.querySelector('.draft-mobile-trigger em')), null, { timeout: 5000 })
  const collapsedWidth = await trigger.evaluate((node) => node.getBoundingClientRect().width)
  const collapsedCenterX = await trigger.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return (rect.left + rect.right) / 2
  })
  if (await trigger.getAttribute('aria-label') !== '展开草稿入口') throw new Error('初始状态应只显示草稿图标')
  const centerOffsets = await page.evaluate(() => {
    const draft = document.querySelector('.draft-mobile-trigger')?.getBoundingClientRect()
    const archive = document.querySelector('.export-dock .archive-button')?.getBoundingClientRect()
    const exportButton = document.querySelector('.export-dock .export-button')?.getBoundingClientRect()
    if (!draft || !archive || !exportButton) return null
    const draftCenter = (draft.top + draft.bottom) / 2
    return [archive, exportButton].map((button) => draftCenter - (button.top + button.bottom) / 2)
  })
  if (!centerOffsets || centerOffsets.some((offset) => Math.abs(offset) > 1.5)) {
    throw new Error(`草稿图标与归档、导出文字未处于同一水平中线：${JSON.stringify(centerOffsets)}`)
  }
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/draft-trigger-collapsed.png' })

  const widths = await trigger.evaluate(async (node) => {
    const samples = [node.getBoundingClientRect().width]
    node.click()
    for (let index = 0; index < 24; index += 1) {
      await new Promise(requestAnimationFrame)
      samples.push(node.getBoundingClientRect().width)
    }
    return samples
  })
  const expandedWidth = widths.at(-1)
  if (expandedWidth < collapsedWidth + 25) throw new Error(`草稿入口未展开：${collapsedWidth} → ${expandedWidth}`)
  if (!widths.some((width) => width > collapsedWidth + 3 && width < expandedWidth - 3)) {
    throw new Error(`草稿入口缺少可见的宽度过渡：${JSON.stringify(widths)}`)
  }
  if (await trigger.getAttribute('aria-label') !== '打开草稿抽屉') throw new Error('展开后的按钮名称错误')
  if (await page.locator('.draft-library').evaluate((node) => node.classList.contains('draft-library-mobile-open'))) {
    throw new Error('第一次点击不应直接打开草稿抽屉')
  }
  const actionGap = await page.evaluate(() => {
    const draft = document.querySelector('.draft-mobile-trigger')?.getBoundingClientRect()
    const archive = document.querySelector('.export-dock .archive-button')?.getBoundingClientRect()
    return draft && archive ? archive.left - draft.right : null
  })
  if (actionGap === null || actionGap < 8) throw new Error(`展开的草稿入口遮挡归档按钮：间距 ${actionGap}`)
  await page.screenshot({ path: 'test-results/draft-trigger-expanded.png' })

  const reverseWidths = await page.evaluate(async () => {
    const trigger = document.querySelector('.draft-mobile-trigger')
    const input = document.querySelector('#bymark-text')
    const samples = [trigger.getBoundingClientRect().width]
    input.focus()
    input.click()
    for (let index = 0; index < 30; index += 1) {
      await new Promise(requestAnimationFrame)
      samples.push(trigger.getBoundingClientRect().width)
    }
    return samples
  })
  if (reverseWidths.at(-1) > collapsedWidth + 2) throw new Error(`点击胶囊外部后未收起：${JSON.stringify(reverseWidths)}`)
  if (!reverseWidths.some((width) => width > collapsedWidth + 3 && width < expandedWidth - 3)) {
    throw new Error(`草稿入口缺少收起动画：${JSON.stringify(reverseWidths)}`)
  }
  if (await trigger.getAttribute('aria-label') !== '展开草稿入口') throw new Error('收起后应恢复图标按钮')
  if (!(await page.locator('#bymark-text').evaluate((node) => document.activeElement === node))) throw new Error('外部点击不应阻止输入框获得焦点')

  await trigger.click()
  await page.waitForFunction(() => document.querySelector('.draft-mobile-trigger')?.classList.contains('draft-mobile-trigger-expanded'))
  await page.locator('#bymark-text').click()
  await page.waitForFunction(() => document.querySelector('.draft-mobile-trigger')?.getAttribute('aria-label') === '展开草稿入口')
  await trigger.click()
  await page.waitForFunction(() => document.querySelector('.draft-mobile-trigger')?.classList.contains('draft-mobile-trigger-expanded'))
  await trigger.click()
  await page.waitForFunction(() => document.querySelector('.draft-library')?.classList.contains('draft-library-mobile-open'))
  await page.waitForTimeout(340)
  const footerClose = page.locator('.draft-mobile-footer-close')
  const footerCloseCenterX = await footerClose.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return (rect.left + rect.right) / 2
  })
  if (Math.abs(footerCloseCenterX - collapsedCenterX) > 1) {
    throw new Error(`抽屉返回按钮未与草稿入口对齐：${collapsedCenterX} → ${footerCloseCenterX}`)
  }
  const footerActionCenterOffsets = await page.evaluate(() => {
    const exportButton = document.querySelector('.export-dock .export-button')?.getBoundingClientRect()
    const footerButtons = Array.from(document.querySelectorAll('.workspace-tools button'))
    if (!exportButton || footerButtons.length !== 3) return null
    const exportCenter = (exportButton.top + exportButton.bottom) / 2
    return footerButtons.map((button) => {
      const rect = button.getBoundingClientRect()
      return (rect.top + rect.bottom) / 2 - exportCenter
    })
  })
  if (!footerActionCenterOffsets || footerActionCenterOffsets.some((offset) => Math.abs(offset) > 1)) {
    throw new Error(`侧栏底部按钮未与导出按钮垂直居中：${JSON.stringify(footerActionCenterOffsets)}`)
  }
  await footerClose.focus()
  await page.mouse.move(389, 0)
  await page.screenshot({ path: 'test-results/draft-drawer-footer-aligned.png' })
  await footerClose.click()
  await page.waitForFunction(() => !document.querySelector('.draft-library')?.classList.contains('draft-library-mobile-open'))
  await page.waitForTimeout(340)
  if (await trigger.getAttribute('aria-label') !== '展开草稿入口') throw new Error('点击抽屉关闭按钮后应收起胶囊')
  await page.setViewportSize({ width: 442, height: 844 })
  await page.waitForTimeout(450)
  const wideOffset = await page.evaluate(() => {
    const draft = document.querySelector('.draft-mobile-trigger')?.getBoundingClientRect()
    const archive = document.querySelector('.export-dock .archive-button')?.getBoundingClientRect()
    return draft && archive ? (draft.top + draft.bottom - archive.top - archive.bottom) / 2 : null
  })
  if (wideOffset === null || Math.abs(wideOffset) > 1.5) throw new Error(`442px 视口下草稿图标未对齐：${wideOffset}`)
  await page.screenshot({ path: 'test-results/draft-trigger-aligned-442.png' })
  await page.getByRole('tab', { name: '预览' }).click()
  const previewBottomGap = await trigger.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight) - rect.bottom
  })
  if (Math.abs(previewBottomGap - 16) > 1.5) throw new Error(`预览页草稿入口位置发生变化：${previewBottomGap}`)
  console.log('草稿入口双向动画、外部点击与抽屉路径通过', { collapsedWidth, expandedWidth, centerOffsets, footerActionCenterOffsets, wideOffset })
} finally {
  await browser.close()
}
