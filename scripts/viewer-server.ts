/**
 * Local static server + small API for the IPTV viewer (M3U fetch proxy, Xtream Codes).
 * Run: npm run viewer
 *
 * Timeouts (environment overrides):
 * - VIEWER_FETCH_TIMEOUT_MS — M3U/EPG text via proxy (default 900000).
 * - VIEWER_XTREAM_AUTH_TIMEOUT_MS — player_api handshake (default 120000).
 * - VIEWER_XTREAM_LIST_TIMEOUT_MS — huge JSON lists / series-info (default 600000).
 * - VIEWER_XTREAM_SHORT_EPG_TIMEOUT_MS — short EPG per stream (default 45000).
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
const MAX_EPG_BYTES =
  process.env.VIEWER_MAX_EPG_BYTES != null && process.env.VIEWER_MAX_EPG_BYTES !== ''
    ? Number(process.env.VIEWER_MAX_EPG_BYTES)
    : Number(process.env.VIEWER_MAX_EPG_MB ?? '40') * 1024 * 1024

/** Remote M3U / EPG text fetch. Default 15m. Override: VIEWER_FETCH_TIMEOUT_MS */
const FETCH_TIMEOUT_MS = Number(process.env.VIEWER_FETCH_TIMEOUT_MS || 900_000)
const PLAYLIST_FETCH_ATTEMPTS = Math.max(1, Number(process.env.VIEWER_FETCH_RETRIES || '4'))

/** Xtream `player_api.php` handshake. Default 2m. Override: VIEWER_XTREAM_AUTH_TIMEOUT_MS */
const XTREAM_AUTH_TIMEOUT_MS = Number(process.env.VIEWER_XTREAM_AUTH_TIMEOUT_MS || 120_000)

/** Large JSON (`get_live_streams`, `get_vod_streams`, `get_series`). Default 10m each. Override: VIEWER_XTREAM_LIST_TIMEOUT_MS */
const XTREAM_LIST_TIMEOUT_MS = Number(process.env.VIEWER_XTREAM_LIST_TIMEOUT_MS || 600_000)

/** `get_short_epg` per stream. Default 45s. Override: VIEWER_XTREAM_SHORT_EPG_TIMEOUT_MS */
const XTREAM_SHORT_EPG_TIMEOUT_MS = Number(process.env.VIEWER_XTREAM_SHORT_EPG_TIMEOUT_MS || 45_000)

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

/** User-facing playlist fetch failures (non‑2xx or unusable body). */
function playlistFetchFailureExplain(status: number): string {
  let suffix = ''
  if (status >= 880 && status <= 899) suffix = 'often a CDN/WAF proprietary block.'
  else if (status === 403 || status === 451)
    suffix = 'often geo, IP denylist, or datacenter blocking.'
  else suffix = 'the server did not return a usable playlist.'
  return `Upstream HTTP ${status}: ${suffix} If the URL opens in your browser, paste the M3U text here, or add the portal as Xtream; home/VPN IPs are less often blocked than server proxies.`
}

function looksLikeHtmlNotM3u(text: string): boolean {
  const t = text.replace(/^\uFEFF/, '').trimStart()
  if (!t.startsWith('<')) return false
  const head = t.slice(0, 800).toLowerCase()
  return (
    /<html[\s>]/.test(head) || /<\!doctype/.test(head) || /<meta[\s]/.test(head) || /<body[\s>]/.test(head)
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

async function fetchTextFromUpstream(url: string, userAgent: string | undefined, maxBytes: number) {
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
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
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

function fetchPlaylistFromUpstream(url: string, userAgent?: string) {
  return fetchTextFromUpstream(url, userAgent, MAX_PLAYLIST_BYTES)
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
    // Dev viewer — never let the browser cache stale modules.
    res.writeHead(200, {
      'Content-Type': contentType(abs),
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    })
    res.end(data)
  })
}

function normalizeXtreamBase(server) {
  const u = safeUrl(server)
  if (!u) return null
  return u.replace(/\/+$/, '')
}

/**
 * Parses Xtream-style portal URLs (`get.php?username=…&password=…`, etc.).
 * Directory before the script becomes the HTTP base for `player_api.php`.
 */
function extractXtreamFromPortal(raw: string): { baseHref: string; username: string; password: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const sp = u.searchParams
  const username = sp.get('username') ?? sp.get('user') ?? ''
  const password = sp.get('password') ?? sp.get('pass') ?? sp.get('pwd') ?? ''
  if (!username.trim() || password === '') return null
  const pathname = u.pathname.replace(/\/+$/, '') || ''
  const basePath = pathname.replace(/\/[^/]+\.php$/i, '')
  const baseHref = (`${u.origin}${basePath}`.replace(/\/+$/, '') || u.origin) as string
  return { baseHref, username: username.trim(), password }
}

type XtreamCredResult =
  | { ok: false; status: number; msg: string }
  | { ok: true; base: string; username: string; password: string }

/** Flatten Xtream `get_series_info` → sorted playable episode list. */
function flattenXtreamSeriesEpisodes(
  episodes: unknown,
  base: string,
  username: string,
  password: string
): { id: string; season: number; episode: number; title: string; url: string }[] {
  if (!episodes || typeof episodes !== 'object') return []
  const out: { id: string; season: number; episode: number; title: string; url: string }[] = []
  for (const [seasonKey, list] of Object.entries(episodes as Record<string, unknown>)) {
    const season = Number(seasonKey) || 0
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const ep = raw as Record<string, unknown>
      const id = String(ep.id ?? ep.stream_id ?? ep.streamId ?? '')
      if (!id) continue
      const ext = String(ep.container_extension ?? 'mkv').replace(/^\./, '')
      const epNum = Number(ep.episode_num) || 0
      const title = String(ep.title || (epNum ? `Episode ${epNum}` : `Episode`))
      const url = `${base}/series/${username}/${password}/${id}.${ext}`
      out.push({ id, season, episode: epNum, title, url })
    }
  }
  out.sort((a, b) => a.season - b.season || a.episode - b.episode || a.title.localeCompare(b.title))
  return out
}

function xtreamCredsFromRequestBody(body: Record<string, unknown>): XtreamCredResult {
  const portalUrl = typeof body.portalUrl === 'string' ? body.portalUrl.trim() : ''
  if (portalUrl) {
    const ex = extractXtreamFromPortal(portalUrl)
    if (!ex)
      return {
        ok: false,
        status: 400,
        msg: 'Invalid portal URL. Expected http(s) with username & password query params (e.g. …/get.php?username=…&password=…).',
      }
    const base = normalizeXtreamBase(ex.baseHref)
    if (!base)
      return { ok: false, status: 400, msg: 'Could not derive a valid Xtream base URL from portal link.' }
    return { ok: true, base, username: ex.username, password: ex.password }
  }
  const base = normalizeXtreamBase(String(body.server ?? ''))
  const username = String(body.username ?? '')
  const password = String(body.password ?? '')
  if (!base || !username || !password)
    return { ok: false, status: 400, msg: 'portalUrl or (server, username, and password) required' }
  return { ok: true, base, username, password }
}

async function handleEpgFetch(req, res) {
  let raw
  try {
    raw = await readBody(req, 32_768)
  } catch (e) {
    sendJson(res, 400, { error: String((e as Error).message) })
    return
  }
  let body: { url?: string; userAgent?: string }
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
    const r = await fetchTextFromUpstream(url, customUa, MAX_EPG_BYTES)
    if (r.status < 200 || r.status >= 300) {
      sendJson(res, 502, { error: `Upstream HTTP ${r.status}` })
      return
    }
    const text = typeof r.data === 'string' ? r.data : String(r.data)
    sendJson(res, 200, { body: text })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String((e as Error).message)
    sendJson(res, 502, { error: msg })
  }
}

async function handleXtreamShortEpg(req, res) {
  let raw: string
  try {
    raw = await readBody(req, 16_384)
  } catch (e) {
    sendJson(res, 400, { error: String((e as Error).message) })
    return
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }
  const creds = xtreamCredsFromRequestBody(body)
  if (!creds.ok) {
    sendJson(res, creds.status, { error: creds.msg })
    return
  }
  const { base, username, password } = creds
  const rawIds = Array.isArray(body.streamIds) ? body.streamIds : []
  /** @type {number[]} */
  const streamIds = rawIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n >= 1).slice(0, 40)
  if (!streamIds.length) {
    sendJson(res, 400, { error: 'streamIds required' })
    return
  }
  try {
    const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const auth = await axios.get(authUrl, {
      timeout: XTREAM_AUTH_TIMEOUT_MS,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed' })
      return
    }
    /** @type {Record<string, unknown[]>} */
    const byStreamId: Record<string, unknown[]> = {}
    await Promise.all(
      streamIds.map(async (sid) => {
        const u = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_short_epg&stream_id=${sid}&limit=3`
        const r = await axios.get(u, {
          timeout: XTREAM_SHORT_EPG_TIMEOUT_MS,
          validateStatus: () => true,
          transitional: { clarifyTimeoutError: true },
        })
        if (r.status !== 200) return
        const list = r.data?.epg_listings
        if (!Array.isArray(list) || list.length === 0) return
        byStreamId[String(sid)] = list.slice(0, 6)
      })
    )
    sendJson(res, 200, { byStreamId })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String((e as Error).message)
    sendJson(res, 502, { error: msg })
  }
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
      sendJson(res, 502, { error: playlistFetchFailureExplain(r.status) })
      return
    }
    const text = typeof r.data === 'string' ? r.data : String(r.data)
    if (!text.trim()) {
      sendJson(res, 502, {
        error:
          'Playlist response was empty. The provider may block this machine’s IP — try Paste M3U after downloading in your browser, or Xtream.',
      })
      return
    }
    if (looksLikeHtmlNotM3u(text)) {
      sendJson(res, 502, {
        error:
          'Response looks like HTML, not an M3U playlist (blocked or error page). If the URL works in a browser on your network, copy the playlist and use Paste M3U, or try Xtream credentials.',
      })
      return
    }
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
    const auth = await axios.get(authUrl, {
      timeout: XTREAM_AUTH_TIMEOUT_MS,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed (check URL, user, and password)' })
      return
    }
    const live = await axios.get(liveUrl, {
      timeout: XTREAM_LIST_TIMEOUT_MS,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    })
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
  const creds = xtreamCredsFromRequestBody(body)
  if (!creds.ok) {
    sendJson(res, creds.status, { error: creds.msg })
    return
  }
  const { base, username, password } = creds
  try {
    const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const auth = await axios.get(authUrl, {
      timeout: XTREAM_AUTH_TIMEOUT_MS,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed (check URL, user, and password)' })
      return
    }
    const q = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const [live, vod, tvSeries] = await Promise.all([
      axios.get(`${base}/player_api.php?${q}&action=get_live_streams`, {
        timeout: XTREAM_LIST_TIMEOUT_MS,
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
      }),
      axios.get(`${base}/player_api.php?${q}&action=get_vod_streams`, {
        timeout: XTREAM_LIST_TIMEOUT_MS,
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
      }),
      axios.get(`${base}/player_api.php?${q}&action=get_series`, {
        timeout: XTREAM_LIST_TIMEOUT_MS,
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
      }),
    ])
    /** @type {{ name: string; url?: string; group?: string; kind: string; seriesId?: number; logo?: string }[]} */
    const channels = []
    if (live.status === 200 && Array.isArray(live.data)) {
      for (const s of live.data) {
        const streamId = s.stream_id
        const ext = (s.container_extension || 'm3u8').replace(/^\./, '')
        const cat = s.category_name != null ? String(s.category_name) : s.category_id != null ? String(s.category_id) : ''
        const logo = s.stream_icon != null ? String(s.stream_icon) : undefined
        channels.push({
          name: String(s.name || `Live ${streamId}`),
          url: `${base}/live/${username}/${password}/${streamId}.${ext}`,
          group: cat ? `Live · ${cat}` : 'Live · General',
          kind: 'live',
          ...(logo ? { logo } : {}),
        })
      }
    }
    if (vod.status === 200 && Array.isArray(vod.data)) {
      for (const s of vod.data) {
        const streamId = s.stream_id
        const ext = (s.container_extension || 'mkv').replace(/^\./, '')
        const cat = s.category_name != null ? String(s.category_name) : s.category_id != null ? String(s.category_id) : ''
        const logoRaw = s.stream_icon ?? s.cover ?? s.cover_big
        const logo = logoRaw != null ? String(logoRaw) : undefined
        channels.push({
          name: String(s.name || `Movie ${streamId}`),
          url: `${base}/movie/${username}/${password}/${streamId}.${ext}`,
          group: cat ? `Movies · ${cat}` : 'Movies · General',
          kind: 'vod',
          ...(logo ? { logo } : {}),
        })
      }
    }
    if (tvSeries.status === 200 && Array.isArray(tvSeries.data)) {
      for (const s of tvSeries.data) {
        const rawId =
          (s as { series_id?: unknown }).series_id ?? (s as { seriesId?: unknown }).seriesId
        if (rawId == null) continue
        const seriesId = Number(rawId)
        if (!Number.isFinite(seriesId)) continue
        const cat = s.category_name != null ? String(s.category_name) : s.category_id != null ? String(s.category_id) : ''
        const logoRaw = s.cover ?? s.cover_big ?? s.stream_icon
        const logo = logoRaw != null ? String(logoRaw) : undefined
        channels.push({
          name: String(s.name || `Series ${seriesId}`),
          group: cat ? `Series · ${cat}` : 'Series · General',
          kind: 'series',
          seriesId,
          ...(logo ? { logo } : {}),
        })
      }
    }
    sendJson(res, 200, { channels })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String(/** @type {Error} */ (e).message)
    sendJson(res, 502, { error: msg })
  }
}

/** `get_series_info` → playable episode list for the viewer detail modal / play resolver. */
async function handleXtreamSeriesInfo(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (e) {
    sendJson(res, 400, { error: String((/** @type {Error} */ (e)).message) })
    return
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }
  const creds = xtreamCredsFromRequestBody(body as Record<string, unknown>)
  if (!creds.ok) {
    sendJson(res, creds.status, { error: creds.msg })
    return
  }
  const seriesId = Number((body as { seriesId?: unknown }).seriesId)
  if (!Number.isFinite(seriesId) || seriesId < 1) {
    sendJson(res, 400, { error: 'seriesId required' })
    return
  }
  const { base, username, password } = creds
  try {
    const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const auth = await axios.get(authUrl, {
      timeout: XTREAM_AUTH_TIMEOUT_MS,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    })
    const a = auth.data?.user_info?.auth
    const authed = auth.status === 200 && a !== undefined && `${a}` === '1'
    if (!authed) {
      sendJson(res, 401, { error: 'Xtream authentication failed' })
      return
    }
    const q = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    const info = await axios.get(
      `${base}/player_api.php?${q}&action=get_series_info&series_id=${seriesId}`,
      {
        timeout: XTREAM_LIST_TIMEOUT_MS,
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
      }
    )
    if (info.status !== 200) {
      sendJson(res, 502, { error: `Series lookup failed (upstream HTTP ${info.status})` })
      return
    }
    /** @type {unknown} */
    const rawEp = info.data?.episodes
    const episodes = flattenXtreamSeriesEpisodes(rawEp, base, username, password)
    sendJson(res, 200, {
      episodes,
      totalEpisodes: episodes.length,
    })
  } catch (e) {
    const msg = axios.isAxiosError(e) ? e.message : String((/** @type {Error} */ (e)).message)
    sendJson(res, 502, { error: msg })
  }
}

function safeRequestPath(rawUrl: string | undefined) {
  const raw = rawUrl || '/'
  try {
    return new URL(raw, `http://127.0.0.1:${PORT}`).pathname
  } catch {
    // Malformed request-target (e.g. '//', proxy probes). Strip query manually.
    const noQuery = raw.split('?')[0]
    if (!noQuery || !noQuery.startsWith('/')) return '/'
    return noQuery
  }
}

const server = http.createServer((req, res) => {
  let p: string
  try {
    p = safeRequestPath(req.url)
  } catch (e) {
    res.writeHead(400)
    res.end('Bad request')
    console.warn('viewer: bad request URL', req.url, (e as Error).message)
    return
  }

  if (req.method === 'POST' && p === '/api/playlist/fetch') {
    void handlePlaylistFetch(req, res)
    return
  }
  if (req.method === 'POST' && p === '/api/epg/fetch') {
    void handleEpgFetch(req, res)
    return
  }
  if (req.method === 'POST' && p === '/api/xtream/short-epg') {
    void handleXtreamShortEpg(req, res)
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
  if (req.method === 'POST' && p === '/api/xtream/series-info') {
    void handleXtreamSeriesInfo(req, res)
    return
  }

  if (req.method === 'GET' && (p === '/' || p.endsWith('.html') || p.endsWith('.js'))) {
    serveStatic(p, res)
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.on('clientError', (err, socket) => {
  console.warn('viewer: client error', (err as Error).message)
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  } catch {
    /* socket already gone */
  }
})

server.on('error', (err) => {
  console.error('viewer: server error', err)
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
