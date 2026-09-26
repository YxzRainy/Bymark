import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const COLLECTIONS = new Set(['drafts', 'archives', 'brandTemplates'])
const SINGLETONS = new Set(['settings', 'avatar', 'image', 'sceneImage', 'exportPreferences'])
const PREFIX = '/__bymark_shared_storage'
const MAX_BODY_BYTES = 256 * 1024 * 1024

function recordPath(root, kind, id) {
  const filename = COLLECTIONS.has(kind)
    ? `${createHash('sha256').update(id).digest('hex')}.json`
    : `${kind}.json`
  return path.join(root, COLLECTIONS.has(kind) ? kind : '', filename)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readKind(root, kind) {
  if (SINGLETONS.has(kind)) return readJson(recordPath(root, kind))
  const directory = path.join(root, kind)
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return (await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(directory, name))))).filter(Boolean)
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function deleteJson(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readSnapshot(root) {
  const kinds = [...SINGLETONS, ...COLLECTIONS]
  const entries = await Promise.all(kinds.map(async (kind) => [kind, await readKind(root, kind)]))
  return Object.fromEntries(entries)
}

async function readInitialSnapshot(root) {
  const [settings, exportPreferences] = await Promise.all([
    readKind(root, 'settings'),
    readKind(root, 'exportPreferences'),
  ])
  return { settings, exportPreferences }
}

function scoreOfImport(value) {
  return (value.drafts?.length ?? 0) * 10 + (value.archives?.length ?? 0) * 10 + (value.brandTemplates?.length ?? 0) * 5
}

function recordTime(value) {
  return value?.updatedAt ?? value?.archivedAt ?? value?.createdAt ?? ''
}

async function importLocal(root, payload) {
  const score = scoreOfImport(payload)
  for (const kind of COLLECTIONS) {
    for (const value of Array.isArray(payload[kind]) ? payload[kind] : []) {
      if (!value || typeof value.id !== 'string') continue
      const file = recordPath(root, kind, value.id)
      const existing = await readJson(file)
      if (!existing || recordTime(value) > recordTime(existing)) {
        await writeJson(file, value)
      }
    }
  }
  const priorityFile = path.join(root, 'migration-priority.json')
  const currentPriority = (await readJson(priorityFile))?.score ?? -1
  if (score > currentPriority) {
    for (const kind of SINGLETONS) {
      if (payload[kind] !== undefined && payload[kind] !== null) {
        await writeJson(recordPath(root, kind), payload[kind])
      }
    }
    await writeJson(priorityFile, { score })
  } else {
    for (const kind of SINGLETONS) {
      if (payload[kind] !== undefined && payload[kind] !== null) {
        const file = recordPath(root, kind)
        if (await readJson(file) === null) await writeJson(file, payload[kind])
      }
    }
  }
  return readInitialSnapshot(root)
}

async function parseBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Workspace data exceeds 256 MB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Bymark-Shared-Storage': '1' })
  response.end(JSON.stringify(data))
}

export function sharedStoragePlugin(projectRoot) {
  const root = process.env.BYMARK_SHARED_STORAGE_DIR ?? path.join(projectRoot, '.bymark-local-data')
  const attach = (server) => {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== PREFIX && url.pathname !== `${PREFIX}/import`) return next()
      const address = request.socket.remoteAddress ?? ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
        reply(response, 403, { error: 'Local access only' })
        return
      }
      const origin = request.headers.origin
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
        reply(response, 403, { error: 'Same-origin access only' })
        return
      }
      try {
        if (request.method === 'GET' && url.pathname === PREFIX) {
          if (url.searchParams.has('probe')) {
            reply(response, 200, { available: true })
            return
          }
          const kind = url.searchParams.get('kind')
          if (kind && !COLLECTIONS.has(kind) && !SINGLETONS.has(kind)) throw new Error('Unknown storage kind')
          reply(response, 200, kind ? await readKind(root, kind) : await readSnapshot(root))
        } else if (request.method === 'POST' && url.pathname === `${PREFIX}/import`) {
          reply(response, 200, await importLocal(root, await parseBody(request)))
        } else if (request.method === 'PUT' && url.pathname === PREFIX) {
          const { kind, id, value } = await parseBody(request)
          if (!COLLECTIONS.has(kind) && !SINGLETONS.has(kind)) throw new Error('Unknown storage kind')
          if (COLLECTIONS.has(kind) && (typeof id !== 'string' || !id)) throw new Error('Record ID is required')
          const file = recordPath(root, kind, id)
          const existing = await readJson(file)
          if (!existing || !recordTime(existing) || recordTime(value) >= recordTime(existing)) {
            await writeJson(file, value)
          }
          reply(response, 200, { ok: true })
        } else if (request.method === 'DELETE' && url.pathname === PREFIX) {
          const { kind, id } = await parseBody(request)
          if (!COLLECTIONS.has(kind) || typeof id !== 'string' || !id) throw new Error('Invalid record')
          await deleteJson(recordPath(root, kind, id))
          reply(response, 200, { ok: true })
        } else {
          reply(response, 405, { error: 'Method not allowed' })
        }
      } catch (error) {
        reply(response, 400, { error: error instanceof Error ? error.message : 'Storage error' })
      }
    })
  }
  return {
    name: 'bymark-shared-local-storage',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}
