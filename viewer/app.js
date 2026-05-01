import { parseM3u } from './m3u.js'
import { extractXtreamFromPortalUrl } from './xtream-portal-parse.js'
import * as Pins from './pins.js'
import { assignContentKind, filterByContentKind } from './m3u-kind.js'
import {
  loadPlaylists,
  upsertPlaylist,
  deletePlaylist,
  getPlaylist,
  getActivePlaylistId,
  setActivePlaylistId,
  newId,
} from './playlists-store.js'
import {
  loadSettings,
  updateSettings,
  resetSettings,
  ACCENT_PRESETS,
  getAccent,
} from './settings-store.js'
import * as Progress from './progress-store.js'
import * as EpgXml from './epg-xmltv.js'

/* ─────────────────────────  DOM helpers  ─────────────────────────── */

const $ = (id) => /** @type {HTMLElement | null} */ (document.getElementById(id))
const $$ = (sel, root = document) => /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(sel)))

/** @param {string} id */
function need(id) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`IPTV viewer: missing #${id}`)
  return el
}

/**
 * @param {string} id
 * @param {string} evt
 * @param {EventListenerOrEventListenerObject} fn
 */
function bind(id, evt, fn) {
  const el = document.getElementById(id)
  if (!el) {
    console.warn(`IPTV viewer: missing #${id} for ${evt}`)
    return
  }
  el.addEventListener(evt, fn)
}

/* ─────────────────────────  Types & state  ──────────────────────── */

/** @typedef {'all' | 'live' | 'vod' | 'series'} KindFilter */
/** @typedef {'home' | 'browse' | 'watch' | 'accounts' | 'account-editor' | 'settings'} AppRoute */
/** @typedef {{ name: string; url: string; logo?: string; group?: string; kind?: 'live' | 'vod' | 'series'; tvgId?: string; seriesId?: number }} Ch */

const state = {
  /** @type {Ch[]} */ channels: [],
  /** @type {string | null} */ loadedAccountId: null,
  /** @type {KindFilter} */ kindFilter: 'all',
  favouritesOnly: false,
  /** @type {string | null} */ playingUrl: null,
  /** @type {Ch | null} */ playingCh: null,
  /** @type {Ch[]} */ playingQueue: [],
  /** @type {any} */ hls: null,
  searchTerm: '',
  /** @type {AppRoute} */ route: 'home',
  /** @type {AppRoute} */ prevRoute: 'home',
  /** @type {string | null} */ editingAccountId: null,
  /** @type {Ch | null} */ heroCurrent: null,
  /** @type {Ch[]} */ heroPool: [],
  heroIndex: 0,
  /** @type {ReturnType<typeof setInterval> | null} */ heroTimer: null,
  isLoading: false,
}

/** EPG caches: XMLTV (Settings URL) + Xtream short EPG. */
const epgState = {
  /** @type {ReturnType<EpgXml['parseXmltv']> | null} */ xmltv: null,
  xmltvSourceUrl: '',
  /** @type {Record<string, unknown[]>} */ xtream: {},
  loading: false,
}

/** @type {Map<string, string>} */
const xmltvIdByChannelUrl = new Map()

/** @type {Ch | null} */
let detailModalCh = null
let epgDebounceTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let epgClockTimer = null

const settingsState = { current: loadSettings() }

/* ─────────────────────────  EPG helpers  ─────────────────────────── */

/** @param {string} s @param {number} n */
function truncate(s, n) {
  const t = String(s || '')
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`
}

/** @param {string} url */
function parseXtreamLiveRef(url) {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/live\/([^/]+)\/([^/]+)\/(\d+)\.[a-zA-Z0-9]+$/i)
    if (!m) return null
    return {
      base: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(m[1]),
      password: decodeURIComponent(m[2]),
      streamId: m[3],
    }
  } catch {
    return null
  }
}

/** @param {unknown} row */
function slotFromXtreamRow(row) {
  if (!row || typeof row !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (row)
  const st = Number(o.start_timestamp)
  const en = Number(o.stop_timestamp)
  if (Number.isFinite(st) && Number.isFinite(en) && en > st) {
    return {
      start: st * 1000,
      stop: en * 1000,
      title: String(o.title || '').trim(),
      desc: String(o.description ?? o.desc ?? '').trim(),
    }
  }
  return null
}

/** @param {string} streamId */
function getXtreamNowNext(streamId) {
  const raw = epgState.xtream[streamId]
  if (!Array.isArray(raw)) return { now: null, next: null }
  const now = Date.now()
  /** @type {{ start: number; stop: number; title: string; desc: string }[]} */
  const slots = []
  for (const r of raw) {
    const slot = slotFromXtreamRow(r)
    if (slot) slots.push(slot)
  }
  slots.sort((a, b) => a.start - b.start)
  /** @type {typeof slots[0] | null} */ let cur = null
  /** @type {typeof slots[0] | null} */ let nx = null
  for (const p of slots) {
    if (p.start <= now && now < p.stop) cur = p
    else if (p.start > now && !nx) nx = p
    if (cur && nx) break
  }
  return { now: cur, next: nx }
}

/** @param {Ch} ch */
function getXmltvChannelIdFor(ch) {
  if (!epgState.xmltv) return ''
  if (xmltvIdByChannelUrl.has(ch.url)) return /** @type {string} */ (xmltvIdByChannelUrl.get(ch.url))
  const id = EpgXml.resolveXmltvChannelId(epgState.xmltv, ch)
  xmltvIdByChannelUrl.set(ch.url, id)
  return id
}

/** @param {Ch} ch */
function getCombinedEpg(ch) {
  if ((ch.kind || 'live') !== 'live') return { now: null, next: null }
  const xf = parseXtreamLiveRef(ch.url)
  if (xf) return getXtreamNowNext(xf.streamId)
  const cid = getXmltvChannelIdFor(ch)
  if (cid && epgState.xmltv) return EpgXml.getNowAndNext(epgState.xmltv.programmesByChannel, cid)
  return { now: null, next: null }
}

/** @param {number} ms */
function fmtClock(ms) {
  const d = new Date(ms)
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** @param {Ch} ch @param {{ sub?: string }} [opts] */
function getCardSubline(ch, opts = {}) {
  const kind = ch.kind || 'live'
  const fallback = opts.sub || ch.group || (kind === 'live' ? 'Live channel' : kind === 'vod' ? 'Movie' : 'Series')
  if (kind !== 'live') return fallback
  const { now } = getCombinedEpg(ch)
  if (now?.title) return `Now · ${truncate(now.title, 52)}`
  return fallback
}

function scheduleEpgLoad() {
  if (epgDebounceTimer) clearTimeout(epgDebounceTimer)
  epgDebounceTimer = setTimeout(() => {
    void loadAllEpg()
  }, 500)
}

async function loadXmltvEpg() {
  const url = settingsState.current.epgUrl?.trim()
  if (!url) {
    epgState.xmltv = null
    epgState.xmltvSourceUrl = ''
    xmltvIdByChannelUrl.clear()
    return
  }
  const ua = settingsState.current.fetchUserAgent
  try {
    const res = await fetch('/api/epg/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ua ? { url, userAgent: ua } : { url }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'EPG fetch failed')
    const guide = EpgXml.parseXmltv(data.body || '')
    epgState.xmltv = guide
    epgState.xmltvSourceUrl = url
    xmltvIdByChannelUrl.clear()
  } catch (e) {
    console.warn('EPG XMLTV', e)
    epgState.xmltv = null
    epgState.xmltvSourceUrl = ''
    xmltvIdByChannelUrl.clear()
    if (url) toast(`EPG: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

async function loadXtreamBatchEpg() {
  epgState.xtream = {}
  const lives = state.channels.filter((c) => (c.kind || 'live') === 'live')
  const refs = []
  const seen = new Set()
  for (const ch of lives) {
    const r = parseXtreamLiveRef(ch.url)
    if (r && !seen.has(r.streamId)) {
      seen.add(r.streamId)
      refs.push(r)
    }
  }
  if (!refs.length) return
  const cred = refs[0]
  const ids = refs.slice(0, 80).map((r) => Number(r.streamId))
  const chunks = []
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40))
  for (const chunk of chunks) {
    try {
      const res = await fetch('/api/xtream/short-epg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: cred.base,
          username: cred.username,
          password: cred.password,
          streamIds: chunk,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) continue
      const by = /** @type {Record<string, unknown[]>} */ (data.byStreamId || {})
      Object.assign(epgState.xtream, by)
    } catch {
      /* ignore — non-Xtream or API unavailable */
    }
  }
}

async function loadAllEpg() {
  if (!state.channels.length) return
  epgState.loading = true
  try {
    await Promise.all([loadXmltvEpg(), loadXtreamBatchEpg()])
  } finally {
    epgState.loading = false
    paintEpgOnUiLight()
  }
}

function paintEpgOnCards() {
  $$('.card[data-url] .sub').forEach((el) => {
    const wrap = /** @type {HTMLElement} */ (el.closest('.card'))
    const url = wrap?.dataset.url
    if (!url || !wrap) return
    const ch = state.channels.find((c) => c.url === url)
    if (!ch) return
    const base = el.dataset.baseSub || ''
    el.textContent = getCardSubline(ch, { sub: base })
  })
}

function paintEpgOnUiLight() {
  paintEpgOnCards()
  if (state.route === 'home' && state.heroCurrent) applyHero(state.heroCurrent)
  if (detailModalCh && $('detail-modal')?.getAttribute('data-open') === 'true') fillDetailModal(detailModalCh)
}

function startEpgClock() {
  if (epgClockTimer) clearInterval(epgClockTimer)
  epgClockTimer = setInterval(() => {
    if (!state.channels.length) return
    if (!epgState.xmltv && Object.keys(epgState.xtream).length === 0) return
    paintEpgOnUiLight()
  }, 60_000)
}

function bindDetailModal() {
  bind('detail-backdrop', 'click', () => closeChannelDetail())
  bind('detail-close', 'click', () => closeChannelDetail())
  bind('detail-play', 'click', () => { void onDetailPlayClick() })

  bind('detail-fav', 'click', () => {
    if (!detailModalCh) return
    Pins.toggleFavorite(detailModalCh)
    fillDetailModal(detailModalCh)
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const m = $('detail-modal')
    if (m?.getAttribute('data-open') === 'true') {
      closeChannelDetail()
      e.preventDefault()
    }
  })
}

function closeChannelDetail() {
  detailModalCh = null
  const m = $('detail-modal')
  if (m) m.setAttribute('data-open', 'false')
}

/** @param {Ch} ch */
async function loadDetailSeriesEpisodes(ch) {
  const urlEl = $('detail-url')
  const seriesBlock = $('detail-series-block')
  const seriesBody = $('detail-series-body')
  try {
    const data = await fetchXtreamSeriesEpisodeData(ch)
    const eps = Array.isArray(data.episodes) ? data.episodes : []
    if (urlEl) {
      if (!eps.length) urlEl.textContent = 'No episodes.'
      else if (data.truncated)
        urlEl.textContent = `${eps.length} of ${data.totalEpisodes} episodes (showing subset)`
      else urlEl.textContent = `${eps.length} episode(s)`
    }
    if (seriesBody) seriesBody.innerHTML = ''
    if (seriesBlock) seriesBlock.hidden = false
    if (seriesBody) {
      const cap = 100
      for (const ep of eps.slice(0, cap)) {
        const b = document.createElement('button')
        b.className = 'btn btn-outline btn-sm episode-pick'
        b.type = 'button'
        b.textContent = `S${ep.season || '?'} E${ep.episode || '?'} — ${truncate(ep.title, 72)}`
        b.addEventListener('click', () => {
          const playCh = { ...ch, url: ep.url, name: `${ch.name} — ${ep.title}` }
          closeChannelDetail()
          openWatch(playCh, { queue: [], resumeAt: Progress.getProgress(ep.url)?.position || 0 })
        })
        seriesBody.appendChild(b)
      }
      if (eps.length > cap) {
        const note = document.createElement('div')
        note.className = 'detail-slot-desc'
        note.textContent = `Showing ${cap} of ${eps.length} episodes. Narrow with search when browsing the library.`
        seriesBody.appendChild(note)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (urlEl) urlEl.textContent = msg
    if (seriesBlock) seriesBlock.hidden = false
    if (seriesBody) seriesBody.innerHTML = ''
  }
}

async function onDetailPlayClick() {
  if (!detailModalCh) return
  const ch = detailModalCh
  let resumeAt = 0
  if ((ch.kind || 'live') !== 'live' && !isXtreamSeriesMarkerUrl(ch.url)) {
    const p = Progress.getProgress(ch.url)
    if (p) resumeAt = p.position
  }
  closeChannelDetail()
  openWatch(ch, { queue: sameRowQueue(ch), resumeAt })
}

/** @param {Ch} ch */
function openChannelDetail(ch) {
  detailModalCh = ch
  fillDetailModal(ch)
  const m = $('detail-modal')
  if (m) m.setAttribute('data-open', 'true')
}

/** @param {Ch} ch */
function fillDetailModal(ch) {
  const t = $('detail-modal-title')
  const meta = $('detail-meta')
  const epb = $('detail-epg-block')
  const body = $('detail-epg-body')
  const urlEl = $('detail-url')
  const favBtn = /** @type {HTMLButtonElement | null} */ ($('detail-fav'))
  const seriesBlock = $('detail-series-block')
  const seriesBody = $('detail-series-body')

  const isXtreamCatalogSeries =
    (ch.kind || 'live') === 'series' &&
    ch.seriesId != null &&
    isXtreamSeriesMarkerUrl(ch.url)

  if (seriesBody) seriesBody.innerHTML = ''
  if (seriesBlock) seriesBlock.hidden = true

  if (t) t.textContent = ch.name
  if (meta) {
    meta.textContent = `${ch.group || 'Uncategorised'} · ${(ch.kind || 'live').toUpperCase()}`
    if (ch.tvgId) meta.textContent += ` · tvg-id ${ch.tvgId}`
  }

  const { now, next } = getCombinedEpg(ch)

  if (body && epb) {
    if (
      isXtreamCatalogSeries ||
      (ch.kind || 'live') !== 'live' ||
      (!now?.title && !next?.title)
    ) {
      epb.hidden = true
      body.innerHTML = ''
    } else {
      epb.hidden = false
      /** @type {string[]} */
      const parts = []
      if (now?.title) {
        parts.push(
          `<div class="detail-slot"><div class="detail-slot-title">${escapeHtml(now.title)}</div>` +
            `<div class="detail-slot-time">${fmtClock(now.start)} · ${fmtClock(now.stop)}</div>` +
            (now.desc ? `<div class="detail-slot-desc">${escapeHtml(truncate(now.desc, 520))}</div>` : '') +
            '</div>'
        )
      }
      if (next?.title) {
        parts.push(
          `<div class="detail-slot"><div class="detail-slot-title">Next · ${escapeHtml(next.title)}</div>` +
            `<div class="detail-slot-time">${fmtClock(next.start)} · ${fmtClock(next.stop)}</div>` +
            (next.desc ? `<div class="detail-slot-desc">${escapeHtml(truncate(next.desc, 320))}</div>` : '') +
            '</div>'
        )
      }
      body.innerHTML = parts.join('') || '<div class="detail-slot-desc">No guide data.</div>'
    }
  }

  if (urlEl) {
    if (isXtreamCatalogSeries) urlEl.textContent = 'Loading episodes…'
    else urlEl.textContent = ch.url.length > 200 ? `${ch.url.slice(0, 120)}…` : ch.url
  }

  if (favBtn) favBtn.textContent = Pins.isFavorited(ch.url) ? 'Remove favourite' : 'Save favourite'

  if (isXtreamCatalogSeries) void loadDetailSeriesEpisodes(ch)
}

/** @param {string} raw */
function escapeHtml(raw) {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ─────────────────────────  Toast  ──────────────────────────────── */

let toastSeq = 0
/** @param {string} msg @param {'info'|'ok'|'error'} [tone] */
function toast(msg, tone = 'info') {
  const host = $('toast-host')
  if (!host) return
  const el = document.createElement('div')
  el.className = `toast ${tone === 'info' ? '' : tone}`
  el.textContent = msg
  el.dataset.id = String(++toastSeq)
  host.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity 220ms ease, transform 220ms ease'
    el.style.opacity = '0'
    el.style.transform = 'translateY(6px)'
  }, 3000)
  setTimeout(() => el.remove(), 3400)
}

/* ─────────────────────────  Xtream series & catalog URLs  ──────── */

/** @param {string} playlistId @param {number} seriesId */
function xtreamSeriesMarkerUrl(playlistId, seriesId) {
  return `https://iptv-viewer.local/${encodeURIComponent(playlistId)}/${seriesId}`
}

/** @param {string} [url] */
function isXtreamSeriesMarkerUrl(url) {
  return /^https:\/\/iptv-viewer\.local\//i.test(String(url || ''))
}

/** @param {{ id: string }} pl @param {unknown} channels */
function normalizeXtreamCatalogRows(pl, channels) {
  const list = Array.isArray(channels) ? channels : []
  return list.map((c) => {
    const row = /** @type {Ch} */ (/** @type {unknown} */ (c))
    if (row.kind === 'series' && row.seriesId != null) {
      return { ...row, url: xtreamSeriesMarkerUrl(pl.id, Number(row.seriesId)) }
    }
    return row
  })
}

/** @param {{ sourceType?: string; xtreamServer?: string; xtreamUser?: string; xtreamPass?: string }} pl */
function xtreamCredPayload(pl) {
  if (!pl || pl.sourceType !== 'xtream') return null
  const server = pl.xtreamServer?.trim()
  const username = pl.xtreamUser?.trim()
  const password = pl.xtreamPass != null ? String(pl.xtreamPass) : ''
  if (!server || !username || !password) return null
  return { server, username, password }
}

/** @param {Ch} ch */
async function fetchXtreamSeriesEpisodeData(ch) {
  const pl = state.loadedAccountId ? getPlaylist(state.loadedAccountId) : null
  const cred = xtreamCredPayload(pl)
  if (!cred || ch.seriesId == null) throw new Error('Series needs an Xtream account with server, user, and password.')
  const res = await fetch('/api/xtream/series-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cred, seriesId: ch.seriesId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText || 'Series lookup failed')
  return data
}

/**
 * Turn catalogue entries (e.g. series markers) into a concrete stream + resume point.
 * @param {Ch} ch
 * @param {{ resumeAt?: number }} [opts]
 */
async function resolveWatchPlayTarget(ch, opts = {}) {
  const k = ch.kind || 'live'
  if (k !== 'series' || ch.seriesId == null || !isXtreamSeriesMarkerUrl(ch.url)) {
    const resumeAt =
      k === 'live'
        ? Number.isFinite(opts.resumeAt)
          ? Number(opts.resumeAt)
          : 0
        : Number.isFinite(opts.resumeAt)
          ? Number(opts.resumeAt)
          : Progress.getProgress(ch.url)?.position || 0
    return { playCh: ch, resumeAt }
  }

  const data = await fetchXtreamSeriesEpisodeData(ch)
  const eps = Array.isArray(data.episodes) ? data.episodes : []
  if (!eps.length) throw new Error('No episodes for this series.')

  /** @type {typeof eps[0] | null} */ let pick = null
  let bestPos = -1
  for (const ep of eps) {
    const prog = Progress.getProgress(ep.url)
    const pos = prog?.position ?? 0
    if (pos > 60 && pos > bestPos) {
      bestPos = pos
      pick = ep
    }
  }
  if (!pick) pick = eps[0]
  const fromProg = Progress.getProgress(pick.url)?.position ?? 0
  const optRa = Number.isFinite(opts.resumeAt) ? Number(opts.resumeAt) : 0
  const resumeAt = fromProg > 30 ? fromProg : optRa
  const playCh = { ...ch, url: pick.url, name: `${ch.name} — ${pick.title}` }
  return { playCh, resumeAt }
}

/** @param {string} name */
function browseSectionKindRank(name) {
  const n = (name || '').trim()
  if (n.startsWith('Live ·')) return 0
  if (n.startsWith('Movies ·')) return 1
  if (n.startsWith('Series ·')) return 2
  return 9
}

function compareBrowseCategoryLabels(aLabel, bLabel) {
  const ra = browseSectionKindRank(aLabel)
  const rb = browseSectionKindRank(bLabel)
  if (ra !== rb) return ra - rb
  return String(aLabel).localeCompare(String(bLabel))
}

/** Daily seed so “Top picks” reshuffles once per day, not every paint */
function shuffleDaySeed() {
  const d = new Date()
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** @template T @param {T[]} arr @param {number} seed0 */
function shuffleDeterministic(arr, seed0) {
  const out = arr.slice()
  let seed = seed0 >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(1103515245, seed) + 12345) >>> 0
    const j = seed % (i + 1)
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

function vodAndSeriesTopRatedPool() {
  const v = pickFromKind('vod')
  const s = pickFromKind('series')
  return shuffleDeterministic([...v.slice(0, 500), ...s.slice(0, 500)], shuffleDaySeed())
}

/** @param {number} tail */
function recentlyAddedPosterPool(tail = 220) {
  const v = pickFromKind('vod')
  const s = pickFromKind('series')
  const merged = [...v.slice(-tail), ...s.slice(-tail)]
  merged.reverse()
  return merged.slice(0, 48)
}

/* ─────────────────────────  Theme & settings apply  ─────────────── */

function applyAccent() {
  const a = getAccent(settingsState.current.accent)
  const root = document.documentElement
  root.style.setProperty('--accent', a.accent)
  root.style.setProperty('--accent-dim', a.accentDim)
  const hex = a.accent
  root.style.setProperty('--accent-glow', hex + '73')
  root.style.setProperty('--accent-soft', hex + '29')
  root.style.setProperty('--accent-line', hex + '8c')
}

function applyReduceMotion() {
  document.documentElement.dataset.reduceMotion = settingsState.current.reduceMotion ? 'true' : 'false'
}

function applyAllSettings() {
  applyAccent()
  applyReduceMotion()
}

/* ─────────────────────────  Routing  ─────────────────────────────── */

const ROUTE_MAP = {
  home: 'view-home',
  browse: 'view-browse',
  watch: 'view-watch',
  accounts: 'view-accounts',
  'account-editor': 'view-account-editor',
  settings: 'view-settings',
}

const NAV_ACTIVE_BY_ROUTE = {
  home: 'nav-home',
  accounts: 'nav-account',
  'account-editor': 'nav-account',
  settings: 'nav-settings',
}

function syncNav() {
  const r = state.route
  let activeId = NAV_ACTIVE_BY_ROUTE[r] || ''
  if (r === 'browse') {
    if (state.favouritesOnly) activeId = 'nav-favourites'
    else if (state.kindFilter === 'live') activeId = 'nav-live'
    else if (state.kindFilter === 'vod') activeId = 'nav-movies'
    else if (state.kindFilter === 'series') activeId = 'nav-series'
    else activeId = 'nav-live'
  }
  $$('.nav-item').forEach((b) => b.setAttribute('data-current', b.id === activeId ? 'true' : 'false'))

  const acct = getActivePlaylistId() ? getPlaylist(getActivePlaylistId()) : null
  const initial = $('nav-account-initial')
  const label = $('nav-account-name')
  if (initial && label) {
    if (acct) {
      initial.textContent = (acct.name || '?').trim().charAt(0).toUpperCase() || '·'
      label.textContent = acct.name
    } else {
      initial.textContent = '+'
      label.textContent = 'Add account'
    }
  }
}

function syncSections() {
  for (const [route, id] of Object.entries(ROUTE_MAP)) {
    const el = $(id)
    if (!el) continue
    el.setAttribute('data-active', route === state.route ? 'true' : 'false')
  }
}

/** @param {AppRoute} route */
function setRoute(route) {
  if (state.route !== route) state.prevRoute = state.route
  // Stop playback when leaving watch view
  if (state.route === 'watch' && route !== 'watch') stopPlayback()
  state.route = route
  syncSections()
  syncNav()
  if (route === 'home') renderHome()
  if (route === 'browse') renderBrowse()
  if (route === 'accounts') renderAccounts()
  if (route === 'settings') renderSettingsForm()
  // Reset scroll
  requestAnimationFrame(() => {
    const shell = $('app-shell')
    if (shell) shell.scrollTop = 0
  })
}

/* ─────────────────────────  Player core  ─────────────────────────── */

async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

async function ensureHls() {
  if (window.Hls) return
  await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js')
}

function likelyHlsUrl(url) {
  const u = url.toLowerCase()
  return (
    u.includes('.m3u8') ||
    /[?&](format|output|type)=(m3u8|hls)\b/i.test(url) ||
    (u.includes('manifest') && (u.includes('m3u8') || u.includes('hls'))) ||
    u.includes('/hls/') ||
    u.includes('/hls_')
  )
}

function stopPlayback() {
  const video = /** @type {HTMLVideoElement | null} */ ($('player'))
  if (state.hls) {
    try { state.hls.destroy() } catch { /* noop */ }
    state.hls = null
  }
  if (video) {
    try { recordVideoProgress(video) } catch { /* noop */ }
    video.pause()
    video.removeAttribute('src')
    try { video.load() } catch { /* noop */ }
  }
  state.playingUrl = null
  state.playingCh = null
  state.playingQueue = []
  syncPlayingMarkers()
}

/** @param {HTMLVideoElement} video */
function recordVideoProgress(video) {
  if (!state.playingCh) return
  const pos = video.currentTime || 0
  const dur = video.duration && Number.isFinite(video.duration) ? video.duration : 0
  if (dur > 0 && pos > 0) Progress.recordProgress(state.playingCh, pos, dur)
}

/** @param {string} url @param {HTMLVideoElement} video */
async function attachStream(url, video) {
  if (state.hls) {
    try { state.hls.destroy() } catch { /* noop */ }
    state.hls = null
  }
  video.pause()
  video.removeAttribute('src')
  video.load()
  video.playsInline = true

  const useNative = Boolean(video.canPlayType('application/vnd.apple.mpegurl')) && likelyHlsUrl(url)
  if (useNative) {
    video.src = url
    return
  }

  await ensureHls()
  const HlsCtor = window.Hls
  if (HlsCtor?.isSupported() && likelyHlsUrl(url)) {
    const s = settingsState.current
    const hls = new HlsCtor({
      capLevelToPlayerSize: false,
      maxBufferLength: Math.max(10, Math.min(600, Number(s.hlsMaxBuffer) || 75)),
      maxMaxBufferLength: 180,
      backBufferLength: 120,
      lowLatencyMode: !!s.hlsLowLatency,
      enableWorker: true,
      manifestLoadingTimeOut: 120_000,
      levelLoadingTimeOut: 120_000,
      fragLoadingTimeOut: 120_000,
      fragLoadingMaxRetry: 32,
      manifestLoadingMaxRetry: 12,
      levelLoadingMaxRetry: 12,
    })
    state.hls = hls
    hls.on(HlsCtor.Events.ERROR, (_e, data) => {
      if (!data?.fatal) return
      if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad() } catch { /* noop */ }
      } else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError() } catch { /* noop */ }
      }
    })
    hls.loadSource(url)
    hls.attachMedia(video)
    return
  }
  video.src = url
}

function setWatchStatus(msg, tone = 'info') {
  const el = $('watch-status')
  if (!el) return
  if (!msg) { el.hidden = true; el.textContent = ''; return }
  el.hidden = false
  el.textContent = msg
  el.dataset.tone = tone
}

/**
 * Open the dedicated watch view for a channel.
 * @param {Ch} ch
 * @param {{ queue?: Ch[]; resumeAt?: number }} [opts]
 */
function openWatch(ch, opts = {}) {
  void (async () => {
    /** @type {Ch} */ let playCh
    /** @type {number} */ let resumeAt
    try {
      ;({ playCh, resumeAt } = await resolveWatchPlayTarget(ch, opts))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
      return
    }

    state.playingCh = playCh
    state.playingUrl = playCh.url
    const baseQueue = opts.queue != null ? opts.queue : sameRowQueue(ch)
    state.playingQueue = baseQueue.filter((c) => c.url !== playCh.url).slice(0, 30)
    setRoute('watch')

    const t = $('watch-title')
    const s = $('watch-sub')
    const pt = $('player-title')
    const ps = $('player-subtitle')
    if (t) t.textContent = playCh.name
    if (s) s.textContent = `${playCh.group || 'Uncategorised'} · ${(playCh.kind || 'live').toUpperCase()}`
    if (pt) pt.textContent = playCh.name
    if (ps) ps.textContent = playCh.group || ''
    syncPlayerFavIcon()
    renderUpNext()
    setWatchStatus('Loading stream…')
    setLoadingOverlay(true)

    const video = /** @type {HTMLVideoElement | null} */ ($('player'))
    if (!video) return
    video.volume = clamp(Number(settingsState.current.playerVolume) || 1, 0, 1)
    $('player-volume') && (/** @type {HTMLInputElement} */ ($('player-volume')).value = String(video.volume))
    attachStream(playCh.url, video).then(
      () => {
        const tryResume = () => {
          const target = Number.isFinite(resumeAt) ? resumeAt : null
          if (target && target > 5 && Number.isFinite(video.duration) && video.duration > target + 4) {
            try { video.currentTime = target } catch { /* noop */ }
          }
        }
        if (video.readyState >= 1) tryResume()
        else video.addEventListener('loadedmetadata', tryResume, { once: true })

        video.play().then(
          () => {
            Pins.pushRecentPlayed(playCh)
            setWatchStatus('')
            setLoadingOverlay(false)
          },
          () => setWatchStatus('Playback blocked or stream failed — try another channel.', 'error')
        )
      },
      (e) => {
        setLoadingOverlay(false)
        setWatchStatus(e.message || String(e), 'error')
      }
    )
    syncPlayingMarkers()
  })()
}

function setLoadingOverlay(on) {
  const el = $('player-loading')
  if (el) el.hidden = !on
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function syncPlayingMarkers() {
  const cur = state.playingUrl
  $$('.card[data-url]').forEach((el) => {
    el.classList.toggle('is-playing', cur != null && el.getAttribute('data-url') === cur)
  })
}

function syncPlayerFavIcon() {
  const btn = $('player-fav')
  if (!btn || !state.playingCh) return
  const on = Pins.isFavorited(state.playingCh.url)
  btn.style.color = on ? '#fbbf24' : ''
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
}

/* ─────────────────────────  Player overlay (custom UI)  ─────────── */

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '--:--'
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  const min = Math.floor((s / 60) % 60).toString().padStart(2, '0')
  const hr = Math.floor(s / 3600)
  return hr ? `${hr}:${min}:${sec}` : `${min}:${sec}`
}

let hideControlsTimer = null
function bumpControls() {
  const stage = $('player-stage')
  if (!stage) return
  stage.dataset.controls = 'visible'
  if (hideControlsTimer) clearTimeout(hideControlsTimer)
  hideControlsTimer = setTimeout(() => {
    const v = /** @type {HTMLVideoElement | null} */ ($('player'))
    if (!v || v.paused) return
    stage.dataset.controls = 'hidden'
  }, 2800)
}

function bindPlayerControls() {
  const video = /** @type {HTMLVideoElement} */ (need('player'))
  const stage = need('player-stage')
  const playBtn = need('player-play')
  const playIco = need('player-play-ico')
  const muteBtn = need('player-mute')
  const muteIco = need('player-mute-ico')
  const vol = /** @type {HTMLInputElement} */ (need('player-volume'))
  const time = need('player-time')
  const scrub = need('player-scrub')
  const fullBtn = need('player-fullscreen')
  const pipBtn = need('player-pip')
  const back10 = need('player-back10')
  const fwd10 = need('player-fwd10')
  const favBtn = need('player-fav')
  const back = need('watch-back')

  const playSvg = '<path d="M8 5v14l11-7z"/>'
  const pauseSvg = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
  const volOnSvg = '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
  const volOffSvg = '<path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>'

  playBtn.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  })
  back10.addEventListener('click', () => { try { video.currentTime = Math.max(0, video.currentTime - 10) } catch { /* */ } bumpControls() })
  fwd10.addEventListener('click', () => { try { video.currentTime = Math.min((video.duration || 1e9), video.currentTime + 10) } catch { /* */ } bumpControls() })

  muteBtn.addEventListener('click', () => { video.muted = !video.muted; refreshVolUi() })
  vol.addEventListener('input', () => {
    const v = clamp(Number(vol.value), 0, 1)
    video.volume = v
    if (v > 0) video.muted = false
    settingsState.current = updateSettings({ playerVolume: v })
    refreshVolUi()
  })

  function refreshVolUi() {
    muteIco.innerHTML = video.muted || video.volume === 0 ? volOffSvg : volOnSvg
    vol.value = video.muted ? '0' : String(video.volume)
  }

  video.addEventListener('play', () => { playIco.innerHTML = pauseSvg; bumpControls() })
  video.addEventListener('pause', () => { playIco.innerHTML = playSvg; bumpControls(); recordVideoProgress(video) })
  video.addEventListener('timeupdate', () => {
    const dur = video.duration && Number.isFinite(video.duration) ? video.duration : 0
    const pct = dur > 0 ? (video.currentTime / dur) * 100 : 0
    scrub.style.setProperty('--pct', `${pct.toFixed(2)}%`)
    time.textContent = dur > 0 ? `${fmtTime(video.currentTime)} / ${fmtTime(dur)}` : (video.currentTime ? fmtTime(video.currentTime) : 'Live')
  })
  video.addEventListener('ended', () => {
    if (settingsState.current.autoPlayNext && state.playingQueue.length) {
      const next = state.playingQueue.shift()
      if (next) openWatch(next, { queue: state.playingQueue })
    }
  })
  let progressBeat = null
  video.addEventListener('playing', () => {
    if (progressBeat) clearInterval(progressBeat)
    progressBeat = setInterval(() => recordVideoProgress(video), 8000)
  })
  video.addEventListener('pause', () => { if (progressBeat) { clearInterval(progressBeat); progressBeat = null } })

  scrub.addEventListener('click', (e) => {
    const rect = scrub.getBoundingClientRect()
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    if (Number.isFinite(video.duration) && video.duration > 0) {
      try { video.currentTime = ratio * video.duration } catch { /* */ }
    }
    bumpControls()
  })
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { try { video.currentTime = Math.max(0, video.currentTime - 5) } catch { /* */ } }
    else if (e.key === 'ArrowRight') { try { video.currentTime = Math.min((video.duration || 1e9), video.currentTime + 5) } catch { /* */ } }
  })

  fullBtn.addEventListener('click', () => {
    const el = stage
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  })
  pipBtn.addEventListener('click', () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture?.().catch(() => {})
    else /** @type {any} */ (video).requestPictureInPicture?.().catch(() => {})
  })

  back.addEventListener('click', () => setRoute(state.prevRoute === 'watch' ? 'home' : state.prevRoute || 'home'))

  favBtn.addEventListener('click', () => {
    if (!state.playingCh) return
    Pins.toggleFavorite(state.playingCh)
    syncPlayerFavIcon()
    if (state.route === 'home') renderHome()
  })

  // Show controls on mouse / key
  stage.addEventListener('mousemove', bumpControls)
  stage.addEventListener('mouseenter', bumpControls)
  stage.addEventListener('mouseleave', () => {
    if (!video.paused) stage.dataset.controls = 'hidden'
  })
  stage.addEventListener('click', (e) => {
    // tap-to-toggle for video / overlay backdrop, but not the controls
    const t = /** @type {HTMLElement} */ (e.target)
    if (t.closest('.player-controls') || t.closest('.player-scrub') || t.closest('.player-top')) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  })

  document.addEventListener('keydown', (e) => {
    if (state.route !== 'watch') return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); video.paused ? video.play().catch(()=>{}) : video.pause() }
    else if (e.key === 'ArrowLeft') { try { video.currentTime = Math.max(0, video.currentTime - 5) } catch { /* */ } }
    else if (e.key === 'ArrowRight') { try { video.currentTime = Math.min((video.duration || 1e9), video.currentTime + 5) } catch { /* */ } }
    else if (e.key.toLowerCase() === 'f') { fullBtn.click() }
    else if (e.key.toLowerCase() === 'm') { muteBtn.click() }
    else if (e.key === 'Escape' && !document.fullscreenElement) { setRoute(state.prevRoute || 'home') }
  })

  // initial UI
  refreshVolUi()
  bumpControls()

  // Save progress on page unload
  window.addEventListener('beforeunload', () => recordVideoProgress(video))
}

/* ─────────────────────────  Cards  ───────────────────────────────── */

/**
 * @param {Ch} ch
 * @param {{ kind?: 'tile' | 'continue'; progress?: number; queue?: Ch[]; sub?: string }} [opts]
 */
function makeCard(ch, opts = {}) {
  const card = document.createElement('div')
  card.className = `card ${opts.kind === 'continue' ? 'continue' : ''}`.trim()
  const kind = ch.kind || 'live'
  if (kind === 'vod' || kind === 'series') card.classList.add('card--poster')
  else card.classList.add('card--live')
  card.dataset.url = ch.url
  card.setAttribute('role', 'button')
  card.tabIndex = 0
  card.setAttribute('aria-label', `Play ${ch.name}`)

  const playFromCard = () => {
    const queue = opts.queue || sameRowQueue(ch)
    let resumeAt = 0
    if (kind !== 'live' && !isXtreamSeriesMarkerUrl(ch.url)) {
      const p = Progress.getProgress(ch.url)
      if (p) resumeAt = p.position
    }
    openWatch(ch, { queue, resumeAt })
  }

  card.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target)
    if (t.closest('.badge-fav') || t.closest('.badge-info')) return
    playFromCard()
  })
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (/** @type {HTMLElement} */ (e.target).closest('.badge-fav, .badge-info')) return
    e.preventDefault()
    playFromCard()
  })

  const thumb = document.createElement('div')
  thumb.className = 'thumb'

  const fallback = document.createElement('div')
  fallback.className = 'fallback'
  const initials = (ch.name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
  fallback.innerHTML = `<span class="initials">${initials || '?'}</span>`
  thumb.appendChild(fallback)

  if (ch.logo) {
    const img = document.createElement('img')
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('load', () => { img.classList.add('loaded'); fallback.style.opacity = '0' })
    img.addEventListener('error', () => { img.remove() })
    img.src = ch.logo
    thumb.appendChild(img)
  }

  const baseSub =
    opts.sub ||
    ch.group ||
    (kind === 'live' ? 'Live channel' : kind === 'vod' ? 'Movie' : 'Series')
  const subline = getCardSubline(ch, { sub: baseSub })

  const overlayLayer = document.createElement('div')
  overlayLayer.className = 'thumb-overlay'
  const ovGrad = document.createElement('div')
  ovGrad.className = 'thumb-overlay-grad'
  const ovInner = document.createElement('div')
  ovInner.className = 'thumb-overlay-inner'
  const ovTitle = document.createElement('div')
  ovTitle.className = 'thumb-overlay-title'
  ovTitle.textContent = ch.name
  const ovSubline = document.createElement('div')
  ovSubline.className = 'thumb-overlay-sub'
  ovSubline.textContent = subline
  ovInner.append(ovTitle, ovSubline)
  overlayLayer.append(ovGrad, ovInner)
  thumb.appendChild(overlayLayer)

  // Live pill / kind pill
  const pill = document.createElement('span')
  pill.className = `kind-pill ${kind === 'live' ? 'live' : ''}`
  pill.textContent = kind === 'vod' ? 'MOVIE' : kind === 'series' ? 'SERIES' : 'LIVE'
  thumb.appendChild(pill)

  // Favourite badge
  const fav = document.createElement('button')
  fav.type = 'button'
  fav.className = 'badge-fav'
  fav.setAttribute('aria-label', 'Toggle favourite')
  const isFav = Pins.isFavorited(ch.url)
  fav.dataset.on = isFav ? 'true' : 'false'
  fav.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>'
  fav.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    const on = Pins.toggleFavorite(ch)
    fav.dataset.on = on ? 'true' : 'false'
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
  })
  thumb.appendChild(fav)

  const info = document.createElement('button')
  info.type = 'button'
  info.className = 'badge-info'
  info.setAttribute('aria-label', 'Channel details')
  info.textContent = 'i'
  info.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    openChannelDetail(ch)
  })
  thumb.appendChild(info)

  // Play overlay
  const ov = document.createElement('span')
  ov.className = 'play-overlay'
  ov.innerHTML = '<span class="play-overlay-circle"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>'
  thumb.appendChild(ov)

  // Progress bar
  if (Number.isFinite(opts.progress) && /** @type {number} */ (opts.progress) > 0) {
    const pb = document.createElement('div')
    pb.className = 'progress-bar'
    const fill = document.createElement('span')
    fill.style.width = `${Math.max(2, Math.min(100, /** @type {number} */ (opts.progress) * 100)).toFixed(1)}%`
    pb.appendChild(fill)
    thumb.appendChild(pb)
  }

  card.appendChild(thumb)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = ch.name
  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.dataset.baseSub = baseSub
  sub.textContent = subline
  meta.append(name, sub)
  card.appendChild(meta)

  if (state.playingUrl === ch.url) card.classList.add('is-playing')

  return card
}

/** Build a small "Up next" queue from currently filtered channels. */
function sameRowQueue(ch) {
  const k = ch.kind || 'live'
  const byKind = filterByContentKind(state.channels, k)
  const g = (ch.group || '').trim()
  const pool = g ? byKind.filter((c) => (c.group || '').trim() === g) : byKind
  return pool.filter((c) => c.url !== ch.url).slice(0, 24)
}

function makeSkeletonCard() {
  const card = document.createElement('div')
  card.className = 'card skeleton'
  card.innerHTML = '<div class="thumb"></div><div class="meta"><div class="name"></div><div class="sub"></div></div>'
  return card
}

/* ─────────────────────────  Carousel rows  ──────────────────────── */

/**
 * @param {string} title
 * @param {Ch[]} items
 * @param {{ id?: string; emptyText?: string; sub?: (ch: Ch) => string; kind?: 'tile' | 'continue'; progress?: (ch: Ch) => number; onSeeAll?: () => void; queue?: Ch[]; skeleton?: boolean }} opts
 */
function makeRow(title, items, opts = {}) {
  const row = document.createElement('section')
  row.className = 'row'
  if (opts.id) row.id = opts.id

  const head = document.createElement('div')
  head.className = 'row-head'
  const h = document.createElement('h3')
  h.className = 'row-title'
  h.textContent = title
  head.appendChild(h)
  if (opts.onSeeAll) {
    const link = document.createElement('button')
    link.className = 'row-link'
    link.textContent = 'See all →'
    link.addEventListener('click', opts.onSeeAll)
    head.appendChild(link)
  }
  row.appendChild(head)

  const carousel = document.createElement('div')
  carousel.className = 'carousel'
  const scroll = document.createElement('div')
  scroll.className = 'carousel-scroll'

  if (opts.skeleton) {
    for (let i = 0; i < 8; i++) scroll.appendChild(makeSkeletonCard())
  } else if (!items.length) {
    const e = document.createElement('div')
    e.style.padding = '0 var(--space-8)'
    e.style.color = 'var(--muted)'
    e.style.fontSize = '0.92rem'
    e.textContent = opts.emptyText || 'Nothing here yet.'
    row.appendChild(e)
    return row
  } else {
    for (const ch of items) {
      const sub = opts.sub ? opts.sub(ch) : undefined
      const progress = opts.progress ? opts.progress(ch) : undefined
      scroll.appendChild(
        makeCard(ch, { kind: opts.kind, sub, progress, queue: opts.queue || items })
      )
    }
  }
  carousel.appendChild(scroll)

  // Arrows
  const left = document.createElement('button')
  left.className = 'carousel-arrow left'
  left.setAttribute('aria-label', 'Scroll left')
  left.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'
  const right = document.createElement('button')
  right.className = 'carousel-arrow right'
  right.setAttribute('aria-label', 'Scroll right')
  right.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
  const step = () => Math.max(220, scroll.clientWidth * 0.92)
  left.addEventListener('click', () => scroll.scrollBy({ left: -step(), behavior: 'smooth' }))
  right.addEventListener('click', () => scroll.scrollBy({ left: step(), behavior: 'smooth' }))
  carousel.append(left, right)

  row.appendChild(carousel)
  return row
}

/* ─────────────────────────  Filtering  ──────────────────────────── */

function searchFilter(list) {
  const q = state.searchTerm.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.group && c.group.toLowerCase().includes(q)) ||
      c.url.toLowerCase().includes(q)
  )
}

function pickFromKind(kind) { return filterByContentKind(state.channels, kind) }

function kindCounts() {
  let live = 0, vod = 0, series = 0
  for (const c of state.channels) {
    const k = c.kind || 'live'
    if (k === 'live') live++
    else if (k === 'vod') vod++
    else series++
  }
  const favs = Pins.loadFavorites().length
  return { all: state.channels.length, live, vod, series, favourites: favs }
}

function updateChipCounts() {
  const c = kindCounts()
  $$('#browse-chips [data-kc]').forEach((el) => {
    const k = el.getAttribute('data-kc')
    if (k && c[k] != null) el.textContent = String(c[k])
  })
}

function syncBrowseChips() {
  $$('#browse-chips .chip').forEach((b) => {
    if (b.hasAttribute('data-favs')) {
      b.setAttribute('data-active', state.favouritesOnly ? 'true' : 'false')
    } else {
      const k = b.getAttribute('data-kind')
      b.setAttribute('data-active', !state.favouritesOnly && k === state.kindFilter ? 'true' : 'false')
    }
  })
}

/* ─────────────────────────  Home view  ──────────────────────────── */

function pickHeroPool() {
  const live = filterByContentKind(state.channels, 'live')
  const withLogo = live.filter((c) => !!c.logo)
  const pool = withLogo.length >= 3 ? withLogo : live
  // Prefer items with rich names, shuffle a little for freshness
  return pool.slice(0, 24)
}

function applyHero(ch) {
  state.heroCurrent = ch
  const art = $('hero-art')
  const eyebrow = $('hero-eyebrow')
  const title = $('hero-title')
  const desc = $('hero-desc')
  const meta1 = $('hero-meta-1')
  const meta2 = $('hero-meta-2')
  const primary = $('hero-cta-primary')
  const primaryLabel = $('hero-cta-primary-label')
  const secondary = $('hero-cta-secondary')
  const secondaryLabel = $('hero-cta-secondary-label')

  if (!ch) {
    if (art) art.style.backgroundImage = ''
    return
  }

  if (art) {
    if (ch.logo) {
      art.style.backgroundImage = `url(${JSON.stringify(ch.logo)})`
      art.style.opacity = '0.6'
    } else {
      art.style.backgroundImage = ''
      art.style.opacity = '0.4'
    }
  }
  if (eyebrow) eyebrow.textContent = (ch.kind === 'vod' ? 'Featured movie' : ch.kind === 'series' ? 'Featured series' : 'Featured live')
  if (title) title.textContent = ch.name
  if (meta1) meta1.textContent = ch.group || 'Live now'
  if (meta2) {
    let line = (ch.kind || 'live').toUpperCase()
    if ((ch.kind || 'live') === 'live') {
      const { now } = getCombinedEpg(ch)
      if (now?.title) line += ` · ${truncate(now.title, 42)}`
    }
    meta2.textContent = line
  }
  if (desc) desc.textContent = `Tap play to start streaming. Use the queue below to keep watching without lifting a finger.`

  if (primary && primaryLabel) {
    primaryLabel.textContent = 'Play now'
    primary.onclick = () => openWatch(ch, { queue: state.heroPool })
  }
  if (secondary && secondaryLabel) {
    secondaryLabel.textContent = 'More like this'
    secondary.onclick = () => {
      state.kindFilter = (ch.kind || 'live')
      state.favouritesOnly = false
      setRoute('browse')
    }
  }
}

function renderHeroDots() {
  const dots = $('hero-dots')
  if (!dots) return
  dots.innerHTML = ''
  if (state.heroPool.length < 2) { dots.hidden = true; return }
  const max = Math.min(state.heroPool.length, 5)
  for (let i = 0; i < max; i++) {
    const b = document.createElement('button')
    b.setAttribute('aria-label', `Featured ${i + 1}`)
    b.dataset.active = (i === state.heroIndex % max) ? 'true' : 'false'
    b.addEventListener('click', () => { state.heroIndex = i; applyHero(state.heroPool[state.heroIndex]); renderHeroDots(); restartHeroTimer() })
    dots.appendChild(b)
  }
  dots.hidden = false
}

function startHeroRotation() {
  stopHeroTimer()
  if (!settingsState.current.heroAutoRotate) return
  if (settingsState.current.reduceMotion) return
  if (state.heroPool.length < 2) return
  state.heroTimer = setInterval(() => {
    state.heroIndex = (state.heroIndex + 1) % state.heroPool.length
    applyHero(state.heroPool[state.heroIndex])
    renderHeroDots()
  }, 9000)
}

function restartHeroTimer() { startHeroRotation() }

function stopHeroTimer() {
  if (state.heroTimer) { clearInterval(state.heroTimer); state.heroTimer = null }
}

function renderHomeEmptyHero() {
  const eyebrow = $('hero-eyebrow')
  const title = $('hero-title')
  const desc = $('hero-desc')
  const meta1 = $('hero-meta-1')
  const meta2 = $('hero-meta-2')
  const primary = $('hero-cta-primary')
  const primaryLabel = $('hero-cta-primary-label')
  const secondary = $('hero-cta-secondary')
  const secondaryLabel = $('hero-cta-secondary-label')
  const art = $('hero-art')

  const accounts = loadPlaylists()
  const active = getActivePlaylistId() ? getPlaylist(getActivePlaylistId()) : null
  const hour = new Date().getHours()
  const tod = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  if (art) art.style.backgroundImage = ''
  if (eyebrow) eyebrow.textContent = tod
  if (meta1) meta1.textContent = active ? `Active: ${active.name}` : `${accounts.length} saved account${accounts.length === 1 ? '' : 's'}`
  if (meta2) meta2.textContent = active ? 'Loading…' : 'Add an account to start'

  if (!accounts.length) {
    if (title) title.textContent = 'Add your first account'
    if (desc) desc.textContent = 'Connect an M3U URL or Xtream Codes login to start watching. Same flow as IPTV Smarters or TiviMate.'
    if (primary && primaryLabel) { primaryLabel.textContent = 'Add account'; primary.onclick = () => openAccountEditor(null) }
    if (secondary && secondaryLabel) { secondaryLabel.textContent = 'How it works'; secondary.onclick = () => toast('Add a playlist or paste M3U text. Switch accounts anytime from the top bar.', 'info') }
    return
  }

  if (title) title.textContent = active ? `${tod}, welcome back` : 'Pick an account'
  if (desc) desc.textContent = active
    ? 'We\'re loading your library. Once channels are in, you\'ll find them in the rows below.'
    : 'You have saved accounts ready to go. Pick one to load its channels.'
  if (primary && primaryLabel) {
    if (active) { primaryLabel.textContent = 'Browse Live TV'; primary.onclick = () => { state.kindFilter = 'live'; state.favouritesOnly = false; setRoute('browse'); void ensureLibraryLoaded() } }
    else { primaryLabel.textContent = 'Manage accounts'; primary.onclick = () => setRoute('accounts') }
  }
  if (secondary && secondaryLabel) { secondaryLabel.textContent = 'Add another account'; secondary.onclick = () => openAccountEditor(null) }
}

function renderHome() {
  stopHeroTimer()
  const rowsHost = $('home-rows')
  if (!rowsHost) return
  rowsHost.innerHTML = ''

  // Hero
  if (state.channels.length) {
    state.heroPool = pickHeroPool()
    state.heroIndex = state.heroIndex % Math.max(1, state.heroPool.length)
    if (state.heroPool.length) {
      applyHero(state.heroPool[state.heroIndex])
      renderHeroDots()
      startHeroRotation()
    } else {
      renderHomeEmptyHero()
    }
  } else {
    renderHomeEmptyHero()
    const dots = $('hero-dots'); if (dots) dots.hidden = true
  }

  // Continue Watching
  if (settingsState.current.showRecents) {
    const inProgress = Progress.loadInProgress()
    if (inProgress.length) {
      const items = inProgress.map((p) => {
        // try to find the channel in current state
        const match = state.channels.find((c) => c.url === p.url)
        return /** @type {Ch} */ (match || { name: p.name, url: p.url, logo: p.logo, group: p.group, kind: p.kind || 'vod' })
      })
      const progressMap = new Map(inProgress.map((p) => [p.url, p.duration > 0 ? p.position / p.duration : 0]))
      rowsHost.appendChild(makeRow('Continue watching', items, {
        id: 'row-continue',
        kind: 'continue',
        progress: (ch) => progressMap.get(ch.url) || 0,
        sub: (ch) => {
          const p = inProgress.find((r) => r.url === ch.url)
          return p ? `${fmtTime(p.duration - p.position)} left` : (ch.group || '')
        },
      }))
    }
  }

  // Recently watched → “Catch up”
  if (settingsState.current.showRecents) {
    const recent = Pins.loadRecent()
    if (recent.length) {
      const items = recent.slice(0, 18).map((r) => {
        const found = state.channels.find((c) => c.url === r.url)
        return /** @type {Ch} */ (found || { name: r.name, url: r.url, logo: r.logo, group: r.group, kind: 'live' })
      })
      rowsHost.appendChild(makeRow('Catch up where you left off', items, { id: 'row-recent' }))
    }
  }

  // Trending → live marquee
  const live = pickFromKind('live')
  if (live.length) {
    rowsHost.appendChild(makeRow('Trending now', live.slice(0, 24), {
      id: 'row-trending',
      onSeeAll: () => { state.kindFilter = 'live'; state.favouritesOnly = false; setRoute('browse') },
    }))
  }

  // Editorial-style rows for on-demand catalogue
  const topPool = vodAndSeriesTopRatedPool()
  if (topPool.length) {
    rowsHost.appendChild(makeRow('Top picks for you', topPool.slice(0, 24), {
      id: 'row-top',
      onSeeAll: () => { state.kindFilter = 'vod'; state.favouritesOnly = false; setRoute('browse') },
    }))
  }

  const recentAdded = recentlyAddedPosterPool()
  if (recentAdded.length) {
    rowsHost.appendChild(makeRow('Recently added', recentAdded.slice(0, 24), {
      id: 'row-recent-added',
      onSeeAll: () => { state.kindFilter = 'all'; state.favouritesOnly = false; setRoute('browse') },
    }))
  }

  const movies = pickFromKind('vod')
  if (movies.length) {
    rowsHost.appendChild(makeRow('Popular movies', movies.slice(0, 24), {
      id: 'row-movies',
      onSeeAll: () => { state.kindFilter = 'vod'; state.favouritesOnly = false; setRoute('browse') },
    }))
  }

  const series = pickFromKind('series')
  if (series.length) {
    rowsHost.appendChild(makeRow('Popular series', series.slice(0, 24), {
      id: 'row-series',
      onSeeAll: () => { state.kindFilter = 'series'; state.favouritesOnly = false; setRoute('browse') },
    }))
  }

  // Favourites
  if (settingsState.current.showFavorites) {
    const favs = Pins.loadFavorites()
    if (favs.length) {
      const items = favs.slice(0, 24).map((f) => {
        const found = state.channels.find((c) => c.url === f.url)
        return /** @type {Ch} */ (found || { name: f.name, url: f.url, logo: f.logo, group: f.group, kind: 'live' })
      })
      rowsHost.appendChild(makeRow('Your favourites', items, {
        id: 'row-favs',
        onSeeAll: () => { state.favouritesOnly = true; state.kindFilter = 'all'; setRoute('browse') },
      }))
    }
  }

  // When an account is configured but channels aren't loaded yet
  if (!state.channels.length && state.isLoading) {
    rowsHost.appendChild(makeRow('Trending now', [], { skeleton: true }))
    rowsHost.appendChild(makeRow('Popular movies', [], { skeleton: true }))
  }

  // Subtle "Add account" CTA at the bottom if there's room
  if (!state.channels.length && !state.isLoading) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.style.marginTop = 'var(--space-8)'
    empty.innerHTML = `
      <div class="ico">📺</div>
      <h3>Nothing to watch yet</h3>
      <p>Add a playlist or Xtream Codes login. Your channels will appear here as rich rows.</p>
      <div class="empty-actions">
        <button class="btn btn-accent" id="home-empty-add">Add account</button>
        <button class="btn btn-ghost" id="home-empty-accounts">Manage accounts</button>
      </div>
    `
    rowsHost.appendChild(empty)
    bind('home-empty-add', 'click', () => openAccountEditor(null))
    bind('home-empty-accounts', 'click', () => setRoute('accounts'))
  }

  syncPlayingMarkers()
}

/* ─────────────────────────  Browse view  ────────────────────────── */

function renderBrowse() {
  syncBrowseChips()
  updateChipCounts()
  const bsSync = $('browse-search')
  if (bsSync instanceof HTMLInputElement) state.searchTerm = bsSync.value
  const meta = $('browse-meta')
  const empty = $('browse-empty')
  const content = $('browse-content')
  if (!meta || !content || !empty) return
  content.innerHTML = ''

  if (!state.channels.length) {
    empty.hidden = false
    if (loadPlaylists().length === 0) {
      $('browse-empty-title').textContent = 'No accounts yet'
      $('browse-empty-desc').textContent = 'Add an account to load M3U or Xtream channels.'
    } else {
      $('browse-empty-title').textContent = 'Library is empty'
      $('browse-empty-desc').textContent = 'Pick an account from Accounts, or wait for auto-load to finish.'
    }
    meta.textContent = ''
    return
  }
  empty.hidden = true

  // Compute filtered list
  let list = state.favouritesOnly ? favouritesList() : pickFromKind(state.kindFilter)
  list = searchFilter(list)

  const total = list.length
  const sourceLabel = state.favouritesOnly
    ? 'Favourites'
    : state.kindFilter === 'all' ? 'All channels'
    : state.kindFilter === 'vod' ? 'Movies'
    : state.kindFilter === 'series' ? 'Series'
    : 'Live TV'
  meta.textContent = `${total} ${total === 1 ? 'item' : 'items'} · ${sourceLabel}${state.searchTerm.trim() ? ` · "${state.searchTerm.trim()}"` : ''}`

  // If searching or favourites, show grid; otherwise show category rows
  const useGrid = !!state.searchTerm.trim() || state.favouritesOnly || state.kindFilter !== 'all' && groupCount(list) <= 1

  if (useGrid) {
    const grid = document.createElement('div')
    grid.className = 'poster-grid'
    if (!list.length) {
      grid.innerHTML = '<div class="empty" style="grid-column: 1/-1"><div class="ico">🔍</div><h3>No matches</h3><p>Try a different search or filter.</p></div>'
    } else {
      const slice = list.slice(0, 240) // cap initial render for perf
      for (const ch of slice) grid.appendChild(makeCard(ch, { queue: list }))
      if (list.length > slice.length) {
        const more = document.createElement('div')
        more.style.gridColumn = '1/-1'
        more.style.textAlign = 'center'
        more.style.padding = 'var(--space-5)'
        const btn = document.createElement('button')
        btn.className = 'btn btn-ghost'
        btn.textContent = `Load more (${list.length - slice.length} remaining)`
        btn.addEventListener('click', () => {
          const next = list.slice(slice.length, slice.length + 240)
          for (const ch of next) grid.insertBefore(makeCard(ch, { queue: list }), more)
          slice.push(...next)
          if (slice.length >= list.length) more.remove()
          else btn.textContent = `Load more (${list.length - slice.length} remaining)`
        })
        more.appendChild(btn)
        grid.appendChild(more)
      }
    }
    content.appendChild(grid)
  } else {
    const rowsHost = document.createElement('div')
    rowsHost.className = 'browse-rows'
    /** @type {Map<string, Ch[]>} */
    const groups = new Map()
    for (const c of list) {
      const k = (c.group || 'Uncategorised').trim() || 'Uncategorised'
      if (!groups.has(k)) groups.set(k, [])
      const arr = groups.get(k)
      if (arr) arr.push(c)
    }
    const sorted = [...groups.entries()].sort((a, b) => {
      const byKind = compareBrowseCategoryLabels(a[0], b[0])
      if (byKind !== 0) return byKind
      return b[1].length - a[1].length
    })
    for (const [name, items] of sorted) {
      rowsHost.appendChild(makeRow(name, items.slice(0, 30), {
        sub: () => name,
        queue: items,
        onSeeAll: items.length > 30 ? () => { state.searchTerm = name; const s = $('browse-search'); if (s instanceof HTMLInputElement) s.value = name; renderBrowse() } : undefined,
      }))
    }
    content.appendChild(rowsHost)
  }
}

function favouritesList() {
  const favs = Pins.loadFavorites()
  return favs.map((f) => {
    const found = state.channels.find((c) => c.url === f.url)
    return /** @type {Ch} */ (found || { name: f.name, url: f.url, logo: f.logo, group: f.group, kind: 'live' })
  })
}

function groupCount(list) {
  const set = new Set()
  for (const c of list) set.add((c.group || 'Uncategorised').trim() || 'Uncategorised')
  return set.size
}

/* ─────────────────────────  Up Next (watch view)  ────────────────── */

function renderUpNext() {
  const host = $('watch-up-next')
  if (!host) return
  host.innerHTML = ''
  if (!state.playingQueue.length) return
  host.appendChild(makeRow('Up next', state.playingQueue.slice(0, 24), { queue: state.playingQueue }))
}

/* ─────────────────────────  Loading content  ────────────────────── */

/** @param {Ch[]} entries @param {{ accountId?: string | null; toastMsg?: string }} [opts] */
function applyChannels(entries, opts = {}) {
  for (const ch of entries) assignContentKind(ch)
  state.channels = entries
  state.loadedAccountId = opts.accountId ?? null
  state.isLoading = false
  if (state.route === 'home') renderHome()
  if (state.route === 'browse') renderBrowse()
  if (opts.toastMsg) toast(opts.toastMsg, entries.length ? 'ok' : 'error')
  scheduleEpgLoad()
}

async function fetchPlaylistUrl(url) {
  const ua = settingsState.current.fetchUserAgent
  const res = await fetch('/api/playlist/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ua ? { url: url.trim(), userAgent: ua } : { url: url.trim() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText || 'Fetch failed')
  return data.body
}

/** @param {{ id: string; name: string; sourceType: string; m3uUrl?: string; m3uText?: string; xtreamServer?: string; xtreamUser?: string; xtreamPass?: string }} pl */
async function loadAccount(pl, { silent = false } = {}) {
  state.isLoading = true
  if (state.route === 'home') renderHome()
  try {
    if (pl.sourceType === 'm3u-url') {
      const u = pl.m3uUrl?.trim()
      if (!u) throw new Error('Missing M3U URL')
      if (extractXtreamFromPortalUrl(u)) {
        const res = await fetch('/api/xtream/catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portalUrl: u }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || res.statusText)
        applyChannels(normalizeXtreamCatalogRows(pl, data.channels || []), { accountId: pl.id })
      } else {
        const body = await fetchPlaylistUrl(u)
        applyChannels(parseM3u(body), { accountId: pl.id })
      }
    } else if (pl.sourceType === 'm3u-inline') {
      applyChannels(parseM3u(pl.m3uText || ''), { accountId: pl.id })
    } else {
      const server = pl.xtreamServer?.trim()
      const username = pl.xtreamUser?.trim()
      const password = pl.xtreamPass != null ? String(pl.xtreamPass) : ''
      if (!server || !username || !password) throw new Error('Incomplete Xtream credentials')
      const res = await fetch('/api/xtream/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      applyChannels(normalizeXtreamCatalogRows(pl, data.channels || []), { accountId: pl.id })
    }
    setActivePlaylistId(pl.id)
    syncNav()
    if (!silent) toast(`Loaded "${pl.name}".`, 'ok')
    return true
  } catch (e) {
    state.isLoading = false
    const msg = (/** @type {Error} */ (e)).message
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
    toast(`Failed to load "${pl.name}": ${msg}`, 'error')
    return false
  }
}

async function ensureLibraryLoaded() {
  if (state.channels.length || state.isLoading) return
  const id = getActivePlaylistId()
  const pl = id ? getPlaylist(id) : null
  if (!pl) {
    const list = loadPlaylists()
    if (!list.length) return
    setActivePlaylistId(list[0].id)
    await loadAccount(list[0], { silent: true })
    return
  }
  await loadAccount(pl, { silent: true })
}

/* ─────────────────────────  Accounts view  ──────────────────────── */

function sourceLabel(t) {
  if (t === 'm3u-url') return 'M3U URL'
  if (t === 'm3u-inline') return 'M3U paste'
  return 'Xtream'
}

function relativeAge(ts) {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'updated just now'
  if (diff < 3600_000) return `updated ${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `updated ${Math.floor(diff / 3600_000)}h ago`
  return `updated ${new Date(ts).toLocaleDateString()}`
}

/** @param {{ id: string; name: string; sourceType: string; updatedAt: number }} pl */
function accountCard(pl) {
  const card = document.createElement('article')
  card.className = 'acct-card'
  const isActive = getActivePlaylistId() === pl.id
  card.dataset.active = String(isActive)

  const head = document.createElement('div')
  head.className = 'acct-head'

  const avatar = document.createElement('div')
  avatar.className = 'acct-avatar'
  avatar.textContent = (pl.name || '?').trim().charAt(0).toUpperCase() || '?'

  const meta = document.createElement('div')
  meta.style.flex = '1'
  meta.style.minWidth = '0'
  const name = document.createElement('h3')
  name.className = 'acct-name'
  name.textContent = pl.name
  const subRow = document.createElement('div')
  subRow.className = 'acct-meta'
  const src = document.createElement('span')
  src.className = 'badge-source'
  src.textContent = sourceLabel(pl.sourceType)
  subRow.appendChild(src)
  if (isActive) {
    const a = document.createElement('span')
    a.className = 'badge-active'
    a.textContent = 'Active'
    subRow.appendChild(a)
  }
  const age = document.createElement('span')
  age.style.color = 'var(--muted)'
  age.style.fontSize = '0.78rem'
  age.textContent = relativeAge(pl.updatedAt)
  subRow.appendChild(age)
  meta.append(name, subRow)
  head.append(avatar, meta)

  const actions = document.createElement('div')
  actions.className = 'acct-actions'
  const open = document.createElement('button')
  open.className = 'btn btn-accent btn-sm'
  open.textContent = isActive ? 'Reload' : 'Open'
  open.addEventListener('click', async () => {
    open.disabled = true
    open.textContent = 'Loading…'
    state.kindFilter = settingsState.current.defaultKind === 'all' ? 'live' : settingsState.current.defaultKind
    state.favouritesOnly = false
    setRoute('home')
    await loadAccount(pl)
  })
  actions.appendChild(open)

  if (!isActive) {
    const setActive = document.createElement('button')
    setActive.className = 'btn btn-ghost btn-sm'
    setActive.textContent = 'Set active'
    setActive.addEventListener('click', () => {
      setActivePlaylistId(pl.id)
      renderAccounts(); syncNav()
      toast(`"${pl.name}" set as active.`, 'ok')
    })
    actions.appendChild(setActive)
  }
  const edit = document.createElement('button')
  edit.className = 'btn btn-ghost btn-sm'
  edit.textContent = 'Edit'
  edit.addEventListener('click', () => openAccountEditor(pl.id))
  actions.appendChild(edit)

  const del = document.createElement('button')
  del.className = 'btn btn-danger btn-sm'
  del.textContent = 'Remove'
  del.addEventListener('click', () => {
    if (settingsState.current.confirmRemove && !confirm(`Remove "${pl.name}" from this device?`)) return
    if (getActivePlaylistId() === pl.id) setActivePlaylistId('')
    deletePlaylist(pl.id)
    if (state.loadedAccountId === pl.id) {
      state.channels = []
      state.loadedAccountId = null
      stopPlayback()
    }
    renderAccounts(); syncNav()
    toast(`Removed "${pl.name}".`, 'ok')
  })
  actions.appendChild(del)

  card.append(head, actions)
  return card
}

function addAccountTile() {
  const tile = document.createElement('button')
  tile.className = 'acct-add'
  tile.type = 'button'
  tile.innerHTML = '<span class="plus">+</span><span>Add account</span><span style="color: var(--muted); font-size: 0.78rem;">M3U URL · Paste · Xtream</span>'
  tile.addEventListener('click', () => openAccountEditor(null))
  return tile
}

function renderAccounts() {
  const grid = $('accounts-grid')
  const empty = $('accounts-empty')
  if (!grid || !empty) return
  const list = loadPlaylists()
  grid.innerHTML = ''
  empty.hidden = list.length > 0
  if (!list.length) return
  for (const pl of list) grid.appendChild(accountCard(pl))
  grid.appendChild(addAccountTile())
}

/* ─────────────────────────  Account editor  ─────────────────────── */

function syncEditorFields() {
  const t = /** @type {HTMLSelectElement} */ ($('pl-source-type')).value
  $('pl-grp-m3u-url').hidden = t !== 'm3u-url'
  $('pl-grp-m3u-inline').hidden = t !== 'm3u-inline'
  $('pl-grp-xtream').hidden = t !== 'xtream'
}

function clearFormError() {
  const err = $('pl-form-error')
  if (!err) return
  err.hidden = true
  err.textContent = ''
}

function showFormError(msg) {
  const err = $('pl-form-error')
  if (!err) return
  err.hidden = false
  err.textContent = msg
}

/** @param {string | null} editId */
function openAccountEditor(editId) {
  state.editingAccountId = editId || null
  const titleEl = $('editor-title')
  if (titleEl) titleEl.textContent = state.editingAccountId ? 'Edit account' : 'Add account'

  clearFormError()
  ;/** @type {HTMLInputElement} */ ($('pl-name')).value = ''
  ;/** @type {HTMLSelectElement} */ ($('pl-source-type')).value = 'm3u-url'
  ;/** @type {HTMLInputElement} */ ($('pl-m3u-url')).value = ''
  ;/** @type {HTMLTextAreaElement} */ ($('pl-m3u-text')).value = ''
  ;/** @type {HTMLInputElement} */ ($('pl-xc-server')).value = ''
  ;/** @type {HTMLInputElement} */ ($('pl-xc-user')).value = ''
  ;/** @type {HTMLInputElement} */ ($('pl-xc-pass')).value = ''
  const fileEl = /** @type {HTMLInputElement | null} */ ($('pl-m3u-file'))
  if (fileEl) fileEl.value = ''

  if (state.editingAccountId) {
    const pl = getPlaylist(state.editingAccountId)
    if (pl) {
      ;/** @type {HTMLInputElement} */ ($('pl-name')).value = pl.name
      ;/** @type {HTMLSelectElement} */ ($('pl-source-type')).value = pl.sourceType
      if (pl.m3uUrl) /** @type {HTMLInputElement} */ ($('pl-m3u-url')).value = pl.m3uUrl
      if (pl.m3uText) /** @type {HTMLTextAreaElement} */ ($('pl-m3u-text')).value = pl.m3uText
      if (pl.xtreamServer) /** @type {HTMLInputElement} */ ($('pl-xc-server')).value = pl.xtreamServer
      if (pl.xtreamUser) /** @type {HTMLInputElement} */ ($('pl-xc-user')).value = pl.xtreamUser
      if (pl.xtreamPass != null) /** @type {HTMLInputElement} */ ($('pl-xc-pass')).value = pl.xtreamPass
    }
  }
  syncEditorFields()
  setRoute('account-editor')
  setTimeout(() => $('pl-name')?.focus(), 30)
}

function leaveAccountEditor() {
  state.editingAccountId = null
  clearFormError()
  setRoute('accounts')
}

function submitAccountForm(e) {
  e.preventDefault()
  clearFormError()
  const name = (/** @type {HTMLInputElement} */ ($('pl-name'))).value.trim()
  const sourceType = /** @type {'m3u-url'|'m3u-inline'|'xtream'} */ (
    (/** @type {HTMLSelectElement} */ ($('pl-source-type'))).value
  )
  if (!name) { showFormError('Enter a name for this account.'); return }
  const idOpt = state.editingAccountId || undefined
  let saved = null
  if (sourceType === 'm3u-url') {
    const m3uUrl = /** @type {HTMLInputElement} */ ($('pl-m3u-url')).value.trim()
    if (!m3uUrl) { showFormError('Enter the M3U URL.'); return }
    const portal = extractXtreamFromPortalUrl(m3uUrl)
    if (portal) {
      saved = upsertPlaylist({
        id: idOpt,
        name,
        sourceType: 'xtream',
        xtreamServer: portal.base,
        xtreamUser: portal.username,
        xtreamPass: portal.password,
      })
    } else {
      saved = upsertPlaylist({ id: idOpt, name, sourceType: 'm3u-url', m3uUrl })
    }
  } else if (sourceType === 'm3u-inline') {
    const m3uText = /** @type {HTMLTextAreaElement} */ ($('pl-m3u-text')).value
    if (!m3uText.trim()) { showFormError('Paste or upload the M3U playlist text.'); return }
    saved = upsertPlaylist({ id: idOpt, name, sourceType: 'm3u-inline', m3uText })
  } else {
    let xtreamServer = /** @type {HTMLInputElement} */ ($('pl-xc-server')).value.trim()
    let xtreamUser = /** @type {HTMLInputElement} */ ($('pl-xc-user')).value.trim()
    let xtreamPass = /** @type {HTMLInputElement} */ ($('pl-xc-pass')).value
    const fromPortal = extractXtreamFromPortalUrl(xtreamServer)
    if (fromPortal) {
      xtreamServer = fromPortal.base
      xtreamUser = fromPortal.username
      xtreamPass = fromPortal.password
    }
    if (!xtreamServer || !xtreamUser || !xtreamPass) {
      showFormError('Provide server URL, username, password — or paste a full Xtream portal link (…/get.php?username=…&password=…) in Server URL.')
      return
    }
    saved = upsertPlaylist({ id: idOpt, name, sourceType: 'xtream', xtreamServer, xtreamUser, xtreamPass })
  }
  if (saved && !getActivePlaylistId()) setActivePlaylistId(saved.id)
  state.editingAccountId = null
  toast(idOpt ? `Updated "${name}".` : `Added "${name}".`, 'ok')

  // Auto-load right after add for instant gratification.
  if (!idOpt && saved) {
    setRoute('home')
    void loadAccount(saved, { silent: false })
  } else {
    setRoute('accounts')
  }
}

/* ─────────────────────────  Settings UI  ────────────────────────── */

function renderSettingsForm() {
  const s = settingsState.current

  const accentHost = $('settings-accent')
  if (accentHost) {
    accentHost.innerHTML = ''
    for (const p of ACCENT_PRESETS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'accent-swatch'
      b.style.background = `linear-gradient(135deg, ${p.accent}, ${p.accentDim})`
      b.title = p.label
      b.dataset.id = p.id
      b.setAttribute('aria-label', `Accent: ${p.label}`)
      b.setAttribute('data-active', p.id === s.accent ? 'true' : 'false')
      b.addEventListener('click', () => {
        settingsState.current = updateSettings({ accent: p.id })
        renderSettingsForm()
        applyAccent()
      })
      accentHost.appendChild(b)
    }
  }

  /** @param {string} id @param {boolean} v */
  const setCheck = (id, v) => {
    const el = /** @type {HTMLInputElement | null} */ ($(id))
    if (el) el.checked = !!v
  }
  /** @param {string} id @param {string|number} v */
  const setVal = (id, v) => {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | null} */ ($(id))
    if (el) el.value = String(v)
  }

  setCheck('settings-compact', s.compactList)
  setCheck('settings-reduce-motion', s.reduceMotion)
  setCheck('settings-hero-rotate', s.heroAutoRotate)
  setCheck('settings-autoplay-next', s.autoPlayNext)
  setVal('settings-default-kind', s.defaultKind)
  setCheck('settings-autoload', s.autoLoadOnStart)
  setCheck('settings-show-recents', s.showRecents)
  setCheck('settings-show-favs', s.showFavorites)
  setCheck('settings-confirm', s.confirmRemove)
  setCheck('settings-low-latency', s.hlsLowLatency)
  setVal('settings-max-buffer', s.hlsMaxBuffer)
  setVal('settings-ua', s.fetchUserAgent)
  setVal('settings-epg', s.epgUrl)
}

/* ─────────────────────────  Bindings  ───────────────────────────── */

function browseScopedLibraryForSearch() {
  return state.favouritesOnly ? favouritesList() : pickFromKind(state.kindFilter)
}

/** @param {Ch[]} list @param {string} query */
function filterBySearchToken(list, query) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return list.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.group && c.group.toLowerCase().includes(q)) ||
      c.url.toLowerCase().includes(q),
  )
}

/** @param {Ch} ch @param {(c: Ch) => void} onPick */
function buildSearchDdItem(ch, onPick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'search-dd-item'
  btn.setAttribute('role', 'option')

  btn.addEventListener('mousedown', (e) => e.preventDefault())

  const meta = document.createElement('div')
  meta.className = 'search-dd-meta'
  const t = document.createElement('div')
  t.className = 'search-dd-title'
  t.textContent = ch.name
  const s = document.createElement('div')
  s.className = 'search-dd-sub'
  const k = ch.kind || 'live'
  s.textContent = ch.group || (k === 'live' ? 'Live' : k === 'vod' ? 'Movie' : 'Series')
  meta.append(t, s)

  if (ch.logo) {
    const img = document.createElement('img')
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.src = ch.logo
    img.className = k === 'live' ? 'search-dd-live' : 'search-dd-thumb'
    btn.append(img, meta)
  } else {
    const ph = document.createElement('div')
    ph.className = k === 'live' ? 'search-dd-live' : 'search-dd-thumb'
    ph.style.background = 'linear-gradient(135deg,var(--surface-3),var(--surface))'
    btn.append(ph, meta)
  }

  btn.addEventListener('click', () => onPick(ch))
  return btn
}

function bindNav() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => {
    const route = /** @type {AppRoute} */ (b.dataset.route)
    if (route === 'browse') {
      const k = b.dataset.kind
      state.favouritesOnly = b.dataset.favs === 'true'
      if (k === 'live' || k === 'vod' || k === 'series' || k === 'all') state.kindFilter = k
      else if (state.favouritesOnly) state.kindFilter = 'all'
      setRoute('browse')
      void ensureLibraryLoaded()
    } else if (route) {
      setRoute(route)
    }
  }))
  bind('nav-account', 'click', () => setRoute('accounts'))
  bind('nav-settings', 'click', () => setRoute('settings'))

  // Brand → home
  const brand = document.querySelector('.brand')
  if (brand instanceof HTMLElement) {
    brand.style.cursor = 'pointer'
    brand.addEventListener('click', () => setRoute('home'))
  }

  // Top-bar global search: instant dropdown; Enter jumps to Browse with filters applied
  const gs = /** @type {HTMLInputElement | null} */ ($('global-search'))
  const gdd = /** @type {HTMLElement | null} */ ($('nav-search-dropdown'))
  if (gs && gdd) {
    let t = null
    const renderDd = () => {
      const hits = filterBySearchToken(state.channels, gs.value).slice(0, 14)
      gdd.innerHTML = ''
      if (!gs.value.trim() || hits.length === 0) {
        gdd.hidden = true
        gs.setAttribute('aria-expanded', 'false')
        return
      }
      gs.setAttribute('aria-expanded', 'true')
      for (const ch of hits)
        gdd.appendChild(
          buildSearchDdItem(ch, (c) => {
            gdd.hidden = true
            gs.setAttribute('aria-expanded', 'false')
            openWatch(c, { queue: sameRowQueue(c) })
          })
        )
      gdd.hidden = false
    }

    gs.addEventListener('input', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => renderDd(), 90)
      void ensureLibraryLoaded()
    })

    gs.addEventListener('focus', () => {
      renderDd()
    })

    gs.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        gdd.hidden = true
        gs.setAttribute('aria-expanded', 'false')
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        gdd.hidden = true
        gs.setAttribute('aria-expanded', 'false')
        const q = gs.value.trim()
        state.searchTerm = q
        state.kindFilter = 'all'
        state.favouritesOnly = false
        const bs = $('browse-search')
        if (bs instanceof HTMLInputElement) bs.value = q
        setRoute('browse')
      }
    })
  }

  const navSearchWrap = () =>
    $('nav-search-wrap') ?? /** @type {HTMLElement | null} */ (document.querySelector('.nav-search-wrap'))
  const browseToolbar = () =>
    $('browse-toolbar') ?? /** @type {HTMLElement | null} */ (document.querySelector('.browse-toolbar'))

  const closeMenusOnOutside = (/** @type {Event} */ e) => {
    const t = /** @type {EventTarget | null} */ (e.target)
    if (!(t instanceof Node)) return
    const nw = navSearchWrap()
    if (nw instanceof HTMLElement && !nw.contains(t)) {
      const dd = $('nav-search-dropdown')
      const gsEl = $('global-search')
      if (dd) dd.hidden = true
      if (gsEl instanceof HTMLInputElement) gsEl.setAttribute('aria-expanded', 'false')
    }
    const tb = browseToolbar()
    if (tb instanceof HTMLElement && !tb.contains(t)) {
      const bsd = $('browse-search-dropdown')
      const bsEl = $('browse-search')
      if (bsd) bsd.hidden = true
      if (bsEl instanceof HTMLInputElement) bsEl.setAttribute('aria-expanded', 'false')
    }
  }
  document.addEventListener('pointerdown', closeMenusOnOutside, { passive: true })
}

function bindBrowse() {
  $$('#browse-chips .chip').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.hasAttribute('data-favs')) {
        state.favouritesOnly = !state.favouritesOnly
        if (state.favouritesOnly) state.kindFilter = 'all'
      } else {
        const k = b.getAttribute('data-kind')
        if (k === 'all' || k === 'live' || k === 'vod' || k === 'series') {
          state.kindFilter = k
          state.favouritesOnly = false
        }
      }
      renderBrowse()
      syncNav()
    })
  })

  const search = /** @type {HTMLInputElement | null} */ ($('browse-search'))
  const bdd = /** @type {HTMLElement | null} */ ($('browse-search-dropdown'))
  if (search && bdd) {
    let t = null
    const renderBd = () => {
      state.searchTerm = search.value || ''
      bdd.innerHTML = ''
      const trimmed = search.value.trim()
      if (!trimmed) {
        bdd.hidden = true
        search.setAttribute('aria-expanded', 'false')
        renderBrowse()
        return
      }
      const pool = browseScopedLibraryForSearch()
      const hits = filterBySearchToken(pool, search.value).slice(0, 14)
      if (!hits.length) {
        bdd.hidden = true
        search.setAttribute('aria-expanded', 'false')
        renderBrowse()
        return
      }
      search.setAttribute('aria-expanded', 'true')
      for (const ch of hits)
        bdd.appendChild(
          buildSearchDdItem(ch, (c) => {
            bdd.hidden = true
            search.setAttribute('aria-expanded', 'false')
            openWatch(c, { queue: sameRowQueue(c) })
          })
        )
      bdd.hidden = false
      renderBrowse()
    }
    search.addEventListener('focus', () => renderBd())
    search.addEventListener('input', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => renderBd(), 110)
    })
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        bdd.hidden = true
        search.setAttribute('aria-expanded', 'false')
      }
    })
  } else if (search) {
    let t = null
    search.addEventListener('input', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        state.searchTerm = search.value || ''
        renderBrowse()
      }, 140)
    })
  }

  bind('browse-empty-add', 'click', () => openAccountEditor(null))
  bind('browse-empty-accounts', 'click', () => setRoute('accounts'))
}

function bindAccounts() {
  bind('btn-add-account', 'click', () => openAccountEditor(null))
  bind('accounts-empty-add', 'click', () => openAccountEditor(null))
}

function bindEditor() {
  bind('btn-editor-back', 'click', leaveAccountEditor)
  bind('pl-cancel', 'click', leaveAccountEditor)
  bind('pl-source-type', 'change', syncEditorFields)
  bind('account-form', 'submit', submitAccountForm)
  bind('pl-m3u-file', 'change', (ev) => {
    const input = /** @type {HTMLInputElement} */ (ev.target)
    const file = input.files?.[0]
    if (!file) return
    const r = new FileReader()
    r.onload = () => {
      ;/** @type {HTMLTextAreaElement} */ ($('pl-m3u-text')).value = String(r.result || '')
      input.value = ''
    }
    r.readAsText(file)
  })
}

function bindSettings() {
  /** @param {string} id @param {(v: string) => Partial<import('./settings-store.js').Settings>} mapper */
  const onChange = (id, mapper) => {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | null} */ ($(id))
    if (!el) return
    el.addEventListener('change', () => {
      const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? String(el.checked) : el.value
      settingsState.current = updateSettings(mapper(v))
      applyAllSettings()
      if (state.route === 'home') renderHome()
      if (state.route === 'browse') renderBrowse()
    })
  }

  onChange('settings-compact', (v) => ({ compactList: v === 'true' }))
  onChange('settings-reduce-motion', (v) => ({ reduceMotion: v === 'true' }))
  onChange('settings-hero-rotate', (v) => ({ heroAutoRotate: v === 'true' }))
  onChange('settings-autoplay-next', (v) => ({ autoPlayNext: v === 'true' }))
  onChange('settings-default-kind', (v) => ({ defaultKind: /** @type {any} */ (v) }))
  onChange('settings-autoload', (v) => ({ autoLoadOnStart: v === 'true' }))
  onChange('settings-show-recents', (v) => ({ showRecents: v === 'true' }))
  onChange('settings-show-favs', (v) => ({ showFavorites: v === 'true' }))
  onChange('settings-confirm', (v) => ({ confirmRemove: v === 'true' }))
  onChange('settings-low-latency', (v) => ({ hlsLowLatency: v === 'true' }))
  onChange('settings-max-buffer', (v) => ({ hlsMaxBuffer: Math.max(10, Math.min(600, Number(v) || 75)) }))
  onChange('settings-ua', (v) => ({ fetchUserAgent: v }))
  onChange('settings-epg', (v) => ({ epgUrl: v }))
  const epgFld = $('settings-epg')
  if (epgFld instanceof HTMLInputElement)
    epgFld.addEventListener('change', () => {
      xmltvIdByChannelUrl.clear()
      scheduleEpgLoad()
    })

  bind('settings-clear-recent', 'click', () => {
    if (settingsState.current.confirmRemove && !confirm('Clear recently played?')) return
    Pins.clearRecent()
    if (state.route === 'home') renderHome()
    toast('Recently played cleared.', 'ok')
  })
  bind('settings-clear-progress', 'click', () => {
    if (settingsState.current.confirmRemove && !confirm('Clear "continue watching" positions?')) return
    Progress.clearProgress()
    if (state.route === 'home') renderHome()
    toast('Continue watching cleared.', 'ok')
  })
  bind('settings-clear-favs', 'click', () => {
    if (settingsState.current.confirmRemove && !confirm('Clear all favourites?')) return
    Pins.clearFavorites()
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
    toast('Favourites cleared.', 'ok')
  })
  bind('settings-reset', 'click', () => {
    if (settingsState.current.confirmRemove && !confirm('Reset settings to defaults?')) return
    settingsState.current = resetSettings()
    applyAllSettings(); renderSettingsForm()
    epgState.xmltv = null
    epgState.xmltvSourceUrl = ''
    epgState.xtream = {}
    xmltvIdByChannelUrl.clear()
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
    toast('Settings reset.', 'ok')
    scheduleEpgLoad()
  })

  bind('settings-export', 'click', () => {
    const data = JSON.stringify({ accounts: loadPlaylists(), exportedAt: new Date().toISOString() }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `iptv-viewer-accounts-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    toast('Accounts exported.', 'ok')
  })
  bind('settings-import', 'click', () => $('settings-import-file')?.click())
  bind('settings-import-file', 'change', (ev) => {
    const input = /** @type {HTMLInputElement} */ (ev.target)
    const file = input.files?.[0]
    if (!file) return
    const r = new FileReader()
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result || ''))
        const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.accounts) ? parsed.accounts : null
        if (!arr) throw new Error('Unexpected file format')
        const existing = loadPlaylists()
        const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]))
        let added = 0
        for (const raw of arr) {
          if (!raw || typeof raw !== 'object' || !raw.name) continue
          const t = raw.sourceType
          if (t !== 'm3u-url' && t !== 'm3u-inline' && t !== 'xtream') continue
          const id = byName.get(String(raw.name).toLowerCase())?.id
          upsertPlaylist({
            id,
            name: String(raw.name),
            sourceType: t,
            ...(raw.m3uUrl ? { m3uUrl: String(raw.m3uUrl) } : {}),
            ...(raw.m3uText != null ? { m3uText: String(raw.m3uText) } : {}),
            ...(raw.xtreamServer ? { xtreamServer: String(raw.xtreamServer) } : {}),
            ...(raw.xtreamUser ? { xtreamUser: String(raw.xtreamUser) } : {}),
            ...(raw.xtreamPass != null ? { xtreamPass: String(raw.xtreamPass) } : {}),
          })
          added++
        }
        renderAccounts(); syncNav()
        toast(`Imported ${added} account${added === 1 ? '' : 's'}.`, 'ok')
      } catch (e) {
        toast(`Import failed: ${(e instanceof Error ? e.message : String(e))}`, 'error')
      } finally {
        input.value = ''
      }
    }
    r.readAsText(file)
  })
}

function bindShellScroll() {
  const shell = $('app-shell')
  const nav = $('topnav')
  if (!shell || !nav) return
  const onScroll = () => nav.classList.toggle('scrolled', shell.scrollTop > 8)
  shell.addEventListener('scroll', onScroll, { passive: true })
}

/* ─────────────────────────  Boot  ────────────────────────────────── */

function showFatal(msg) {
  const host = $('toast-host') || document.body
  if (!host) return
  const el = document.createElement('div')
  el.className = 'toast error'
  el.style.maxWidth = '460px'
  el.style.whiteSpace = 'pre-wrap'
  el.textContent = `IPTV viewer: ${msg}`
  host.appendChild(el)
}

window.addEventListener('error', (e) => {
  console.error('IPTV viewer: uncaught error', e.error || e.message)
  showFatal((e.error && e.error.stack) || e.message || 'Unknown error')
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('IPTV viewer: unhandled rejection', e.reason)
  showFatal(String((e.reason && e.reason.message) || e.reason || 'Unknown rejection'))
})

function init() {
  console.info('IPTV viewer: init')
  applyAllSettings()
  bindNav()
  bindBrowse()
  bindAccounts()
  bindEditor()
  bindSettings()
  bindPlayerControls()
  bindShellScroll()
  bindDetailModal()
  startEpgClock()

  state.kindFilter = (settingsState.current.defaultKind === 'all' ? 'live' : settingsState.current.defaultKind) || 'live'
  setRoute('home')
  syncNav()

  if (settingsState.current.autoLoadOnStart) {
    const id = getActivePlaylistId()
    const pl = id ? getPlaylist(id) : null
    if (pl) void loadAccount(pl, { silent: true })
  }
  console.info('IPTV viewer: ready')
}

try {
  init()
} catch (err) {
  console.error('IPTV viewer: init failed', err)
  showFatal(`Init failed — ${(err instanceof Error ? err.stack || err.message : String(err))}`)
}

window.addEventListener('storage', (e) => {
  if (!e.key) return
  if (e.key.startsWith('iptv-viewer-')) {
    if (e.key.includes('settings')) {
      settingsState.current = loadSettings()
      applyAllSettings()
      xmltvIdByChannelUrl.clear()
      scheduleEpgLoad()
    }
    if (state.route === 'home') renderHome()
    if (state.route === 'browse') renderBrowse()
    if (state.route === 'accounts') renderAccounts()
    if (state.route === 'settings') renderSettingsForm()
    syncNav()
  }
})

// Tiny dev-time helpers
// @ts-ignore
window.__iptv = { state, setRoute, loadAccount, loadPlaylists, openWatch, newId }
