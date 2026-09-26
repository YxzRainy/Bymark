import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const directory = await mkdtemp(path.join(os.tmpdir(), 'bymark-shared-'))
const servers = []
let browser

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

async function startServer(port, preview = false) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(preview ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    env: { ...process.env, BYMARK_SHARED_STORAGE_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  servers.push(server)
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk })
  server.stderr.on('data', (chunk) => { output += chunk })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${output}`)
    try {
      if ((await fetch(`${url}/__bymark_shared_storage`)).ok) return url
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite did not start: ${output}`)
}

try {
  const firstUrl = await startServer(await availablePort())
  const secondUrl = await startServer(await availablePort())
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const first = await context.newPage()
  await first.route('**/src/main.tsx', (route) => route.abort())
  await first.goto(firstUrl)
  await first.evaluate(async () => {
    const now = new Date().toISOString()
    localStorage.setItem('bymark-settings-v1', JSON.stringify({
      version: 1, updatedAt: now, state: { name: '跨端口作者', text: '来自旧端口的正文' },
    }))
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('bymark-drafts', 2)
      request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' })
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('drafts', 'readwrite')
        transaction.objectStore('drafts').put({
          id: 'legacy-draft', title: '旧端口草稿', text: '旧端口草稿内容',
          state: { name: '跨端口作者', text: '旧端口草稿内容' },
          avatar: null, image: null, sceneImage: null,
          createdAt: now, updatedAt: now, savedAt: now,
        })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  })
  await first.unroute('**/src/main.tsx')
  await first.reload()
  await first.getByLabel('正文', { exact: true }).waitFor()
  assert.equal(await first.getByLabel('正文', { exact: true }).inputValue(), '来自旧端口的正文')
  await first.waitForFunction(async () => (await (await fetch('/__bymark_shared_storage?kind=drafts')).json()).length === 1)

  const second = await context.newPage()
  let fullSnapshotRequests = 0
  await second.route('**/__bymark_shared_storage*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('probe')) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    } else if (route.request().method() === 'GET' && !url.searchParams.has('kind')) {
      fullSnapshotRequests += 1
      await route.abort()
      return
    }
    await route.continue()
  })
  await second.goto(secondUrl, { waitUntil: 'commit' })
  await second.locator('.boot-screen').waitFor()
  assert.equal(await second.locator('.boot-screen').isVisible(), true)
  await second.getByLabel('正文', { exact: true }).waitFor()
  assert.equal(fullSnapshotRequests, 0, 'normal startup must not fetch the full workspace snapshot')
  await second.reload({ waitUntil: 'commit' })
  await second.locator('.boot-screen').waitFor()
  await second.getByLabel('正文', { exact: true }).waitFor()
  assert.equal(fullSnapshotRequests, 0, 'refresh must not fetch the full workspace snapshot')
  assert.equal(await second.getByLabel('正文', { exact: true }).inputValue(), '来自旧端口的正文')
  await second.waitForFunction(() => document.querySelectorAll('.draft-row').length === 1)
  assert.equal(await second.locator('.draft-row').count(), 1)

  await second.getByLabel('正文', { exact: true }).fill('从另一端口修改的正文')
  await second.waitForTimeout(900) // The editor saves draft snapshots after an 800 ms pause.
  await second.waitForFunction(async () => {
    const settings = await (await fetch('/__bymark_shared_storage?kind=settings')).json()
    const drafts = await (await fetch('/__bymark_shared_storage?kind=drafts')).json()
    return settings?.state?.text === '从另一端口修改的正文' && drafts.length === 2 && drafts.some((draft) => draft.state.text === '从另一端口修改的正文')
  })
  await first.reload()
  await first.getByLabel('正文', { exact: true }).waitFor()
  await first.waitForFunction(() => document.querySelectorAll('.draft-row').length === 2)
  assert.equal(await first.getByLabel('正文', { exact: true }).inputValue(), '从另一端口修改的正文')
  assert.equal(await first.locator('.draft-row').count(), 2)

  const previewUrl = await startServer(await availablePort(), true)
  const preview = await context.newPage()
  await preview.goto(previewUrl)
  await preview.getByLabel('正文', { exact: true }).waitFor()
  assert.equal(await preview.getByLabel('正文', { exact: true }).inputValue(), '从另一端口修改的正文')
  await preview.waitForFunction(() => document.querySelectorAll('.draft-row').length === 2)

  await second.evaluate(async () => {
    await fetch('/__bymark_shared_storage', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'drafts', id: 'legacy-draft' }),
    })
  })
  await first.reload()
  await first.waitForFunction(() => document.querySelectorAll('.draft-row').length === 1)
  console.log('Shared storage migration, cross-port updates, preview, and deletion passed.')
} finally {
  if (browser) await browser.close()
  for (const server of servers) server.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
