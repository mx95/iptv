const STORAGE_KEY = 'iptv-viewer-user-playlists-v1'
const ACTIVE_PLAYLIST_KEY = 'iptv-viewer-active-playlist-v1'

/** @returns {string | null} */
export function getActivePlaylistId() {
  return localStorage.getItem(ACTIVE_PLAYLIST_KEY)
}

/** @param {string} [id] Pass empty/falsy to clear */
export function setActivePlaylistId(id) {
  if (id) localStorage.setItem(ACTIVE_PLAYLIST_KEY, id)
  else localStorage.removeItem(ACTIVE_PLAYLIST_KEY)
}

/**
 * @typedef {'m3u-url' | 'm3u-inline' | 'xtream'} PlaylistSourceType
 */

/**
 * @typedef {{
 *   id: string
 *   name: string
 *   sourceType: PlaylistSourceType
 *   m3uUrl?: string
 *   m3uText?: string
 *   xtreamServer?: string
 *   xtreamUser?: string
 *   xtreamPass?: string
 *   updatedAt: number
 * }} UserPlaylist
 */

function safeParse(json) {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** @returns {UserPlaylist[]} */
export function loadPlaylists() {
  return safeParse(localStorage.getItem(STORAGE_KEY) || '[]').filter(isValidPlaylist)
}

/** @param {unknown} x */
function isValidPlaylist(x) {
  if (!x || typeof x !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (x)
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.sourceType === 'm3u-url' || o.sourceType === 'm3u-inline' || o.sourceType === 'xtream')
  )
}

/** @param {UserPlaylist[]} rows */
export function savePlaylists(rows) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    /* quota */
  }
}

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `pl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** @param {Omit<UserPlaylist, 'id' | 'updatedAt'> & { id?: string }} partial */
export function upsertPlaylist(partial) {
  const list = loadPlaylists()
  const now = Date.now()
  const id = partial.id || newId()
  const ix = list.findIndex((p) => p.id === id)
  const row = /** @type {UserPlaylist} */ ({
    id,
    name: partial.name.trim() || 'Untitled',
    sourceType: partial.sourceType,
    updatedAt: now,
    ...(partial.m3uUrl ? { m3uUrl: partial.m3uUrl.trim() } : {}),
    ...(partial.m3uText != null ? { m3uText: partial.m3uText } : {}),
    ...(partial.xtreamServer ? { xtreamServer: partial.xtreamServer.trim() } : {}),
    ...(partial.xtreamUser ? { xtreamUser: partial.xtreamUser.trim() } : {}),
    ...(partial.xtreamPass != null ? { xtreamPass: partial.xtreamPass } : {}),
  })
  if (ix >= 0) list[ix] = row
  else list.unshift(row)
  savePlaylists(list)
  return row
}

/** @param {string} id */
export function deletePlaylist(id) {
  savePlaylists(loadPlaylists().filter((p) => p.id !== id))
}

/** @param {string} id */
export function getPlaylist(id) {
  return loadPlaylists().find((p) => p.id === id) ?? null
}
