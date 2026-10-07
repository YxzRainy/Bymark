import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'
const browserName = process.env.BYMARK_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true })
const artifacts = path.resolve('test-results', 'image-scaling', browserName)
const cardSelector = '.preview-panel [data-testid="export-card"]:not([data-pagination-probe])'
const copyText = '在这里留下你的文字。'
const closeTo = (actual, expected, label, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)

async function geometry(page) {
  return page.locator(cardSelector).evaluate((card) => {
    const inner = card.querySelector('.post-card-inner')
    const content = card.querySelector('.post-content')
    const copy = card.querySelector('.post-copy')
    const frame = card.querySelector('.post-image-wrap')
    const image = frame?.querySelector('img')
    const actions = card.querySelector('.post-social-actions')
    const rootBounds = card.getBoundingClientRect()
    const scale = rootBounds.width / card.clientWidth
    const bounds = (node) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        top: (rect.top - rootBounds.top) / scale,
        bottom: (rect.bottom - rootBounds.top) / scale,
        left: (rect.left - rootBounds.left) / scale,
        right: (rect.right - rootBounds.left) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
      }
    }
    return {
      canvasHeight: card.clientHeight,
      inner: bounds(inner),
      content: bounds(content),
      copy: { ...bounds(copy), text: copy.textContent, scrollHeight: copy.scrollHeight, clientHeight: copy.clientHeight },
      frame: bounds(frame),
      image: bounds(image),
      naturalWidth: image?.naturalWidth,
      naturalHeight: image?.naturalHeight,
      actions: bounds(actions),
      childOrder: [...content.children].map((node) => node.classList.contains('post-image-wrap') ? 'image' : 'copy'),
    }
  })
}

function verifyFit(result, label) {
  assert.equal(result.copy.text, copyText, `${label}: complete copy`)
  assert.ok(result.copy.scrollHeight <= result.copy.clientHeight + 1, `${label}: copy is not clipped`)
  assert.ok(result.frame.width > 0 && result.frame.height > 0, `${label}: visible image`)
  closeTo(result.frame.width / result.frame.height, result.naturalWidth / result.naturalHeight, `${label}: original aspect ratio`, 0.02)
  closeTo(result.image.width, result.frame.width, `${label}: image fills frame width`)
  closeTo(result.image.height, result.frame.height, `${label}: image fills frame height`)
  assert.ok(result.inner.top >= -1 && result.inner.bottom <= result.canvasHeight + 1, `${label}: card fits canvas`)
  assert.ok(result.frame.left >= result.content.left - 1 && result.frame.right <= result.content.right + 1, `${label}: image fits content width`)
  assert.ok(result.frame.bottom <= result.actions.top + 1, `${label}: image does not overlap actions`)
  assert.ok(result.copy.bottom <= result.actions.top + 1, `${label}: copy does not overlap actions`)
  if (result.childOrder[0] === 'copy') {
    assert.ok(result.copy.bottom <= result.frame.top + 1, `${label}: image follows copy`)
  } else {
    assert.ok(result.frame.bottom <= result.copy.top + 1, `${label}: image precedes copy`)
  }
}

async function settle(page) {
  await page.waitForFunction((selector) => {
    const card = document.querySelector(selector)
    const image = card?.querySelector('.post-image-wrap img')
    return image?.complete && image.naturalWidth > 0 && !document.querySelector('[data-pagination-probe]')
  }, cardSelector)
  // Resize observers and image-load measurement must finish before checking
  // a range limit or persisting the final chosen scale.
  let previous
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await geometry(page)
    const signature = JSON.stringify([current.inner, current.frame, current.copy.clientHeight])
    if (signature === previous) return current
    previous = signature
    await page.waitForTimeout(60)
  }
  throw new Error('Image layout did not settle')
}

async function fixture(page, width, height) {
  const dataURL = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.fillStyle = 'rgb(220, 75, 253)'
    context.fillRect(0, 0, width, height)
    return canvas.toDataURL('image/png')
  }, { width, height })
  return { name: `fixture-${width}x${height}.png`, mimeType: 'image/png', buffer: Buffer.from(dataURL.split(',')[1], 'base64') }
}

async function upload(page, file, width, height) {
  await page.getByLabel('选择内容配图').setInputFiles(file)
  await page.waitForFunction(({ selector, width, height }) => {
    const image = document.querySelector(selector)?.querySelector('.post-image-wrap img')
    return image?.naturalWidth === width && image.naturalHeight === height
  }, { selector: cardSelector, width, height })
  return settle(page)
}

async function changeScale(page, requested) {
  const range = page.locator('#bymark-image-scale')
  const maximum = Number(await range.getAttribute('max'))
  const effective = Math.min(requested, maximum)
  await range.fill(String(effective))
  await page.waitForFunction((expected) => Number(document.querySelector('#bymark-image-scale')?.value) === expected, effective)
  return { effective, maximum, result: await settle(page) }
}

async function exportedImageBounds(page, bytes) {
  return page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4
        if (Math.abs(pixels[offset] - 220) <= 4 && Math.abs(pixels[offset + 1] - 75) <= 4 && Math.abs(pixels[offset + 2] - 253) <= 4) {
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
        }
      }
    }
    return { pngWidth: canvas.width, pngHeight: canvas.height, width: right - left + 1, height: bottom - top + 1 }
  }, bytes.toString('base64'))
}

try {
  await mkdir(artifacts, { recursive: true })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true, deviceScaleFactor: 1 })
    try {
      await context.route('**/__bymark_shared_storage*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
      await context.route('https://api.github.com/repos/YxzRainy/Bymark/releases/latest', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
      await context.addInitScript(({ copyText }) => {
        if (!localStorage.getItem('bymark-settings-v1')) {
          localStorage.setItem('bymark-settings-v1', JSON.stringify({ version: 1, state: {
            text: copyText, visualStyle: 'folio', canvasStyle: 'scene', theme: 'white', ratio: '3:4',
            sceneCardRatio: '4:3', sceneCardHeight: 60, sceneCardPadding: 40,
            sceneCardScale: 100, sceneCardX: 50, sceneCardY: 50,
            imageScale: 126, imageAlignment: 'center', imagePosition: 'below',
          } }))
        }
        window.__imageExportGeometry = []
        const serialize = XMLSerializer.prototype.serializeToString
        XMLSerializer.prototype.serializeToString = function (node) {
          const serialized = serialize.call(this, node)
          if (serialized.includes('post-image-wrap')) {
            const source = document.querySelector('[data-export-render-card] .post-image-wrap')
            const clone = new DOMParser().parseFromString(serialized, 'image/svg+xml').querySelector('.post-image-wrap')
            if (source && clone) {
              const style = getComputedStyle(source)
              const cloneStyle = clone.getAttribute('style') || ''
              const dimension = (name) => Number(cloneStyle.match(new RegExp(`(?:^|;)\\s*${name}:\\s*([\\d.]+)px`))?.[1])
              window.__imageExportGeometry.push({
                width: Number.parseFloat(style.width), height: Number.parseFloat(style.height),
                cloneWidth: dimension('width'), cloneHeight: dimension('height'),
              })
            }
          }
          return serialized
        }
      }, { copyText })
      const page = await context.newPage()
      const errors = []
      let phase = 'initial load'
      page.on('pageerror', (error) => errors.push(`${phase}: ${error.message}`))
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
      await page.locator(cardSelector).waitFor({ state: 'attached' })
      await page.getByRole('tab', { name: '版式', exact: true }).click()
      const initialCenter = await page.locator(cardSelector).evaluate((card) => {
        const root = card.getBoundingClientRect()
        const inner = card.querySelector('.post-card-inner').getBoundingClientRect()
        return ((inner.top + inner.bottom) / 2 - root.top) / (root.width / card.clientWidth)
      })
      const square = await fixture(page, 600, 600)
      const portrait = await fixture(page, 400, 600)
      const landscape = await fixture(page, 960, 540)
      phase = 'insert square'
      const initial = await upload(page, square, 600, 600)
      await page.getByRole('button', { name: /^图片布局/ }).click()
      assert.equal(await page.locator('#bymark-image-scale').inputValue(), '126', 'inserting a square image preserves default scale')
      assert.ok(Number(await page.locator('#bymark-image-scale').getAttribute('max')) > 126, 'short X cards must not lock the scale slider at 80%')
      assert.ok(initial.frame.width > 250, `initial square image is useful at ${viewport.width}px: ${JSON.stringify(initial.frame)}`)
      verifyFit(initial, 'initial square')
      closeTo((initial.inner.top + initial.inner.bottom) / 2, initialCenter, 'inserting an image preserves the card center')

      let previous
      for (const requested of [80, 100, 126, 160]) {
        phase = `scale square ${requested}%`
        const { effective, maximum, result } = await changeScale(page, requested)
        verifyFit(result, `square ${effective}%`)
        assert.ok(effective > 80 || requested === 80, `square enlargement is available: max=${maximum}`)
        if (previous && effective > previous.effective) {
          assert.ok(result.frame.width > previous.result.frame.width + 1 && result.frame.height > previous.result.frame.height + 1, `square ${requested}% enlarges the actual image`)
        }
        closeTo((result.inner.top + result.inner.bottom) / 2, initialCenter, `square ${effective}% preserves card center`)
        previous = { effective, result }
      }
      phase = 'move image above copy'
      await page.getByRole('button', { name: '文字上方', exact: true }).click()
      const above = await settle(page)
      assert.deepEqual(above.childOrder, ['image', 'copy'])
      verifyFit(above, 'above copy')
      phase = 'move image below copy'
      await page.getByRole('button', { name: '文字下方', exact: true }).click()
      assert.deepEqual((await settle(page)).childOrder, ['copy', 'image'])

      phase = 'replace with portrait'
      await upload(page, portrait, 400, 600)
      const portraitScale = await changeScale(page, 126)
      assert.equal(portraitScale.effective, 126, 'portrait replacement permits a useful scale')
      verifyFit(portraitScale.result, 'portrait replacement')
      phase = 'replace with landscape'
      await upload(page, landscape, 960, 540)
      assert.equal(await page.locator('#bymark-image-scale').inputValue(), '126', 'landscape replacement preserves the selected scale before further edits')
      const landscapeScale = await changeScale(page, 160)
      assert.equal(landscapeScale.effective, 160, 'landscape replacement releases the portrait limit')
      verifyFit(landscapeScale.result, 'landscape replacement')
      phase = 'replace with square'
      await upload(page, square, 600, 600)
      assert.equal(await page.locator('#bymark-image-scale').inputValue(), '160', 'square replacement does not inherit a stale portrait clamp')
      const final = await changeScale(page, 126)
      assert.equal(final.effective, 126, 'square replacement does not retain a stale aspect-ratio clamp')
      verifyFit(final.result, 'final square')

      await page.waitForFunction(() => {
        const state = JSON.parse(localStorage.getItem('bymark-settings-v1') || '{}').state
        return state?.imageScale === 126 && state.imagePosition === 'below' && state.sceneCardHeight === 60
      })
      phase = 'reload'
      await page.reload({ waitUntil: 'domcontentloaded' })
      const restored = await settle(page)
      verifyFit(restored, 'reloaded square')
      closeTo(restored.frame.width, final.result.frame.width, 'image width survives reload')
      closeTo(restored.frame.height, final.result.frame.height, 'image height survives reload')
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bymark-settings-v1')).state)
      assert.equal(saved.imageScale, 126)
      assert.equal(saved.sceneCardHeight, 60, 'automatic card growth does not overwrite configured minimum height')

      if (viewport.width < 1024) await page.getByRole('tab', { name: '预览', exact: true }).click()
      await page.locator(cardSelector).screenshot({ path: path.join(artifacts, `${viewport.width}-preview.png`) })
      if (viewport.width < 1024) await page.getByRole('tab', { name: '编辑', exact: true }).click()
      phase = 'export'
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.export-button').click()])
      const pngPath = path.join(artifacts, `${viewport.width}-export.png`)
      await download.saveAs(pngPath)
      assert.equal(await download.failure(), null)
      const exportGeometry = await page.evaluate(() => window.__imageExportGeometry)
      assert.ok(exportGeometry.length > 0, 'export serialization records the final image geometry')
      for (const result of exportGeometry) {
        closeTo(result.width, restored.frame.width, 'export source width matches preview')
        closeTo(result.height, restored.frame.height, 'export source height matches preview')
        closeTo(result.cloneWidth, result.width, 'export clone width matches source')
        closeTo(result.cloneHeight, result.height, 'export clone height matches source')
      }
      // WebKit currently drops raster images during this app's SVG export,
      // including ordinary Bymark cards without adaptive sizing. Keep its
      // sizing regression checks on preview and final source/clone geometry.
      if (browserName === 'chromium') {
        const raster = await exportedImageBounds(page, await readFile(pngPath))
        assert.ok(raster.width > 0 && raster.height > 0, 'PNG contains the uploaded image')
        const exportScale = raster.pngWidth / 800
        closeTo(raster.width, restored.frame.width * exportScale, 'PNG image width matches preview', 3)
        closeTo(raster.height, restored.frame.height * exportScale, 'PNG image height matches preview', 3)
      }
      assert.deepEqual(errors, [], `runtime errors at ${viewport.width}px`)
      console.log(`${browserName} ${viewport.width}px: image enlargement, replacements, placement, fit, persistence, and export ${browserName === 'chromium' ? 'PNG pixels' : 'source/clone geometry'} passed.`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
