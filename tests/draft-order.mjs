import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  // An isolated context keeps the user's local drafts untouched.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(process.env.BYMARK_URL || 'http://127.0.0.1:5174', { waitUntil: 'networkidle' })
  const body = page.getByLabel('正文', { exact: true })
  const titles = () => page.locator('.draft-row h3').allTextContents()
  const waitForTitles = async (expected) => {
    await page.waitForFunction((values) => JSON.stringify(
      [...document.querySelectorAll('.draft-row h3')].map((node) => node.textContent),
    ) === JSON.stringify(values), expected)
    assert.deepEqual(await titles(), expected)
  }
  const freshDraft = async (text) => {
    await page.getByRole('button', { name: '新建草稿', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#bymark-text')?.value === '')
    await body.fill(text)
  }

  await page.getByRole('button', { name: '作品标题 可选', exact: true }).click()
  await page.locator('#bymark-title').fill('')
  await body.fill('排序测试甲')
  await waitForTitles(['排序测试甲'])
  await freshDraft('排序测试乙')
  await waitForTitles(['排序测试乙', '排序测试甲'])

  await page.locator('.draft-drag-handle').last().press('Alt+ArrowUp')
  await waitForTitles(['排序测试甲', '排序测试乙'])
  await freshDraft('排序测试丙')
  await waitForTitles(['排序测试丙', '排序测试甲', '排序测试乙'])
  await page.reload({ waitUntil: 'networkidle' })
  await waitForTitles(['排序测试丙', '排序测试甲', '排序测试乙'])

  await page.getByRole('button', { name: '下一期', exact: true }).click()
  await waitForTitles(['未命名草稿', '排序测试丙', '排序测试甲', '排序测试乙'])
  await body.fill('排序测试丁')
  await waitForTitles(['排序测试丁', '排序测试丙', '排序测试甲', '排序测试乙'])
  await page.reload({ waitUntil: 'networkidle' })
  await waitForTitles(['排序测试丁', '排序测试丙', '排序测试甲', '排序测试乙'])

  await page.locator('.draft-drag-handle').first().press('Alt+ArrowDown')
  await waitForTitles(['排序测试丙', '排序测试丁', '排序测试甲', '排序测试乙'])
  await body.fill('排序测试丁已修改')
  await waitForTitles(['排序测试丙', '排序测试丁已修改', '排序测试甲', '排序测试乙'])
  await page.reload({ waitUntil: 'networkidle' })
  await waitForTitles(['排序测试丙', '排序测试丁已修改', '排序测试甲', '排序测试乙'])
  console.log('Draft ordering passed: new drafts, next issue, manual order, autosave, and reload.')
} finally {
  await browser.close()
}
