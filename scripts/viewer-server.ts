/**
 * Local static server + small API for the IPTV viewer (M3U fetch proxy, Xtream Codes).
 * Run: npm run viewer
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VIEWER_ROOT = path.join(__dirname, '..', 'viewer')
const PORT = Number(process.env.VIEWER_PORT || 8790)
const HOST = process.env.VIEWER_HOST || '127.0.0.1'
const MAX_PLAYLIST_BYTES =
  process.env.VIEWER_MAX_PLAYLIST_BYTES != null && process.env.VIEWER_MAX_PLAYLIST_BYTES !== ''
    ? Number(process.env.VIEWER_MAX_PLAYLIST_BYTES)
    : Number(process.env.VIEWER_MAX_PLAYLIST_MB ?? '120') * 1024 * 1024
const FETCH_TIMEOUT_MS = Number(process.env.VIEWER_FETCH_TIMEOUT_MS || 300_000)
const PLAYLIST_FETCH_ATTEMPTS = Math.max(1, Number(process.env.VIEWER_FETCH_RETRIES || '4'))
const DEFAULT_PLAYLIST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function isRetriablePlaylistStatus(status: number) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

function isRetriableAxiosError(e: unknown) {
  if (!axios.isAxiosError(e)) return false
  const c = e.code
  if (c === 'ECONNRESET' || c === 'ETIMEDOUT' || c === 'ECONNABORTED' || c === 'ECONNREFUSED' || c === 'ENOTFOUND')
    return true
  const s = e.response?.status
  return s !== undefined && isRetriablePlaylistStatus(s)
}

async function fetchPlaylistFromUpstream(url: string, userAgent?: string) {
  const headers: Record<string, string> = {
    Accept: 'text/plain,*/*;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': userAgent?.trim() ? userAgent : DEFAULT_PLAYLIST_UA,
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < PLAYLIST_FETCH_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(url, {
        responseType: 'text',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_PLAYLIST_BYTES,
        maxBodyLength: MAX_PLAYLIST_BYTES,
        validateStatus: () => true,
        headers,
        transitional: { clarifyTimeoutError: true },
      })
      if (r.status >= 200 && r.status < 300) return r
      if (attempt < PLAYLIST_FETCH_ATTEMPTS - 1 && isRetriablePlaylistStatus(r.status)) {
        await sleep(Math.min(5000, 350 * 2 ** attempt))
        continue
      }
      return r
    } catch (e) {
      lastErr = e
      if (attempt < PLAYLIST_FETCH_ATTEMPTS - 1 && isRetriableAxiosError(e)) {
        await sleep(Math.min(5000, 350 * 2 ** attempt))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function safeUrl(u) {
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

async function readBody(req, max = 1_000_000) {
  const chunks = []
  let n = 0
  for await (const ch of req) {
    n += ch.length
    if (n > max) throw new Error('Body too large')
    chunks.push(ch)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8'
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (p.endsWith('.css')) return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

function serveStatic(urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  const abs = path.normalize(path.join(VIEWER_ROOT, rel))
  if (!abs.startsWith(VIEWER_ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType(abs) })
    res.end(data)
  })
}

function normalizeXtreamBase(server) {
  const u = safeUrl(server)
  if (!u) return null
  return u.replace(/\/+$/, '')
}

async function handlePlaylistFetch(req, res) {
  let raw
  try {
    raw = await readBody(req, 32_768)
  } catch (e) {
    sendJson(res, 400, { error: String(/** @type {Error} */ (e).message) })
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }
  const url = safeUrl(String(body.url || ''))
  if (!url) {
    sendJson(res, 400, { error: 'Invalid or missing url (http/https only)' })
    return
  }
  try {
    const customUa = typeof body.userAgent === 'string' ? body.userAgent : undefined
    const r = await fetchPlaylistFromUpstream(url, customUa)
    if (r.status < 200 || r.status >= 300) {
      sendJson(res, 502, { error: `Upstream HTTP ${r.status}` })
      return
    }
    const text = typeof r.data === 'string' ? r.data : String(r.data)
    sendJson(res, 200, { body: text })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String(/** @type {Error} */ (e).message)
    sendJson(res, 502, { error: msg })
  }
}

async function handleXtreamChannels(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (e) {
    sendJson(res, 400, { error: String(/** @type {Error} */ (e).message) })
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }
  const base = normalizeXtreamBase(String(body.server || ''))
  const username = String(body.username || '')
  const password = String(body.password || '')
  if (!base || !username || !password) {
    sendJson(res, 400, { error: 'server, username, and password required' })
    return
  }
  const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  const liveUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`
  try {
    const auth = await axios.get(authUrl, { timeout: 30_000, validateStatus: () => true })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed (check URL, user, and password)' })
      return
    }
    const live = await axios.get(liveUrl, { timeout: 120_000, validateStatus: () => true })
    if (live.status !== 200 || !Array.isArray(live.data)) {
      sendJson(res, 502, { error: 'Could not load live streams from server' })
      return
    }
    const channels = live.data.map(
      /** @returns {{ name: string; url: string; group?: string }} */
      (s) => {
        const streamId = s.stream_id
        const ext = (s.container_extension || 'm3u8').replace(/^\./, '')
        const name = s.name || `Stream ${streamId}`
        const group = s.category_name || s.category_id
        const streamUrl = `${base}/live/${username}/${password}/${streamId}.${ext}`
        return { name, url: streamUrl, ...(group ? { group: String(group) } : {}) }
      }
    )
    sendJson(res, 200, { channels })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String(/** @type {Error} */ (e).message)
    sendJson(res, 502, { error: msg })
  }
}

async function handleXtreamCatalog(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (e) {
    sendJson(res, 400, { error: String(/** @type {Error} */ (e).message) })
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }
  const base = normalizeXtreamBase(String(body.server || ''))
  const username = String(body.username || '')
  const password = String(body.password || '')
  if (!base || !username || !password) {
    sendJson(res, 400, { error: 'server, username, and password required' })
    return
  }
  try {
    const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const auth = await axios.get(authUrl, { timeout: 30_000, validateStatus: () => true })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed (check URL, user, and password)' })
      return
    }
    const [live, vod] = await Promise.all([
      axios.get(
        `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`,
        { timeout: 180_000, validateStatus: () => true }
      ),
      axios.get(
        `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_streams`,
        { timeout: 180_000, validateStatus: () => true }
      ),
    ])
    /** @type {{ name: string; url: string; group?: string; kind: string }[]} */
    const channels = []
    if (live.status === 200 && Array.isArray(live.data)) {
      for (const s of live.data) {
        const streamId = s.stream_id
        const ext = (s.container_extension || 'm3u8').replace(/^\./, '')
        channels.push({
          name: String(s.name || `Live ${streamId}`),
          url: `${base}/live/${username}/${password}/${streamId}.${ext}`,
          ...(s.category_name ? { group: String(s.category_name) } : {}),
          kind: 'live',
        })
      }
    }
    if (vod.status === 200 && Array.isArray(vod.data)) {
      for (const s of vod.data) {
        const streamId = s.stream_id
        const ext = (s.container_extension || 'mkv').replace(/^\./, '')
        channels.push({
          name: String(s.name || `Movie ${streamId}`),
          url: `${base}/movie/${username}/${password}/${streamId}.${ext}`,
          group: s.category_name ? `Movies · ${String(s.category_name)}` : 'Movies',
          kind: 'vod',
        })
      }
    }
    sendJson(res, 200, { channels })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String(/** @type {Error} */ (e).message)
    sendJson(res, 502, { error: msg })
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const p = u.pathname

  if (req.method === 'POST' && p === '/api/playlist/fetch') {
    void handlePlaylistFetch(req, res)
    return
  }
  if (req.method === 'POST' && p === '/api/xtream/channels') {
    void handleXtreamChannels(req, res)
    return
  }

  if (req.method === 'POST' && p === '/api/xtream/catalog') {
    void handleXtreamCatalog(req, res)
    return
  }

  if (req.method === 'GET' && (p === '/' || p.endsWith('.html') || p.endsWith('.js'))) {
    serveStatic(p, res)
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    console.log(
      `IPTV viewer: http://127.0.0.1:${PORT} — on your LAN use http://<this-host-ip>:${PORT} (set VIEWER_HOST=127.0.0.1 to disable)`
    )
  } else {
    console.log(`IPTV viewer: http://${HOST}:${PORT}`)
  }
})
