import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'
const browser = await chromium.launch({ headless: true })

try {
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await desktop.newPage()
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  const input = page.locator('#bymark-text')
  await input.waitFor()
  const toolbar = page.getByRole('toolbar', { name: '正文编辑工具' })
  const actions = ['撤销', '重做', '剪切', '复制', '粘贴', '加粗', '斜体', '一级标题', '引用', '无序列表', '有序列表']
  for (const name of actions) {
    if (await toolbar.getByRole('button', { name, exact: true }).count() !== 1) {
      throw new Error(`正文工具栏缺少「${name}」`)
    }
  }

  await input.fill('要剪切的文字')
  await input.evaluate((node) => node.setSelectionRange(0, 3))
  await page.waitForFunction(() => !document.querySelector('.markdown-toolbar button[aria-label="剪切"]')?.disabled)
  await toolbar.getByRole('button', { name: '复制', exact: true }).click()
  if (await page.evaluate(() => navigator.clipboard.readText()) !== '要剪切') throw new Error('工具栏复制失败')
  await toolbar.getByRole('button', { name: '剪切', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#bymark-text')?.value === '的文字')
  await toolbar.getByRole('button', { name: '粘贴', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#bymark-text')?.value === '要剪切的文字')
  await input.evaluate((node) => node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 200,
  })))
  if (!(await page.getByRole('menu', { name: '正文编辑菜单' }).isVisible())) throw new Error('桌面右键菜单未打开')

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(baseURL, { waitUntil: 'domcontentloaded' })
  const mobileInput = mobilePage.locator('#bymark-text')
  await mobileInput.waitFor()
  const longPress = await mobileInput.evaluate((node) => {
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    node.dispatchEvent(event)
    return { prevented: event.defaultPrevented, customMenu: Boolean(document.querySelector('.text-context-menu')) }
  })
  if (longPress.prevented || longPress.customMenu) throw new Error('触摸长按被自定义菜单拦截')
  await mobileInput.evaluate((node) => {
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  if (!(await mobilePage.getByRole('menu', { name: '正文编辑菜单' }).isVisible())) throw new Error('外接鼠标右键菜单未打开')
  await mobilePage.keyboard.press('Escape')

  const mobileToolbar = mobilePage.getByRole('toolbar', { name: '正文编辑工具' })
  const layout = await mobileToolbar.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    return {
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clippedButtons: [...node.querySelectorAll('button')].filter((button) => {
        const rect = button.getBoundingClientRect()
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1
      }).map((button) => button.getAttribute('aria-label')),
    }
  })
  await mkdir('test-results', { recursive: true })
  await mobilePage.screenshot({ path: 'test-results/mobile-toolbar.png' })
  if (layout.clippedButtons.length) throw new Error(`手机工具栏布局异常：${JSON.stringify(layout)}`)
  console.log('编辑菜单与工具栏专项检查通过', layout)
} finally {
  await browser.close()
}
