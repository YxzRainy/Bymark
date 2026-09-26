import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

const configuredUrl = process.env.BYMARK_URL
let targetUrl = configuredUrl || 'http://127.0.0.1:5174'
let localServer

async function hasServer(url) {
  try {
    const response = await fetch(url)
    return response.ok && (await response.text()).includes('<title>留印</title>')
  } catch {
    return false
  }
}

async function startLocalServer() {
  const dist = path.resolve('dist')
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
  }
  localServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!file.startsWith(`${dist}${path.sep}`)) {
        response.writeHead(403).end()
        return
      }
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  localServer.listen(0, '127.0.0.1')
  await once(localServer, 'listening')
  targetUrl = `http://127.0.0.1:${localServer.address().port}`
}

try {
  if (!(await hasServer(targetUrl))) {
    if (configuredUrl) {
      throw new Error(`BYMARK_URL 未指向可访问的 Bymark 服务：${configuredUrl}`)
    }
    await startLocalServer()
  }
  const qaScript = process.argv[2] || 'tests/qa.mjs'
  const runner = spawn(process.execPath, [qaScript], {
    stdio: 'inherit',
    env: { ...process.env, BYMARK_URL: targetUrl },
  })
  const [code, signal] = await once(runner, 'exit')
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
} finally {
  if (localServer) {
    localServer.closeAllConnections()
    await new Promise((resolve) => localServer.close(resolve))
  }
}
