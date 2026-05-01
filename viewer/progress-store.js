/**
 * Tracks per-stream playback positions for "Continue Watching".
 * Live streams (no meaningful duration) are ignored — we only record
 * VOD-style entries that have a real seekable duration.
 */

const KEY = 'iptv-viewer-progress-v1'
const MAX_ENTRIES = 60
/** Entries below this many seconds aren't worth resuming. */
const MIN_RESUMABLE_SECONDS = 8
/** Treat as "finished" once this fraction is watched (don't resume). */
const FINISHED_FRACTION = 0.95

/**
 * @typedef {{
 *   url: string
 *   name: string
 *   logo?: string
 *   group?: string
 *   kind?: 'live' | 'vod' | 'series'
 *   position: number
 *   duration: number
 *   updatedAt: number
 * }} ProgressRow
 */

function safeParse(s) {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** @returns {ProgressRow[]} */
function readAll() {
  const raw = localStorage.getItem(KEY)
  if (!raw) return []
  /** @type {ProgressRow[]} */
  const out = []
  const seen = new Set()
  for (const r of safeParse(raw)) {
    if (!r || typeof r !== 'object') continue
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!url || seen.has(url)) continue
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Channel'
    const position = Number(r.position) || 0
    const duration = Number(r.duration) || 0
    if (position < 0 || duration < 0) continue
    seen.add(url)
    out.push({
      url,
      name,
      ...(r.logo ? { logo: String(r.logo) } : {}),
      ...(r.group ? { group: String(r.group) } : {}),
      ...(r.kind === 'live' || r.kind === 'vod' || r.kind === 'series' ? { kind: r.kind } : {}),
      position,
      duration,
      updatedAt: Number(r.updatedAt) || 0,
    })
  }
  return out
}

/** @param {ProgressRow[]} rows */
function writeAll(rows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX_ENTRIES)))
  } catch {
    /* quota / privacy mode */
  }
}

/**
 * Save (or update) a position for a stream.
 * @param {{ name: string; url: string; logo?: string; group?: string; kind?: 'live' | 'vod' | 'series' }} ch
 * @param {number} position seconds
 * @param {number} duration seconds (0 if unknown / live)
 */
export function recordProgress(ch, position, duration) {
  if (!ch || !ch.url) return
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return
  // Skip live and tiny clips
  if (duration < MIN_RESUMABLE_SECONDS * 2) return
  if (position < MIN_RESUMABLE_SECONDS) return

  const rows = readAll().filter((r) => r.url !== ch.url)
  const next = {
    url: ch.url,
    name: ch.name || 'Channel',
    ...(ch.logo ? { logo: ch.logo } : {}),
    ...(ch.group ? { group: ch.group } : {}),
    ...(ch.kind ? { kind: ch.kind } : {}),
    position,
    duration,
    updatedAt: Date.now(),
  }

  // If basically finished, drop instead of save.
  if (duration > 0 && position / duration >= FINISHED_FRACTION) {
    writeAll(rows)
    return
  }
  rows.unshift(next)
  writeAll(rows)
}

/**
 * Look up a saved position for a URL.
 * @param {string} url
 * @returns {ProgressRow | null}
 */
export function getProgress(url) {
  if (!url) return null
  return readAll().find((r) => r.url === url) || null
}

/**
 * List in-progress entries (most-recent first).
 * @returns {ProgressRow[]}
 */
export function loadInProgress() {
  const rows = readAll()
  return rows
    .filter((r) => r.duration > 0 && r.position >= MIN_RESUMABLE_SECONDS && r.position / r.duration < FINISHED_FRACTION)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Clear a single URL's saved position. */
export function dropProgress(url) {
  if (!url) return
  writeAll(readAll().filter((r) => r.url !== url))
}

/** Wipe all saved positions. */
export function clearProgress() {
  writeAll([])
}
