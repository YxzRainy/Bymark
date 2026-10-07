import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ headless: true })
const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'

try {
  await mkdir('test-results', { recursive: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    const errors = []
    await context.route('**/__bymark_shared_storage*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await context.route('https://api.github.com/repos/YxzRainy/Bymark/releases/latest', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await context.addInitScript(() => {
      if (!localStorage.getItem('bymark-settings-v1')) {
        localStorage.setItem('bymark-settings-v1', JSON.stringify({
          version: 1,
          state: { visualStyle: 'folio', canvasStyle: 'scene', text: '做 AI 最成熟的生意，\n教别人学 AI。', socialMetricScale: 'daily' },
        }))
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
    await page.locator('.app-shell').waitFor()
    const disclosure = page.getByRole('button', { name: '互动数据', exact: true })
    const randomize = page.locator('.social-metrics-random-button')
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    await randomize.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    await disclosure.click()
    assert.equal(await page.locator('.social-metrics-scale-picker button').count(), 5)
    assert.equal(await page.locator('.social-metrics-editor select').count(), 0)
    assert.equal(await page.locator('.social-metrics-scale-picker button.active').textContent(), '日常')

    for (const [label, minimum, maximum] of [['克制', 200, 999], ['日常', 1_000, 4_999], ['起量', 5_000, 19_999], ['热门', 20_000, 99_999], ['出圈', 100_000, 1_500_000]]) {
      await page.getByRole('button', { name: label, exact: true }).click()
      for (let sample = 0; sample < 5; sample++) {
        if (sample > 0) await randomize.click()
        const values = await page.locator('.social-metrics-grid input').evaluateAll((inputs) => inputs.map((input) => input.value))
        const [replies, reposts, likes, views] = values.map((value) => Number.parseFloat(value) * (value.endsWith('M') ? 1_000_000 : value.endsWith('K') ? 1_000 : 1))
        assert.ok(views >= minimum && views <= maximum, `${label}: ${views} outside exposure band`)
        assert.ok(likes > replies && likes > reposts && likes <= views * 0.04 + 1)
        assert.ok(replies <= views * 0.003 + 1)
        assert.ok(reposts <= views * 0.0015 + 1)
        await page.waitForFunction((expected) => {
          const preview = document.querySelector('[data-testid="export-card"]:not([data-pagination-probe]) .post-social-actions')
          return preview && JSON.stringify([...preview.querySelectorAll('b')].map((node) => node.textContent)) === JSON.stringify(expected)
        }, values.filter((value) => value.trim() !== '' && Number(value) !== 0))
      }
    }
    const metrics = await page.locator('.social-metrics-grid input').evaluateAll((inputs) => inputs.map((input) => input.value))
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('bymark-settings-v1') || '{}').state?.socialMetricScale === 'viral')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.app-shell').waitFor()
    await disclosure.click()
    assert.equal(await page.locator('.social-metrics-scale-picker button.active').textContent(), '出圈')
    assert.deepEqual(await page.locator('.social-metrics-grid input').evaluateAll((inputs) => inputs.map((input) => input.value)), metrics)
    await page.locator('#bymark-socialLikes').fill('770')
    await page.locator('#bymark-socialViews').fill('9.2K')
    await page.waitForFunction(() => document.querySelector('[data-testid="export-card"]:not([data-pagination-probe]) .post-social-actions')?.textContent?.includes('9.2K'))
    const fit = await page.locator('.social-metrics-scale-picker').evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      return node.scrollWidth <= node.clientWidth && [...node.querySelectorAll('button')].every((button) => {
        const rect = button.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right && rect.width >= 30
      })
    })
    assert.ok(fit, `Five scale buttons must fit at ${width}px`)
    await page.locator('.social-metrics-disclosure').screenshot({ path: `test-results/social-metrics-${width}.png` })
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('Social metrics UI: desktop/mobile automatic generation on scale selection, dice rerolls, preview updates, manual edits, and reload persistence passed.')
} finally {
  await browser.close()
}
