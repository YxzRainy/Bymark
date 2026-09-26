import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const baseURL = process.env.BYMARK_URL || 'http://127.0.0.1:5174'
const artifacts = path.resolve('test-results', 'export-consistency')
await mkdir(artifacts, { recursive: true })

const browser = await chromium.launch({ headless: true })

async function exportFrom(viewport, label) {
  const context = await browser.newContext({
    viewport,
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    acceptDownloads: true,
  })
  await context.route('**/__bymark_shared_storage*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  )
  await context.route('https://api.github.com/repos/YxzRainy/Bymark/releases/latest', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tag_name: 'v0.1.0', html_url: 'https://github.com/YxzRainy/Bymark/releases' }),
    }),
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.addInitScript(() => {
    localStorage.setItem('bymark-settings-v1', JSON.stringify({
      visualStyle: 'folio',
      canvasStyle: 'scene',
      theme: 'white',
      ratio: '3:4',
      sceneCardRatio: '4:3',
      text: 'Export metric labels',
      socialReplies: '11',
      socialReposts: '13',
      socialLikes: '1.3K',
      socialViews: '17K',
    }))
    window.__exportSourceMetrics = []
    window.__exportCloneMetrics = []
    window.__previewMetricFontSizes = []
    const serializeToString = XMLSerializer.prototype.serializeToString
    XMLSerializer.prototype.serializeToString = function serializeExport(node) {
      const serialized = serializeToString.call(this, node)
      if (serialized.includes('post-social-actions')) {
        const document = new DOMParser().parseFromString(serialized, 'image/svg+xml')
        window.__exportCloneMetrics = Array.from(document.querySelectorAll('.post-social-actions b')).map((metric) => ({
          text: metric.textContent,
          style: metric.getAttribute('style') ?? '',
        }))
      }
      return serialized
    }
    new MutationObserver(() => {
      const card = document.querySelector('[data-export-render-card]')
      if (!card || window.__exportSourceMetrics.length) return
      const style = getComputedStyle(card)
      window.__exportSourceMetrics.push({
        width: card.clientWidth,
        height: card.clientHeight,
        transform: style.transform,
        transitionDuration: style.transitionDuration,
        metricFontSizes: Array.from(card.querySelectorAll('.post-social-actions b'))
          .map((metric) => getComputedStyle(metric).fontSize),
      })
    }).observe(document, { childList: true, subtree: true })
  })

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="export-card"]').waitFor({ state: 'attached' })
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    window.__previewMetricFontSizes = Array.from(document.querySelectorAll('[data-testid="export-card"] .post-social-actions b'))
      .map((metric) => getComputedStyle(metric).fontSize)
  })
  const previewMarkup = await page.locator('[data-testid="export-card"]').evaluate((node) => node.outerHTML)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.export-button').click(),
  ])
  const outputPath = path.join(artifacts, `${label}.png`)
  await download.saveAs(outputPath)
  if (await download.failure()) throw new Error(`${label} export failed: ${await download.failure()}`)

  const sourceMetrics = await page.evaluate(() => window.__exportSourceMetrics)
  const cloneMetrics = await page.evaluate(() => window.__exportCloneMetrics)
  const previewMetricFontSizes = await page.evaluate(() => window.__previewMetricFontSizes)
  const bytes = await readFile(outputPath)
  await context.close()
  return {
    bytes,
    errors,
    previewMarkup,
    sourceMetrics,
    cloneMetrics,
    previewMetricFontSizes,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

try {
  const desktop = await exportFrom({ width: 1440, height: 1000 }, 'desktop')
  const mobile = await exportFrom({ width: 390, height: 844 }, 'mobile')

  if (desktop.errors.length || mobile.errors.length) {
    throw new Error(`runtime errors: ${[...desktop.errors, ...mobile.errors].join(' | ')}`)
  }
  if (desktop.previewMarkup !== mobile.previewMarkup) {
    throw new Error('mobile and desktop previews do not share identical card markup')
  }
  for (const [label, result] of [['desktop', desktop], ['mobile', mobile]]) {
    const source = result.sourceMetrics[0]
    if (!source || source.width !== 800 || source.height !== 1067 || source.transform !== 'none') {
      throw new Error(`${label} did not render from the fixed desktop canvas: ${JSON.stringify(source)}`)
    }
    if (result.width !== 1536 || result.height !== 2048) {
      throw new Error(`${label} export dimensions are ${result.width}x${result.height}`)
    }
    const metricValues = result.cloneMetrics.map((metric) => metric.text)
    const stableMetricWidths = result.cloneMetrics.every((metric) => {
      const minWidth = metric.style.match(/min-width: ([\d.]+)px/)?.[1]
      return Number(minWidth) >= 54
    })
    const clonedMetricFontSizes = result.cloneMetrics.map((metric) =>
      metric.style.match(/font: [^;]*?([\d.]+)px\s*\//)?.[1],
    )
    if (
      metricValues.join('|') !== '11|13|1.3K|17K' ||
      !stableMetricWidths ||
      result.previewMetricFontSizes.some((size) => size !== '12px') ||
      source.metricFontSizes.some((size) => size !== '12px') ||
      clonedMetricFontSizes.some((size) => size !== '12')
    ) {
      throw new Error(`${label} export changed social metric sizing: ${JSON.stringify({
        preview: result.previewMetricFontSizes,
        source: source.metricFontSizes,
        clone: result.cloneMetrics,
      })}`)
    }
  }
  if (!desktop.bytes.equals(mobile.bytes)) {
    throw new Error(`viewport-dependent export: desktop=${desktop.sha256}, mobile=${mobile.sha256}`)
  }

  console.log(`Desktop/mobile preview markup matches; exported PNG bytes match (${desktop.sha256}).`)
} finally {
  await browser.close()
}
