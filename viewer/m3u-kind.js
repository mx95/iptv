/**
 * Heuristic content type from M3U / playlist metadata (group-title, name, URL).
 * Many providers use group-title like "UK | MOVIES" or "Series | Show name".
 * @typedef {'live' | 'vod' | 'series'} ContentKind
 */

/** @typedef {{ name: string; url: string; logo?: string; group?: string; kind?: ContentKind }} Ch */

/**
 * @param {Ch} ch
 * @returns {ContentKind}
 */
export function detectContentKind(ch) {
  const preset = ch.kind
  if (preset === 'live' || preset === 'vod' || preset === 'series') return preset

  const g = (ch.group || '').toLowerCase()
  const n = (ch.name || '').toLowerCase()
  const u = (ch.url || '').toLowerCase()
  const blob = `${g} ${n} ${u}`

  if (/\bs\d{1,2}\s*[._-]?\s*e\d{1,2}\b/i.test(ch.name || '')) return 'series'
  if (/\b(season\s*\d|episode\s*\d|ep\.?\s*\d|complete series|tv series|box set|boxset)\b/i.test(blob)) return 'series'
  if (/\|\s*series\b|\bseries\s*\||\bseries\s*[-|·]/i.test(blob)) return 'series'
  if (/\/series\//i.test(u) || /[?&]type=series\b/i.test(u)) return 'series'

  if (/\b(24/?7|24-7|live\s*tv|live\s*channel|\.ts\b|timeshift|catch[- ]?up)\b/i.test(blob)) return 'live'
  if (/\/live\//i.test(u)) return 'live'

  if (/\b(vod|movie|movies|film|cinema|uhd|4k|hdr|box office|on demand)\b/i.test(blob)) return 'vod'
  if (/\|\s*(vod|movie|movies|films)\b|\b(vod|movies|films)\s*\|/i.test(blob)) return 'vod'
  if (/\/movie\//i.test(u) || /[?&]type=vod\b/i.test(u)) return 'vod'

  return 'live'
}

/**
 * @param {Ch} ch
 */
export function assignContentKind(ch) {
  ch.kind = detectContentKind(ch)
}

/**
 * @param {Ch[]} list
 * @param {ContentKind | 'all'} filter
 */
export function filterByContentKind(list, filter) {
  if (filter === 'all') return list
  return list.filter((c) => (c.kind || 'live') === filter)
}
