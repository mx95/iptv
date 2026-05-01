/**
 * Saved locally in the browser: favorites & recently played streams.
 */

const STORAGE_FAV = 'iptv-viewer-pin-favorites-v1'
const STORAGE_REC = 'iptv-viewer-pin-recent-v1'
const MAX_FAVORITES = 80
const MAX_RECENT = 25

/** @typedef {{ name: string; url: string; logo?: string; group?: string }} PinCh */

/** @param {unknown} val */
function isPinCh(val) {
  if (!val || typeof val !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (val)
  const u = o.url
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u.trim())) return false
  if (o.name != null && typeof o.name !== 'string') return false
  return true
}

/** @param {PinCh} ch */
function normalizePin(ch) {
  const name = typeof ch.name === 'string' && ch.name.trim() ? ch.name.trim() : 'Channel'
  return {
    name,
    url: ch.url.trim(),
    ...(ch.logo && String(ch.logo).trim() ? { logo: String(ch.logo).trim() } : {}),
    ...(ch.group && String(ch.group).trim() ? { group: String(ch.group).trim() } : {}),
  }
}

/** @returns {PinCh[]} */
function readArr(key, maxLen) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const rows = []
    const seen = new Set()
    for (const row of arr) {
      if (!isPinCh(row)) continue
      const p = normalizePin(/** @type {PinCh} */ (row))
      if (!p.url || seen.has(p.url)) continue
      seen.add(p.url)
      rows.push(p)
      if (rows.length >= maxLen) break
    }
    return rows
  } catch {
    return []
  }
}

/** @param {string} key
 * @param {PinCh[]} rows
 */
function writeArr(key, rows) {
  try {
    localStorage.setItem(key, JSON.stringify(rows))
  } catch {
    /* quota / privacy mode */
  }
}

/** @returns {PinCh[]} */
export function loadFavorites() {
  return readArr(STORAGE_FAV, MAX_FAVORITES)
}

/** @param {PinCh[]} rows */
export function saveFavorites(rows) {
  writeArr(STORAGE_FAV, rows.slice(0, MAX_FAVORITES))
}

/** @returns {PinCh[]} */
export function loadRecent() {
  return readArr(STORAGE_REC, MAX_RECENT)
}

/** @param {PinCh[]} rows */
export function saveRecent(rows) {
  writeArr(STORAGE_REC, rows.slice(0, MAX_RECENT))
}

/** @returns {PinCh[]} */
export function clearRecent() {
  saveRecent([])
  return []
}

/**
 * Toggle favorite by URL (returns next state: true if favorited).
 * @param {PinCh} ch
 */
export function toggleFavorite(ch) {
  const n = normalizePin(ch)
  const rows = loadFavorites()
  const ix = rows.findIndex((r) => r.url === n.url)
  let nextStarred = false
  if (ix >= 0) {
    rows.splice(ix, 1)
  } else {
    rows.unshift(n)
    if (rows.length > MAX_FAVORITES) rows.length = MAX_FAVORITES
    nextStarred = true
  }
  saveFavorites(rows)
  return nextStarred
}

/** @param {PinCh | string} chOrUrl */
export function isFavorited(chOrUrl) {
  const url = typeof chOrUrl === 'string' ? chOrUrl : chOrUrl.url
  return loadFavorites().some((r) => r.url === url)
}

/** Queue most recent playback (successful play only). */
export function pushRecentPlayed(ch) {
  const n = normalizePin(ch)
  const prev = loadRecent().filter((r) => r.url !== n.url)
  prev.unshift(n)
  saveRecent(prev)
}

/** Clear remembered recent playback list. */
export function clearRecent() {
  saveRecent([])
}
