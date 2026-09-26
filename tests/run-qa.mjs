import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
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

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else if (address && typeof address !== 'string') resolve(address.port)
        else reject(new Error('无法找到可用端口。'))
      })
    })
  })
}

async function startLocalServer(port) {
  localServer = spawn(
    path.resolve('node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  let startupError = ''
  localServer.stderr.on('data', (chunk) => {
    startupError += chunk.toString()
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await hasServer(targetUrl)) return
    if (localServer.exitCode !== null) {
      throw new Error(`无法启动本地 QA 服务。${startupError}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`本地 QA 服务启动超时。${startupError}`)
}

try {
  if (!(await hasServer(targetUrl))) {
    if (configuredUrl) {
      throw new Error(`BYMARK_URL 未指向可访问的 Bymark 服务：${configuredUrl}`)
    }
    const port = await findAvailablePort()
    targetUrl = `http://127.0.0.1:${port}`
    await startLocalServer(port)
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
  if (localServer && localServer.exitCode === null) {
    localServer.kill('SIGTERM')
  }
}
