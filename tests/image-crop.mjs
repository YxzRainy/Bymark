import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

const browserName = process.env.BYMARK_BROWSER || 'chromium';
const browserType = { chromium, webkit }[browserName];
assert.ok(browserType, 'BYMARK_BROWSER must be chromium or webkit.');
const screenshots = path.resolve('test-results', 'image-crop', browserName);
await mkdir(screenshots, { recursive: true });
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const dialog = page.getByRole('dialog', { name: '自由裁剪' });
const opener = page.getByRole('button', { name: '自由裁剪配图' });
const fields = [['x', '左侧'], ['y', '顶部'], ['width', '宽度'], ['height', '高度']];

async function upload(width, height) {
  const buffer = await page.evaluate(([width, height]) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = 'red'; drawing.fillRect(0, 0, width / 2, height);
    drawing.fillStyle = 'blue'; drawing.fillRect(width / 2, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [width, height]);
  await page.getByLabel('选择内容配图').setInputFiles({ name: `crop-${width}x${height}.png`, mimeType: 'image/png', buffer: Buffer.from(buffer, 'base64') });
  await page.waitForFunction(([width, height]) => {
    const image = document.querySelector('#bymark-upload-image')?.closest('.upload-row')?.querySelector('img');
    return image?.complete && image.naturalWidth === width && image.naturalHeight === height;
  }, [width, height]);
}

async function openDialog() {
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await dialog.waitFor();
  const opening = await dialog.evaluate(element => ({ open: element.open, entering: element.querySelector('.image-crop-panel')?.classList.contains('image-crop-panel-enter-active') }));
  assert.ok(opening.open && opening.entering, 'The modal stays open while its entrance animates.');
  await page.waitForFunction(() => {
    const panel = document.querySelector('.image-crop-panel');
    const confirm = panel?.querySelector('.image-crop-confirm');
    return panel && !panel.classList.contains('image-crop-panel-enter-active') && confirm && !confirm.disabled;
  });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'image-crop-title');
}

async function closeDialog(method) {
  if (method === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click();
  else if (method === 'close') await dialog.getByRole('button', { name: '关闭裁剪' }).click();
  else if (method === 'escape') await page.keyboard.press('Escape');
  else if (method === 'backdrop') await page.mouse.click(3, 3);
  else throw new Error(`Unknown close method: ${method}`);
  const closing = await dialog.evaluate(element => ({ open: element.open, closing: element.classList.contains('is-closing'), leaving: element.querySelector('.image-crop-panel')?.classList.contains('image-crop-panel-leave-active') }));
  assert.ok(closing.open && closing.closing && closing.leaving, `${method}: the modal remains open through its exit animation.`);
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '自由裁剪配图', `${method}: focus returns to the crop button.`);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('image-crop-dialog-open')), false);
}

async function readRect() {
  return Object.fromEntries(await Promise.all(fields.map(async ([key, label]) => [key, Number(await dialog.getByLabel(label, { exact: true }).inputValue())])));
}

async function checkRect(width, height) {
  const selected = await readRect();
  assert.ok(selected.x >= 0 && selected.y >= 0 && selected.width >= 1 && selected.height >= 1);
  assert.ok(selected.x + selected.width <= width && selected.y + selected.height <= height, `Selection stays inside ${width}×${height}: ${JSON.stringify(selected)}`);
  return selected;
}

async function checkLayout(visibleViewport) {
  const layout = await dialog.evaluate(element => {
    const image = element.querySelector('.image-crop-surface img');
    const footer = element.querySelector('.image-crop-actions');
    const body = element.querySelector('.image-crop-body');
    const bounds = target => target.getBoundingClientRect().toJSON();
    const panel = element.querySelector('.image-crop-panel');
    return {
      bounds: bounds(element),
      viewport: { width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight, top: visualViewport?.offsetTop ?? 0 },
      stage: bounds(element.querySelector('.image-crop-stage')),
      surface: bounds(element.querySelector('.image-crop-surface')),
      image: bounds(image), natural: { width: image.naturalWidth, height: image.naturalHeight },
      footer: bounds(footer),
      body: { width: body.clientWidth, scrollWidth: body.scrollWidth, height: body.clientHeight, scrollHeight: body.scrollHeight, overflow: getComputedStyle(body).overflowY },
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      buttons: [...footer.querySelectorAll('button')].map(button => ({ height: bounds(button).height, whiteSpace: getComputedStyle(button).whiteSpace })),
    };
  });
  const { bounds, surface, image, natural, footer, stage } = layout;
  const viewport = visibleViewport || layout.viewport;
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 1, 'Dialog is horizontally centered.');
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.top - viewport.height / 2) <= 1, 'Dialog is vertically centered.');
  assert.ok(bounds.x >= -1 && bounds.right <= viewport.width + 1 && bounds.y >= viewport.top - 1 && bounds.bottom <= viewport.top + viewport.height + 1, 'Dialog fits the visible viewport.');
  assert.ok(layout.panelOverflow <= 1 && layout.body.scrollWidth <= layout.body.width + 1, 'Dialog has no horizontal overflow.');
  assert.ok(Math.abs(surface.width - image.width) <= 0.05 && Math.abs(surface.height - image.height) <= 0.05, 'Image and selection share the same displayed bounds.');
  assert.ok(surface.width <= stage.width + 0.05 && surface.height <= stage.height + 0.05, 'Extreme aspect ratios fit the stage.');
  const aspectError = natural.width >= natural.height ? Math.abs(image.height - image.width * natural.height / natural.width) : Math.abs(image.width - image.height * natural.width / natural.height);
  assert.ok(aspectError <= 0.05, `Image preserves its aspect ratio, including subpixel edges: ${aspectError}`);
  assert.ok(footer.bottom <= viewport.top + viewport.height + 1 && footer.top >= viewport.top, 'Footer stays reachable in short viewports.');
  assert.ok(layout.buttons.every(button => button.height <= 50 && button.whiteSpace === 'nowrap'), 'Action labels stay on one line.');
  if (layout.body.scrollHeight > layout.body.height + 1) assert.equal(layout.body.overflow, 'auto', 'A short viewport scrolls the form body.');
}

async function imagePixels(width, height, expected) {
  await page.waitForFunction(([width, height]) => {
    const image = document.querySelector('.post-image-wrap img');
    return image?.complete && image.naturalWidth === width && image.naturalHeight === height;
  }, [width, height]);
  const actual = await page.locator('.post-image-wrap img').first().evaluate(image => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0);
    return [[0, 0], [canvas.width - 1, canvas.height - 1]].map(([x, y]) => [...drawing.getImageData(x, y, 1, 1).data]);
  });
  assert.deepEqual(actual, expected, 'Displayed image retains the expected opaque source pixels.');
}

async function checkTouchDrag() {
  // Chromium's device input sends real pointer capture events, including a
  // secondary finger lifting while the primary drag is still active.
  const input = await context.newCDPSession(page);
  await dialog.getByLabel('宽度', { exact: true }).fill('100');
  await dialog.getByLabel('高度', { exact: true }).fill('75');
  const selection = await page.locator('.image-crop-selection').boundingBox();
  const surface = await page.locator('.image-crop-surface').boundingBox();
  const first = { id: 1, x: selection.x + selection.width / 2, y: selection.y + selection.height / 2 };
  const second = { id: 2, x: surface.x + surface.width - 10, y: surface.y + surface.height - 10 };
  const touch = (type, touchPoints) => input.send('Input.dispatchTouchEvent', { type, touchPoints });
  try {
    await touch('touchStart', [first]);
    first.x += 20;
    await touch('touchMove', [first]);
    const primary = await checkRect(200, 150);
    assert.ok(primary.x > 0, 'A finger can drag the selection.');
    await touch('touchStart', [first, second]);
    second.x -= 10;
    await touch('touchMove', [first, second]);
    assert.deepEqual(await readRect(), primary, 'The secondary finger does not move or replace the selection.');
    // CDP's touchEnd points are the fingers ending, not the ones remaining.
    await touch('touchEnd', [second]);
    first.x += 20;
    await touch('touchMove', [first]);
    await page.waitForFunction(previousX => Number(document.querySelector('.image-crop-fields input').value) > previousX, primary.x);
    assert.ok((await checkRect(200, 150)).x > primary.x, 'The primary drag continues after the secondary finger lifts.');
  } finally {
    await touch('touchEnd', []);
    await input.detach();
  }
}

try {
  await page.route('**/__bymark_shared_storage**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(process.env.BYMARK_URL || 'http://localhost:5174/');
  await page.getByLabel('正文', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '版式', exact: true }).click();
  await upload(400, 300);

  // Every dismissal preserves uploaded dimensions and pixels.
  for (const method of ['cancel', 'close', 'escape', 'backdrop']) {
    await openDialog(); await checkLayout();
    await dialog.getByLabel('宽度', { exact: true }).fill('200');
    await dialog.getByLabel('高度', { exact: true }).fill('150');
    if (method === 'cancel') await page.screenshot({ path: path.join(screenshots, 'desktop.png') });
    await closeDialog(method);
    await imagePixels(400, 300, [[255, 0, 0, 255], [0, 0, 255, 255]]);
  }

  await openDialog();
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    await dialog.getByRole('button', { name: '重置选区' }).click();
    const handle = await page.locator(`.image-crop-${corner}`).boundingBox();
    const surface = await page.locator('.image-crop-surface').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.includes('w') ? surface.x + surface.width + 40 : surface.x - 40, corner.includes('n') ? surface.y + surface.height + 40 : surface.y - 40);
    await page.mouse.up(); await checkRect(400, 300);
  }
  await dialog.getByLabel('左侧', { exact: true }).fill('99999');
  await dialog.getByLabel('顶部', { exact: true }).fill('99999');
  await dialog.getByLabel('宽度', { exact: true }).fill('99999');
  await dialog.getByLabel('高度', { exact: true }).fill('-5');
  assert.deepEqual(await checkRect(400, 300), { x: 399, y: 299, width: 1, height: 1 });

  // Drag beyond the bottom/right and crop the original's blue half.
  await dialog.getByRole('button', { name: '重置选区' }).click();
  await dialog.getByLabel('宽度', { exact: true }).fill('200');
  await dialog.getByLabel('高度', { exact: true }).fill('150');
  const selection = await page.locator('.image-crop-selection').boundingBox();
  const surface = await page.locator('.image-crop-surface').boundingBox();
  await page.mouse.move(selection.x + selection.width / 2, selection.y + selection.height / 2);
  await page.mouse.down(); await page.mouse.move(surface.x + surface.width + 80, surface.y + surface.height + 80); await page.mouse.up();
  assert.deepEqual(await checkRect(400, 300), { x: 200, y: 150, width: 200, height: 150 });
  await dialog.getByRole('button', { name: '确认裁剪' }).click();
  await dialog.waitFor({ state: 'detached' });
  await imagePixels(200, 150, [[0, 0, 255, 255], [0, 0, 255, 255]]);
  assert.equal(await page.locator('.post-image-wrap').first().evaluate(element => getComputedStyle(element).boxShadow), 'none');
  await page.locator('.draft-status').filter({ hasText: '已保存' }).waitFor();
  await page.reload();
  await imagePixels(200, 150, [[0, 0, 255, 255], [0, 0, 255, 255]]);
  await page.getByRole('tab', { name: '版式', exact: true }).click();

  if (browserName === 'chromium') {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDialog(); await checkTouchDrag(); await closeDialog('cancel');
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 640, height: 320 }]) {
    await page.setViewportSize(viewport); await openDialog(); await checkLayout();
    await dialog.getByLabel('高度', { exact: true }).scrollIntoViewIfNeeded(); await checkLayout();
    await page.screenshot({ path: path.join(screenshots, `viewport-${viewport.width}x${viewport.height}.png`) });
    await closeDialog('escape');
  }

  // Use the app's visual viewport variables to simulate a raised keyboard.
  await page.setViewportSize({ width: 390, height: 844 }); await openDialog();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--bymark-visual-viewport-height', '420px');
    document.documentElement.style.setProperty('--bymark-visual-viewport-top', '100px');
  });
  await checkLayout({ width: 390, height: 420, top: 100 });
  await dialog.getByLabel('高度', { exact: true }).scrollIntoViewIfNeeded();
  await checkLayout({ width: 390, height: 420, top: 100 });
  await page.screenshot({ path: path.join(screenshots, 'keyboard-viewport.png') });
  await closeDialog('escape');
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--bymark-visual-viewport-height');
    document.documentElement.style.removeProperty('--bymark-visual-viewport-top');
  });

  await page.setViewportSize({ width: 320, height: 640 });
  for (const [width, height] of [[4000, 10], [1, 1000]]) {
    await upload(width, height); await openDialog(); await checkLayout();
    assert.deepEqual(await readRect(), { x: 0, y: 0, width, height });
    await page.screenshot({ path: path.join(screenshots, `source-${width}x${height}.png`) });
    await closeDialog('close');
  }
  assert.deepEqual(pageErrors, [], 'Cropping causes no unhandled browser errors.');
  console.log(`Image crop (${browserName}): animated dismissals, centering, focus, bounds, exact pixels, refresh, narrow/landscape/keyboard layouts and extreme aspect ratios passed. Screenshots: ${screenshots}`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
