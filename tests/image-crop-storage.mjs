import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const targetUrl = process.env.BYMARK_URL || 'http://localhost:5174/';
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
const crop = { x: 50, y: 30, width: 200, height: 150 };
const expectedPixels = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 128, 0, 255], [255, 215, 0, 255]];

async function fixture(title) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/__bymark_shared_storage**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(targetUrl);
  await page.getByLabel('正文', { exact: true }).fill(`${title}\n用于验证完整配图快照。`);
  await page.getByRole('button', { name: '作品标题 可选', exact: true }).click();
  await page.getByLabel('作品标题', { exact: true }).fill(title);
  await page.getByRole('tab', { name: '版式', exact: true }).click();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    for (const [color, x, y] of [['red', 0, 0], ['blue', 200, 0], ['green', 0, 150], ['gold', 200, 150]]) {
      ctx.fillStyle = color; ctx.fillRect(x, y, 200, 150);
    }
    return canvas.toDataURL().split(',')[1];
  });
  await page.getByLabel('选择内容配图').setInputFiles({ name: 'quadrants.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  await page.waitForFunction(() => !document.querySelector('#bymark-upload-image').disabled && document.querySelector('.post-image-wrap img')?.naturalWidth === 400);
  await page.getByRole('button', { name: `使用草稿：${title}`, exact: true }).waitFor();
  return { page, context };
}

async function openCrop(page) {
  await page.getByRole('button', { name: '自由裁剪配图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '自由裁剪', exact: true });
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector('.image-crop-confirm').disabled);
  for (const [label, value] of [['左侧', crop.x], ['顶部', crop.y], ['宽度', crop.width], ['高度', crop.height]]) {
    await dialog.getByLabel(label, { exact: true }).fill(String(value));
  }
  return dialog;
}

async function assertImage(page, width = crop.width, height = crop.height) {
  await page.waitForFunction(({ width, height }) => {
    const img = document.querySelector('.post-image-wrap img');
    return img?.complete && img.naturalWidth === width && img.naturalHeight === height;
  }, { width, height });
  if (width !== crop.width || height !== crop.height) return;
  const pixels = await page.locator('.post-image-wrap img').first().evaluate((img) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return [[10, 10], [180, 10], [10, 140], [180, 140]].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  });
  assert.deepEqual(pixels, expectedPixels, 'Crop preserves the selected source pixels.');
}

// Abort actual IndexedDB transactions, exercising transaction completion and
// rejection handling rather than replacing the app's persistence functions.
async function installFaults(page) {
  await page.evaluate(() => {
    window.__cropFaults = { failAsset: 0, failDraft: 0, assetWrites: 0, draftWrites: 0, encodingCalls: 0, failEncoding: 0, holdEncoding: false, releaseEncoding: null };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const faults = window.__cropFaults;
      const asset = this.transaction.db.name === 'bymark-local-assets' && args[1] === 'bymark-image-v1';
      const draft = this.transaction.db.name === 'bymark-drafts' && this.name === 'drafts';
      if (asset) faults.assetWrites += 1;
      if (draft) faults.draftWrites += 1;
      const fail = asset && faults.failAsset > 0 ? 'failAsset' : draft && faults.failDraft > 0 ? 'failDraft' : null;
      const request = put.apply(this, args);
      if (fail) {
        faults[fail] -= 1;
        // The request succeeds before the transaction aborts. Resolving on
        // request.onsuccess would incorrectly dismiss the crop dialog.
        request.addEventListener('success', () => this.transaction.abort(), { once: true });
      }
      return request;
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      const faults = window.__cropFaults;
      faults.encodingCalls += 1;
      if (faults.failEncoding > 0) {
        faults.failEncoding -= 1;
        queueMicrotask(() => callback(null));
        return;
      }
      toBlob.call(this, (blob) => {
        if (faults.holdEncoding) faults.releaseEncoding = () => callback(blob);
        else callback(blob);
      }, ...args);
    };
  });
}

async function assertRetryableFailure(dialog) {
  await dialog.locator('[role="alert"]').waitFor();
  assert.match(await dialog.locator('[role="alert"]').textContent(), /失败.*重试/);
  assert.equal(await dialog.isVisible(), true, 'Failure keeps the native modal open.');
  assert.equal(await dialog.locator('.image-crop-confirm').isEnabled(), true, 'Failure enables retry.');
  assert.equal(await dialog.getByLabel('宽度', { exact: true }).inputValue(), String(crop.width));
  assert.equal(await dialog.getByLabel('高度', { exact: true }).inputValue(), String(crop.height));
}

try {
  {
    const { page, context } = await fixture('裁剪持久化');
    const dialog = await openCrop(page);
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    // Reload immediately when the close animation ends: no autosave delay.
    await page.reload();
    await assertImage(page);
    await page.getByRole('button', { name: '新建草稿', exact: true }).click();
    await page.getByLabel('正文', { exact: true }).fill('另一个草稿\n这份草稿没有配图。');
    await page.waitForFunction(() => document.querySelector('.draft-row-active .draft-summary')?.textContent.includes('另一个草稿'));
    assert.equal(await page.locator('.post-image-wrap img').count(), 0);
    await page.getByRole('button', { name: '使用草稿：裁剪持久化', exact: true }).click();
    await assertImage(page);
    assert.equal(await page.getByLabel('正文', { exact: true }).inputValue(), '裁剪持久化\n用于验证完整配图快照。');
    await context.close();
    console.log('Image crop storage: immediate reload and draft restore preserve dimensions and pixels.');
  }
  for (const [fault, title] of [['failAsset', '配图写入故障'], ['failDraft', '草稿写入故障']]) {
    const { page, context } = await fixture(title);
    await installFaults(page);
    const dialog = await openCrop(page);
    await page.evaluate((key) => { window.__cropFaults[key] = 1; }, fault);
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await assertRetryableFailure(dialog);
    assert.equal(await page.evaluate((key) => window.__cropFaults[key], fault), 0, 'The real persistence transaction was aborted.');
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await page.evaluate(() => window.__cropFaults.assetWrites) >= 2, 'Retry writes even an unchanged cropped data URL.');
    await page.reload();
    await assertImage(page);
    await context.close();
    console.log(`Image crop storage: ${fault} keeps modal open and retries the same result successfully.`);
  }
  {
    const { page, context } = await fixture('保存期间防重复');
    await installFaults(page);
    const dialog = await openCrop(page);
    await page.evaluate(() => { window.__cropFaults.holdEncoding = true; });
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await page.waitForFunction(() => typeof window.__cropFaults.releaseEncoding === 'function');
    assert.equal(await dialog.locator('.image-crop-panel').getAttribute('aria-busy'), 'true');
    for (const name of ['取消', '关闭裁剪', '重置选区', '保存中…']) {
      assert.equal(await dialog.getByRole('button', { name, exact: true }).isDisabled(), true);
    }
    assert.equal(await dialog.getByLabel('宽度', { exact: true }).isDisabled(), true);
    // Disabled native clicks plus direct events cover both UI and handler guards.
    await dialog.locator('.image-crop-confirm').evaluate((button) => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((button) => { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.evaluate(() => window.__cropFaults.encodingCalls), 1, 'Busy ignores repeated submission.');
    assert.equal(await page.evaluate(() => window.__cropFaults.assetWrites), 0, 'Encoding still waits before any persistence.');
    await page.evaluate(() => { window.__cropFaults.holdEncoding = false; window.__cropFaults.releaseEncoding(); });
    await dialog.waitFor({ state: 'detached' });
    await assertImage(page);
    assert.equal(await page.evaluate(() => window.__cropFaults.assetWrites), 1);
    await context.close();
    console.log('Image crop storage: busy prevents cancellation, backdrop/Escape close, edits and duplicate submission.');
  }
  {
    const { page, context } = await fixture('画布导出故障');
    await installFaults(page);
    const dialog = await openCrop(page);
    await page.evaluate(() => { window.__cropFaults.failEncoding = 1; });
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await assertRetryableFailure(dialog);
    await assertImage(page, 400, 300);
    assert.equal(await page.evaluate(() => window.__cropFaults.assetWrites), 0);
    await dialog.getByRole('button', { name: '确认裁剪', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await assertImage(page);
    await context.close();
    console.log('Image crop storage: failed canvas encoding preserves the source and allows retry.');
  }
  {
    const { page, context } = await fixture('图片加载故障');
    const dialog = await openCrop(page);
    await dialog.locator('.image-crop-surface img').evaluate((img) => { img.src = 'data:image/png;base64,broken'; });
    await dialog.locator('[role="alert"]').waitFor();
    assert.match(await dialog.locator('[role="alert"]').textContent(), /图片加载失败/);
    assert.equal(await dialog.locator('.image-crop-confirm').isDisabled(), true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await assertImage(page, 400, 300);
    await context.close();
    console.log('Image crop storage: source loading failure disables confirmation and can close safely.');
  }
  assert.deepEqual(pageErrors, [], 'Storage and encoding failures must not cause unhandled errors.');
} finally {
  await browser.close();
}
