/** @typedef {{ name: string; url: string; logo?: string; group?: string }} M3uEntry */

/** @type {(line: string) => Record<string, string>} */
function parseExtinfAttrs(seg) {
  const out = {}
  const re = /([a-zA-Z0-9._-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(seg)) !== null) {
    out[m[1]] = m[2]
  }
  return out
}

/**
 * Parse M3U / M3U8 playlist text into channel entries (EXTINF lines + following URL).
 * @param {string} raw
 * @returns {M3uEntry[]}
 */
export function parseM3u(raw) {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  /** @type {M3uEntry[]} */
  const entries = []

  /** @type {Partial<M3uEntry> | null} */
  let pending = null

  for (let line of lines) {
    line = line.trim()
    if (!line || line.startsWith('#EXTM3U') || line.startsWith('#EXTGRP')) continue

    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length)
      const lastComma = rest.lastIndexOf(',')
      const meta = lastComma >= 0 ? rest.slice(0, lastComma) : rest
      const title = lastComma >= 0 ? rest.slice(lastComma + 1).trim() : ''
      const attrs = parseExtinfAttrs(meta)
      pending = {
        name: (attrs['tvg-name'] || title || 'Unknown').trim(),
        logo: attrs['tvg-logo'] || attrs.logo,
        group: attrs['group-title'],
      }
      continue
    }

    if (line.startsWith('#')) continue

    const url = line
    if (!/^https?:\/\//i.test(url)) continue

    if (pending) {
      entries.push({
        name: pending.name || 'Unknown',
        url,
        logo: pending.logo,
        group: pending.group,
      })
      pending = null
    } else {
      entries.push({ name: url, url })
    }
  }

  return entries
}
