import { parseM3u } from './m3u.js'
import * as Pins from './pins.js'
import { assignContentKind, filterByContentKind } from './m3u-kind.js'
import {
  loadPlaylists,
  upsertPlaylist,
  deletePlaylist,
  getPlaylist,
  getActivePlaylistId,
  setActivePlaylistId,
} from './playlists-store.js'

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {string} id
 * @param {string} evt
 * @param {EventListenerOrEventListenerObject} fn
 */
function bind(id, evt, fn) {
  const el = document.getElementById(id)
  if (!el) {
    console.error(`IPTV viewer: missing DOM node #${id}`)
    return
  }
  el.addEventListener(evt, fn)
}

const UNCATEGORIZED = 'Uncategorized'

/** @typedef {{ name: string; url: string; logo?: string; group?: string; kind?: 'live' | 'vod' | 'series' }} Ch */

/** Use HLS when URL looks like an adaptive manifest — avoids forcing hls.js on plain MP4/TS URLs. */
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

/**
 * @type {{
 *   channels: Ch[]
 *   filtered: Ch[]
 *   expandedGroups: Set<string>
 *   playingEncUrl: string | null
 *   hls: unknown
 *   contentFilter: 'all' | 'live' | 'vod' | 'series'
 *   browseCaption: string
 * }}
 */
const state = {
  channels: [],
  filtered: [],
  expandedGroups: new Set(),
  playingEncUrl: null,
  hls: null,
  contentFilter: 'all',
  browseCaption: '',
}

/** @type {'home' | 'playlists' | 'editor' | 'browse'} */
let appRoute = 'home'

function groupKey(ch) {
  const raw = ch.group?.trim()
  return raw || UNCATEGORIZED
}

/** @param {Ch[]} list */
function bucketIntoGroups(list) {
  /** @type {Map<string, Ch[]>} */
  const map = new Map()
  for (const ch of list) {
    const k = groupKey(ch)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(ch)
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }
  /** @type {string[]} */
  const keys = Array.from(map.keys())
  keys.sort((a, b) => {
    if (a === UNCATEGORIZED) return 1
    if (b === UNCATEGORIZED) return -1
    return a.localeCompare(b, undefined, { sensitivity: 'base' })
  })
  return keys.map((name) => ({ name, channels: /** @type {Ch[]} */ (map.get(name)) }))
}

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

/**
 * Pause and release the player when leaving Watch (header nav, Home, Playlists, etc.).
 */
function stopBrowsePlayback() {
  const video = /** @type {HTMLVideoElement} */ ($('player'))
  if (state.hls) {
    try {
      state.hls.destroy()
    } catch {
      /* noop */
    }
    state.hls = null
  }
  video.pause()
  video.removeAttribute('src')
  try {
    video.load()
  } catch {
    /* noop */
  }
  state.playingEncUrl = null
  const np = $('now-playing')
  if (np) np.textContent = '—'
  syncPlayingMarkers()
}

/**
 * @param {string} url
 * @param {HTMLVideoElement} video
 */
async function attachStream(url, video) {
  if (state.hls) {
    state.hls.destroy()
    state.hls = null
  }
  video.pause()
  video.removeAttribute('src')
  video.load()
  video.playsInline = true

  const useNativeHls =
    Boolean(video.canPlayType('application/vnd.apple.mpegurl')) && likelyHlsUrl(url)

  if (useNativeHls) {
    video.src = url
    return
  }

  await ensureHls()
  const HlsCtor = window.Hls
  if (HlsCtor?.isSupported() && likelyHlsUrl(url)) {
    const hlsConfig = {
      capLevelToPlayerSize: false,
      maxBufferLength: 75,
      maxMaxBufferLength: 180,
      backBufferLength: 120,
      abrEwmaDefaultEstimate: 12_500_000,
      abrBandWidthFactor: 0.92,
      abrBandWidthUpFactor: 0.74,
      maxStarvationDelay: 12,
      maxLoadingDelay: 8,
      nudgeOffset: 0.05,
      manifestLoadingTimeOut: 120_000,
      levelLoadingTimeOut: 120_000,
      fragLoadingTimeOut: 120_000,
      fragLoadingRetryDelay: 1000,
      manifestLoadingRetryDelay: 1000,
      levelLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 12,
      levelLoadingMaxRetry: 12,
      fragLoadingMaxRetry: 32,
      lowLatencyMode: false,
      enableWorker: true,
      startLevel: -1,
      xhrSetup(xhr, _requestUrl) {
        xhr.withCredentials = false
      },
    }
    const hls = new HlsCtor(hlsConfig)
    state.hls = hls

    hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
      const lv = hls.levels
      if (lv && lv.length > 1) {
        try {
          hls.currentLevel = lv.length - 1
        } catch {
          /* ABR selects rung */
        }
      }
    })

    hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
      if (!data?.fatal) return
      switch (data.type) {
        case HlsCtor.ErrorTypes.NETWORK_ERROR:
          try {
            hls.startLoad()
          } catch {
            /* noop */
          }
          break
        case HlsCtor.ErrorTypes.MEDIA_ERROR:
          try {
            hls.recoverMediaError()
          } catch {
            try {
              hls.swapAudioCodec()
              hls.recoverMediaError()
            } catch {
              /* noop */
            }
          }
          break
        default:
          break
      }
    })

    hls.loadSource(url)
    hls.attachMedia(video)
    return
  }

  video.src = url
}

function setStatus(msg, isError = false) {
  const el = $('status')
  el.textContent = msg
  el.style.color = isError ? '#f87171' : '#94a3b8'
}

function computeFiltered() {
  const byKind = filterByContentKind(state.channels, state.contentFilter)
  const q = ($('search').value || '').trim().toLowerCase()
  return byKind.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.group && c.group.toLowerCase().includes(q)) ||
      groupKey(c).toLowerCase().includes(q) ||
      c.url.toLowerCase().includes(q)
  )
}

function populateGroupJump(groups) {
  const sel = /** @type {HTMLSelectElement} */ ($('group-jump'))
  sel.innerHTML = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'Jump to category…'
  sel.appendChild(all)
  for (let i = 0; i < groups.length; i++) {
    const { name, channels } = groups[i]
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = `${name} (${channels.length})`
    sel.appendChild(opt)
  }
}

function formatGroupLabel(display) {
  return display.includes(';')
    ? display.split(/\s*;\s*/).join(' · ')
    : display
}

function truncateUrl(url, max = 72) {
  if (url.length <= max) return url
  return `${url.slice(0, max - 1)}…`
}

function syncPlayingMarkers() {
  const cur = state.playingEncUrl
  document.querySelectorAll('#channel-groups .channel-tile, #pinned-panel .channel-tile').forEach((el) => {
    el.classList.toggle('is-playing', cur !== null && el.getAttribute('data-enc-url') === cur)
  })
}

function refreshFavStars() {
  const starred = new Set(Pins.loadFavorites().map((r) => encodeURIComponent(r.url)))
  document.querySelectorAll('.fav-star').forEach((el) => {
    if (!(el instanceof HTMLButtonElement)) return
    const enc = el.dataset.encUrl
    if (!enc) return
    const on = starred.has(enc)
    el.textContent = on ? '★' : '☆'
    el.setAttribute('aria-pressed', on ? 'true' : 'false')
    el.setAttribute('aria-label', on ? 'Remove favourite' : 'Add to favourites')
    el.title = on ? 'Remove favourite' : 'Save favourite'
  })
}

/** @param {Ch} ch */
function favStar(ch) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'fav-star'
  btn.dataset.encUrl = encodeURIComponent(ch.url)
  const on = Pins.isFavorited(ch.url)
  btn.textContent = on ? '★' : '☆'
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  btn.setAttribute('aria-label', on ? 'Remove favourite' : 'Add to favourites')
  btn.title = on ? 'Remove favourite' : 'Save favourite'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    Pins.toggleFavorite(ch)
    refreshFavStars()
    renderPinnedBar()
  })
  return btn
}

/** @returns {HTMLElement} */
function channelPlayButton(ch) {
  const encUrl = encodeURIComponent(ch.url)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'channel-tile'
  btn.setAttribute('data-enc-url', encUrl)

  const wrap = document.createElement('span')
  wrap.className = 'ch-logo-wrap'
  wrap.setAttribute('aria-hidden', 'true')
  if (ch.logo) {
    const img = document.createElement('img')
    img.src = ch.logo
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.addEventListener('error', () => {
      img.remove()
      wrap.textContent = '📺'
    })
    wrap.appendChild(img)
  } else {
    wrap.textContent = '📺'
  }

  const text = document.createElement('span')
  text.className = 'ch-text'
  const nm = document.createElement('span')
  nm.className = 'ch-name'
  nm.textContent = ch.name
  const sub = document.createElement('span')
  sub.className = 'ch-sub'
  sub.textContent = truncateUrl(ch.url, 62)
  text.append(nm, sub)

  btn.append(wrap, text)
  btn.addEventListener('click', () => playChannel(ch))
  return btn
}

/** @returns {HTMLElement} */
function channelRow(ch) {
  const row = document.createElement('div')
  row.className = 'channel-row'
  row.append(favStar(ch), channelPlayButton(ch))
  return row
}

/** @returns {HTMLElement} */
function pinnedCard(ch) {
  const wrap = document.createElement('div')
  wrap.className = 'pin-card'
  wrap.append(channelRow(ch))
  return wrap
}

function renderPinnedBar() {
  const panel = /** @type {HTMLElement} */ ($('pinned-panel'))
  const rb = /** @type {HTMLElement} */ ($('recent-block'))
  const fb = /** @type {HTMLElement} */ ($('favorites-block'))
  const rs = $('recent-scroll')
  const fs = $('favorites-scroll')
  rs.innerHTML = ''
  fs.innerHTML = ''
  const recent = Pins.loadRecent()
  const favorites = Pins.loadFavorites()
  for (const ch of recent) rs.appendChild(pinnedCard(ch))
  for (const ch of favorites) fs.appendChild(pinnedCard(ch))
  rb.hidden = recent.length === 0
  fb.hidden = favorites.length === 0
  panel.hidden = recent.length === 0 && favorites.length === 0
  refreshFavStars()
}

function searching() {
  return ($('search').value || '').trim().length > 0
}

function kindCounts() {
  let live = 0
  let vod = 0
  let series = 0
  for (const c of state.channels) {
    const k = c.kind || 'live'
    if (k === 'live') live++
    else if (k === 'vod') vod++
    else series++
  }
  return { all: state.channels.length, live, vod, series }
}

function updateKindPillCounts() {
  const { all, live, vod, series } = kindCounts()
  document.querySelectorAll('.kind-pill [data-kc]').forEach((el) => {
    const k = el.getAttribute('data-kc')
    if (k === 'all') el.textContent = String(all)
    else if (k === 'live') el.textContent = String(live)
    else if (k === 'vod') el.textContent = String(vod)
    else if (k === 'series') el.textContent = String(series)
  })
}

function syncKindPills() {
  document.querySelectorAll('.kind-pill').forEach((btn) => {
    const kind = btn.getAttribute('data-kind')
    btn.setAttribute('data-active', kind === state.contentFilter ? 'true' : 'false')
  })
}

function setBrowseCaption(text) {
  state.browseCaption = text || ''
  const el = $('browse-source-label')
  if (!state.browseCaption) {
    el.hidden = true
    el.textContent = ''
    return
  }
  el.hidden = false
  el.textContent = state.browseCaption
}

/** @param {'home' | 'playlists' | 'editor' | 'browse'} route */
function syncAppChrome(route) {
  const rail = $('nav-rail')
  if (rail) rail.hidden = route === 'browse'

  const topTitle = $('app-top-title')
  const topSub = $('app-top-sub')
  const railKey = route === 'editor' ? 'playlists' : route

  const titles = {
    home: 'Dashboard',
    playlists: 'Playlist & login',
    browse: 'Library',
    editor: 'Playlist & login',
  }
  const subs = {
    home:
      'Pick Live TV, Movies, or Series below — or open Library to load via M3U playlist or Xtream Codes API (same two methods as IPTV Smarters and similar apps).',
    playlists:
      'Save M3U playlist or Xtream Codes API details for next time. Use Library to load and browse; “Use for home” lets the dashboard tiles open that list quickly.',
    browse:
      'At the top of the sidebar choose M3U playlist or Xtream Codes API, load your list, then filter with All / Live / Movies / Series. Favourites stay on this device.',
    editor:
      'Enter a display name and choose M3U (URL or paste) or Xtream Codes API — the same fields standalone IPTV players ask for.',
  }

  if (topTitle) {
    if (route === 'editor') {
      const et = $('editor-title')
      topTitle.textContent = (et && et.textContent) || titles.editor
    } else {
      topTitle.textContent = titles[route] || 'IPTV Viewer'
    }
  }
  if (topSub) {
    topSub.textContent = subs[route] ?? ''
  }

  for (const rid of ['rail-home', 'rail-library', 'rail-playlists']) {
    const btn = $(rid)
    if (!btn) continue
    const key = rid === 'rail-home' ? 'home' : rid === 'rail-library' ? 'browse' : 'playlists'
    btn.setAttribute('data-current', key === railKey ? 'true' : 'false')
  }
}

/** @param {'m3u' | 'xc'} mode */
function setWatchLoaderMode(mode) {
  const isM3u = mode === 'm3u'
  const pm = $('watch-panel-m3u')
  const px = $('watch-panel-xc')
  const sm = $('seg-watch-m3u')
  const sx = $('seg-watch-xc')
  if (pm) pm.hidden = !isM3u
  if (px) px.hidden = isM3u
  if (sm) {
    sm.setAttribute('data-active', isM3u ? 'true' : 'false')
    sm.setAttribute('aria-selected', isM3u ? 'true' : 'false')
  }
  if (sx) {
    sx.setAttribute('data-active', isM3u ? 'false' : 'true')
    sx.setAttribute('aria-selected', isM3u ? 'false' : 'true')
  }
}

/** After swapping views: avoid leaving the viewport scrolled past shorter content (e.g. Playlist → Editor). */
function revealActiveRoute(route) {
  const sectionId =
    route === 'home'
      ? 'view-home'
      : route === 'playlists'
        ? 'view-playlists'
        : route === 'editor'
          ? 'view-playlist-editor'
          : 'view-browse'

  window.scrollTo(0, 0)
  const shell = /** @type {HTMLElement | null} */ (document.querySelector('main.app-shell'))
  if (shell) shell.scrollTop = 0
  const col = /** @type {HTMLElement | null} */ (document.querySelector('.app-content-column'))
  if (col) col.scrollTop = 0

  requestAnimationFrame(() => {
    const el = $(sectionId)
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
  })
}

/** @param {'home' | 'playlists' | 'editor' | 'browse'} route */
function setAppRoute(route) {
  if (appRoute === 'browse' && route !== 'browse') {
    stopBrowsePlayback()
  }

  appRoute = route

  $('view-home').hidden = route !== 'home'
  $('view-playlists').hidden = route !== 'playlists'
  $('view-playlist-editor').hidden = route !== 'editor'
  $('view-browse').hidden = route !== 'browse'

  if (route === 'playlists') renderPlaylistsList()
  if (route === 'home') updateHomeDashboard()
  syncAppChrome(route)
  revealActiveRoute(route)
}

function returnToBrowse() {
  setAppRoute('browse')
  renderBrowser()
}

function updateHomeDashboard() {
  const el = $('home-tile-hint')
  if (!el) return
  const id = getActivePlaylistId()
  const pl = id ? getPlaylist(id) : null
  if (!pl) {
    el.textContent =
      'Under Playlist & login, add M3U or Xtream Codes API and tap Use for home — or load once from Library and use the tiles to filter Live / Movies / Series.'
    return
  }
  el.textContent = `Tiles use “${pl.name}”. Change the default under Playlist & login, or filter a list you already opened in Library.`
}

function showBrowse() {
  returnToBrowse()
}

function showHomeFromBrowse() {
  setAppRoute('home')
}

function hubOpenFiltered(filter) {
  if (state.channels.length > 0) {
    state.contentFilter = filter
    showBrowse()
    return
  }

  let id = getActivePlaylistId()
  let pl = id ? getPlaylist(id) : null
  if (!pl) {
    const list = loadPlaylists()
    if (list.length > 0) {
      pl = list[0]
      setActivePlaylistId(pl.id)
    }
  }
  if (!pl) {
    setAppRoute('playlists')
    return
  }
  void openSavedPlaylist(pl.id, filter)
}

function renderBrowser() {
  state.filtered = computeFiltered()
  updateKindPillCounts()
  syncKindPills()
  const wrap = $('channel-groups')
  wrap.innerHTML = ''
  const groups = bucketIntoGroups(state.filtered)

  populateGroupJump(groups)

  const q = searching()
  const groupCount = groups.length
  const total = state.filtered.length
  const filterNote =
    state.contentFilter !== 'all'
      ? ` — showing ${state.contentFilter === 'vod' ? 'movies' : state.contentFilter}`
      : ''
  if (!state.channels.length) {
    $('count').textContent =
      'Nothing loaded yet — pick M3U playlist or Xtream Codes API above, then Load.'
  } else if (!total) {
    $('count').textContent =
      'No matches for this filter or search — try All / Live / Movies / Series or clear search.'
  } else {
    $('count').textContent = `${total} channels in ${groupCount} ${groupCount === 1 ? 'category' : 'categories'} (${state.channels.length} total loaded${filterNote})`
  }

  for (let i = 0; i < groups.length; i++) {
    const { name, channels } = groups[i]
    const details = document.createElement('details')
    details.className = 'grp'
    details.id = `grp-${i}`
    details.dataset.groupName = name

    const open = q || state.expandedGroups.has(name)
    details.open = open

    details.addEventListener('toggle', () => {
      if (searching()) return
      if (details.open) state.expandedGroups.add(name)
      else state.expandedGroups.delete(name)
    })

    const summary = document.createElement('summary')
    summary.className = 'grp-summary'
    const title = document.createElement('span')
    title.className = 'grp-title'
    title.textContent = formatGroupLabel(name)
    const badge = document.createElement('span')
    badge.className = 'grp-count'
    badge.textContent = String(channels.length)
    summary.append(title, badge)

    const inner = document.createElement('div')
    inner.className = 'grp-channels'
    for (const ch of channels) inner.appendChild(channelRow(ch))

    details.append(summary, inner)
    wrap.appendChild(details)
  }

  syncPlayingMarkers()
}

function playChannel(ch) {
  const video = /** @type {HTMLVideoElement} */ ($('player'))
  $('now-playing').textContent = ch.name
  state.playingEncUrl = encodeURIComponent(ch.url)
  syncPlayingMarkers()
  setStatus('Loading stream…')
  attachStream(ch.url, video).then(
    () => {
      video.play().then(
        () => {
          Pins.pushRecentPlayed(ch)
          renderPinnedBar()
          setStatus('Playing (browser playback may not work for all provider formats).')
        },
        () => setStatus('Playback blocked or stream failed — try another format.', true)
      )
    },
    (e) => setStatus(e.message || String(e), true)
  )
}

function resetExpandedDefaults(groups) {
  state.expandedGroups.clear()
  const first = groups[0]?.name
  if (first) state.expandedGroups.add(first)
}

/**
 * @param {Ch[]} entries
 * @param {{ title?: string }} [opts]
 */
function applyChannels(entries, opts = {}) {
  for (const ch of entries) assignContentKind(ch)
  state.channels = entries
  if (opts.title !== undefined) setBrowseCaption(opts.title)
  resetExpandedDefaults(bucketIntoGroups(computeFiltered()))
  state.playingEncUrl = null
  if (!$('view-browse').hidden) renderBrowser()
  else updateKindPillCounts()
  setStatus(
    entries.length ? `Loaded ${entries.length} channels — grouped by category.` : 'No playable http(s) entries found.',
    !entries.length
  )
}

async function fetchPlaylistUrl(url) {
  const res = await fetch('/api/playlist/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.trim() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText || 'Fetch failed')
  return data.body
}

async function loadFromUrl() {
  const url = $('m3u-url').value.trim()
  if (!url) {
    setStatus('Enter a playlist URL.', true)
    return
  }
  showBrowse()
  setStatus('Downloading playlist…')
  try {
    const body = await fetchPlaylistUrl(url)
    applyChannels(parseM3u(body), { title: 'M3U URL' })
  } catch (e) {
    setStatus(/** @type {Error} */ (e).message, true)
  }
}

function loadFromText() {
  const text = $('m3u-text').value
  showBrowse()
  try {
    applyChannels(parseM3u(text), { title: 'Pasted M3U' })
  } catch (e) {
    setStatus(/** @type {Error} */ (e).message, true)
  }
}

function loadFromFile(ev) {
  const input = /** @type {HTMLInputElement} */ (ev.target)
  const file = input.files?.[0]
  if (!file) return
  showBrowse()
  const r = new FileReader()
  r.onload = () => {
    applyChannels(parseM3u(String(r.result || '')), { title: 'Uploaded file' })
    input.value = ''
  }
  r.readAsText(file)
}

async function loadXtream() {
  const server = $('xc-server').value.trim()
  const username = $('xc-user').value.trim()
  const password = $('xc-pass').value.trim()
  if (!server || !username || !password) {
    setStatus('Fill server URL, username, and password.', true)
    return
  }
  showBrowse()
  setStatus('Loading Xtream catalogue (live + VOD)…')
  try {
    const res = await fetch('/api/xtream/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, username, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText)
    /** @type {Ch[]} */
    const channels = data.channels || []
    applyChannels(channels, { title: 'Xtream' })
  } catch (e) {
    setStatus(/** @type {Error} */ (e).message, true)
  }
}

function sourceTypeBadge(t) {
  if (t === 'm3u-url') return 'M3U URL'
  if (t === 'm3u-inline') return 'Paste'
  return 'Xtream'
}

function formatPlaylistUpdated(ts) {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'Updated just now'
  if (diff < 3600_000) return `Updated ${Math.floor(diff / 60_000)} min ago`
  if (diff < 86400_000) return `Updated ${Math.floor(diff / 3600_000)} h ago`
  return `Updated ${new Date(ts).toLocaleDateString()}`
}

/** @param {{ id: string; name: string; sourceType: string; updatedAt: number; m3uUrl?: string; m3uText?: string; xtreamServer?: string; xtreamUser?: string; xtreamPass?: string }} pl */
function bindPlaylistCard(pl, root) {
  root.querySelector('[data-open="all"]')?.addEventListener('click', () => void openSavedPlaylist(pl.id, 'all'))
  root.querySelector('[data-default]')?.addEventListener('click', () => {
    setActivePlaylistId(pl.id)
    renderPlaylistsList()
    updateHomeDashboard()
  })
  root.querySelector('[data-edit]')?.addEventListener('click', () => openPlaylistEditor(pl.id))
  root.querySelector('[data-del]')?.addEventListener('click', () => {
    if (confirm(`Remove "${pl.name}" from this device?`)) {
      if (getActivePlaylistId() === pl.id) setActivePlaylistId('')
      deletePlaylist(pl.id)
      renderPlaylistsList()
      updateHomeDashboard()
    }
  })
}

/** @param {{ id: string; name: string; sourceType: string; updatedAt: number; m3uUrl?: string; m3uText?: string; xtreamServer?: string; xtreamUser?: string; xtreamPass?: string }} pl */
function playlistListCard(pl) {
  const card = document.createElement('article')
  card.className = 'home-card'
  const active = getActivePlaylistId() === pl.id
  card.innerHTML = `
    <div class="home-card-head">
      <h3 class="home-card-title"></h3>
      <span class="src-badge"></span>
    </div>
    <p class="home-card-meta"></p>
    <div class="home-card-actions">
      <button type="button" class="primary" data-open="all">Browse all</button>
      ${active ? '' : `<button type="button" class="ghost" data-default>Use for home</button>`}
      ${active ? `<span class="card-active-pill">Default for home</span>` : ''}
    </div>
    <div class="home-card-edit">
      <button type="button" class="ghost" data-edit>Edit</button>
      <button type="button" class="ghost" data-del>Remove</button>
    </div>
  `
  const titleEl = card.querySelector('.home-card-title')
  const badgeEl = card.querySelector('.src-badge')
  const metaEl = card.querySelector('.home-card-meta')
  if (titleEl) titleEl.textContent = pl.name
  if (badgeEl) badgeEl.textContent = sourceTypeBadge(pl.sourceType)
  if (metaEl) metaEl.textContent = formatPlaylistUpdated(pl.updatedAt)
  bindPlaylistCard(pl, card)
  return card
}

function renderPlaylistsList() {
  const wrap = $('playlists-grid')
  const empty = $('playlists-empty')
  const list = loadPlaylists()
  wrap.innerHTML = ''
  empty.hidden = list.length > 0
  for (const pl of list) {
    wrap.appendChild(playlistListCard(pl))
  }
}

/** @param {'all' | 'live' | 'vod' | 'series'} filter */
async function openSavedPlaylist(id, filter) {
  const pl = getPlaylist(id)
  if (!pl) {
    renderPlaylistsList()
    return
  }
  setActivePlaylistId(id)
  state.contentFilter = filter
  showBrowse()
  setBrowseCaption(pl.name)
  setStatus('Loading playlist…')
  try {
    if (pl.sourceType === 'm3u-url') {
      const u = pl.m3uUrl?.trim()
      if (!u) throw new Error('Missing M3U URL')
      const body = await fetchPlaylistUrl(u)
      applyChannels(parseM3u(body), { title: pl.name })
    } else if (pl.sourceType === 'm3u-inline') {
      applyChannels(parseM3u(pl.m3uText || ''), { title: pl.name })
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
      applyChannels(data.channels || [], { title: pl.name })
    }
  } catch (e) {
    setStatus(/** @type {Error} */ (e).message, true)
  }
}

let editingPlaylistId = /** @type {string | null} */ (null)

function syncPlEditorFields() {
  const t = /** @type {HTMLSelectElement} */ ($('pl-source-type')).value
  $('pl-grp-m3u-url').hidden = t !== 'm3u-url'
  $('pl-grp-m3u-inline').hidden = t !== 'm3u-inline'
  $('pl-grp-xtream').hidden = t !== 'xtream'
}

function clearPlFormError() {
  const err = $('pl-form-error')
  err.hidden = true
  err.textContent = ''
}

function showPlFormError(msg) {
  const err = $('pl-form-error')
  err.hidden = false
  err.textContent = msg
}

/** @param {string | null} editId */
function openPlaylistEditor(editId) {
  editingPlaylistId = editId || null
  $('editor-title').textContent = editingPlaylistId ? 'Edit playlist' : 'Add playlist'
  clearPlFormError()
  $('pl-name').value = ''
  $('pl-source-type').value = 'm3u-url'
  $('pl-m3u-url').value = ''
  $('pl-m3u-text').value = ''
  $('pl-xc-server').value = ''
  $('pl-xc-user').value = ''
  $('pl-xc-pass').value = ''
  if (editingPlaylistId) {
    const pl = getPlaylist(editingPlaylistId)
    if (pl) {
      $('pl-name').value = pl.name
      $('pl-source-type').value = pl.sourceType
      if (pl.m3uUrl) $('pl-m3u-url').value = pl.m3uUrl
      if (pl.m3uText) $('pl-m3u-text').value = pl.m3uText
      if (pl.xtreamServer) $('pl-xc-server').value = pl.xtreamServer
      if (pl.xtreamUser) $('pl-xc-user').value = pl.xtreamUser
      if (pl.xtreamPass != null) $('pl-xc-pass').value = pl.xtreamPass
    }
  }
  syncPlEditorFields()
  setAppRoute('editor')
  queueMicrotask(() => $('pl-name')?.focus())
}

function leavePlaylistEditor() {
  editingPlaylistId = null
  clearPlFormError()
  setAppRoute('playlists')
}

renderPinnedBar()
setAppRoute('home')
setWatchLoaderMode('m3u')

bind('clear-recent', 'click', () => {
  Pins.clearRecent()
  renderPinnedBar()
})

bind('btn-url', 'click', loadFromUrl)
bind('btn-text', 'click', loadFromText)
bind('btn-xc', 'click', loadXtream)
bind('m3u-file', 'change', loadFromFile)
bind('btn-m3u-file', 'click', () => {
  document.getElementById('m3u-file')?.click()
})
bind('search', 'input', renderBrowser)

bind('group-jump', 'change', () => {
  const v = /** @type {HTMLSelectElement} */ ($('group-jump')).value
  if (!v) return
  const el = $(`grp-${v}`)
  if (!(el instanceof HTMLDetailsElement)) return
  const name = el.dataset.groupName || ''
  if (name && !searching()) {
    state.expandedGroups.add(name)
  }
  el.open = true
  el.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'nearest',
  })
})

bind('btn-expand-all', 'click', () => {
  const groups = bucketIntoGroups(computeFiltered())
  for (const g of groups) {
    state.expandedGroups.add(g.name)
  }
  renderBrowser()
})

bind('btn-collapse-all', 'click', () => {
  if (searching()) {
    return
  }
  resetExpandedDefaults(bucketIntoGroups(computeFiltered()))
  renderBrowser()
})

bind('m3u-url', 'keydown', (e) => {
  if (e.key === 'Enter') loadFromUrl()
})

bind('rail-home', 'click', () => setAppRoute('home'))
bind('rail-library', 'click', () => returnToBrowse())
bind('rail-playlists', 'click', () => setAppRoute('playlists'))

bind('seg-watch-m3u', 'click', () => setWatchLoaderMode('m3u'))
bind('seg-watch-xc', 'click', () => setWatchLoaderMode('xc'))

bind('btn-home-open-watch', 'click', () => returnToBrowse())
bind('btn-home-open-playlists', 'click', () => setAppRoute('playlists'))
bind('btn-playlists-open-watch', 'click', () => returnToBrowse())
bind('btn-playlists-back', 'click', () => setAppRoute('home'))
bind('btn-back-home', 'click', () => showHomeFromBrowse())

bind('btn-add-playlist', 'click', () => openPlaylistEditor(null))
bind('btn-editor-back', 'click', () => leavePlaylistEditor())

bind('pl-source-type', 'change', syncPlEditorFields)

bind('playlist-form', 'submit', (e) => {
  e.preventDefault()
  clearPlFormError()
  const name = /** @type {HTMLInputElement} */ ($('pl-name')).value.trim()
  const sourceType = /** @type {'m3u-url'|'m3u-inline'|'xtream'} */ (
    /** @type {HTMLSelectElement} */ ($('pl-source-type')).value
  )
  if (!name) {
    showPlFormError('Enter a name for this playlist.')
    return
  }
  const idOpt = editingPlaylistId || undefined
  let saved
  if (sourceType === 'm3u-url') {
    const m3uUrl = $('pl-m3u-url').value.trim()
    if (!m3uUrl) {
      showPlFormError('Enter the M3U URL.')
      return
    }
    saved = upsertPlaylist({ id: idOpt, name, sourceType: 'm3u-url', m3uUrl })
  } else if (sourceType === 'm3u-inline') {
    const m3uText = /** @type {HTMLTextAreaElement} */ ($('pl-m3u-text')).value
    if (!m3uText.trim()) {
      showPlFormError('Paste the M3U playlist text.')
      return
    }
    saved = upsertPlaylist({ id: idOpt, name, sourceType: 'm3u-inline', m3uText })
  } else {
    const xtreamServer = $('pl-xc-server').value.trim()
    const xtreamUser = $('pl-xc-user').value.trim()
    const xtreamPass = /** @type {HTMLInputElement} */ ($('pl-xc-pass')).value
    if (!xtreamServer || !xtreamUser || !xtreamPass) {
      showPlFormError('Fill server URL, username, and password.')
      return
    }
    saved = upsertPlaylist({
      id: idOpt,
      name,
      sourceType: 'xtream',
      xtreamServer,
      xtreamUser,
      xtreamPass,
    })
  }
  if (saved && !getActivePlaylistId()) setActivePlaylistId(saved.id)
  editingPlaylistId = null
  setAppRoute('playlists')
  updateHomeDashboard()
})

bind('pl-cancel', 'click', () => leavePlaylistEditor())

bind('hub-live', 'click', () => hubOpenFiltered('live'))
bind('hub-movies', 'click', () => hubOpenFiltered('vod'))
bind('hub-series', 'click', () => hubOpenFiltered('series'))

document.querySelectorAll('.kind-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    const k = btn.getAttribute('data-kind')
    if (k === 'all' || k === 'live' || k === 'vod' || k === 'series') {
      state.contentFilter = k
      renderBrowser()
    }
  })
})