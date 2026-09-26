import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'

const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'
const engine = process.env.BYMARK_BROWSER === 'webkit' ? webkit : chromium
const browser = await engine.launch()
const closeTo = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} vs ${expected}`)

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    if (!localStorage.getItem('bymark-settings-v1')) {
      localStorage.setItem('bymark-settings-v1', JSON.stringify({ state: {
        text: '想象一下，\n三年后 Astra 这种东西都烂大街了，\n\n网上还是会有人认真讨论。',
        canvasStyle: 'scene', visualStyle: 'folio', theme: 'white',
        sceneCardRatio: '4:3', sceneCardHeight: 85, sceneCardScale: 82,
      } }))
    }
  })
  const card = page.locator('.preview-panel .post-card-inner')
  const position = () => page.evaluate(() => {
    const { sceneCardX: x, sceneCardY: y } = JSON.parse(localStorage.getItem('bymark-settings-v1')).state
    return { x, y }
  })
  const settleFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await card.waitFor({ state: 'visible' })
  await page.waitForTimeout(700)
  assert.equal(
    await card.evaluate(node => node.closest('[data-testid="export-card"]')?.style.getPropertyValue('--scene-card-height-scale')),
    '0.85',
    'stored scene card height must be restored on first load',
  )

  // Drag from the avatar at a non-100% card scale and a scaled desktop preview.
  const initial = await card.boundingBox()
  const avatar = await card.locator('.post-avatar img').boundingBox()
  const savedBefore = await position()
  await page.mouse.move(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2)
  await page.mouse.down()
  const client = engine === chromium ? await page.context().newCDPSession(page) : null
  if (client) await client.send('Performance.enable')
  await settleFrame()
  const metricsBefore = client ? await client.send('Performance.getMetrics') : null
  await page.mouse.move(avatar.x + avatar.width / 2 + 50, avatar.y + avatar.height / 2 + 70, { steps: 40 })
  await settleFrame()
  const metricsAfter = client ? await client.send('Performance.getMetrics') : null
  const moving = await card.boundingBox()
  closeTo(moving.x - initial.x, 50, 'horizontal movement follows pointer')
  closeTo(moving.y - initial.y, 70, 'vertical movement follows pointer')
  assert.deepEqual(await position(), savedBefore, 'drag frames must not write persisted app state')
  if (client) {
    const metric = (metrics, name) => metrics.metrics.find(item => item.name === name).value
    const layouts = metric(metricsAfter, 'LayoutCount') - metric(metricsBefore, 'LayoutCount')
    assert.equal(layouts, 0, 'continuous drag must not relayout the card')
    console.log(`40 pointer moves: ${layouts} layouts`)
  }
  await page.mouse.up()
  await settleFrame()
  const dropped = await card.boundingBox()
  closeTo(dropped.x, moving.x, 'no horizontal jump on release')
  closeTo(dropped.y, moving.y, 'no vertical jump on release')
  const savedAfter = await position()
  assert.notDeepEqual(savedAfter, savedBefore)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const restored = await card.boundingBox()
  closeTo(restored.x, dropped.x, 'restored horizontal position')
  closeTo(restored.y, dropped.y, 'restored vertical position')
  assert.equal(
    await card.evaluate(node => node.closest('[data-testid="export-card"]')?.style.getPropertyValue('--scene-card-height-scale')),
    '0.85',
    'stored scene card height must survive reload',
  )

  // Final release coordinates can arrive before another pointermove/frame.
  const quickStart = await card.boundingBox()
  const pointer = { pointerId: 91, isPrimary: true, button: 0, bubbles: true }
  await card.evaluate((node, { pointer, x, y }) => {
    // Synthetic pointers cannot acquire real capture; exercise the same
    // release-before-frame path without depending on OS event coalescing.
    node.setPointerCapture = () => {}
    node.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: x, clientY: y }))
    node.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: x + 15, clientY: y + 12 }))
    delete node.setPointerCapture
  }, { pointer, x: quickStart.x + 30, y: quickStart.y + 30 })
  await settleFrame()
  const quickEnd = await card.boundingBox()
  closeTo(quickEnd.x - quickStart.x, 15, 'release captures final horizontal coordinate')
  closeTo(quickEnd.y - quickStart.y, 12, 'release captures final vertical coordinate')

  // Losing capture must finish the drag, otherwise later gestures stay stuck.
  await card.evaluate((node) => {
    node.addEventListener('pointerdown', event => { window.__dragPointer = event.pointerId }, { once: true })
  })
  await page.mouse.move(quickEnd.x + 30, quickEnd.y + 30)
  await page.mouse.down()
  await page.mouse.move(quickEnd.x + 45, quickEnd.y + 45)
  await settleFrame()
  await card.evaluate(node => node.releasePointerCapture(window.__dragPointer))
  await page.mouse.up()
  await settleFrame()
  assert.equal(await card.evaluate(node => node.classList.contains('post-card-inner-dragging')), false)
  const nextStart = await card.boundingBox()
  await page.mouse.move(nextStart.x + 30, nextStart.y + 30)
  await page.mouse.down()
  await page.mouse.move(nextStart.x + 10, nextStart.y + 10)
  await settleFrame()
  await page.mouse.up()
  await settleFrame()
  const nextEnd = await card.boundingBox()
  closeTo(nextEnd.x - nextStart.x, -20, 'drag resumes after capture loss')
  console.log(`${engine.name()}: scene dragging, release, capture loss and persistence passed.`)
} finally {
  await browser.close()
}
