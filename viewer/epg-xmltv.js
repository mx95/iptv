/**
 * Lightweight XMLTV parser (browser DOMParser).
 * @typedef {{ channelId: string; start: number; stop: number; title: string; desc: string }} EpgProgramme
 */

/** @param {string} s */
export function normalizeEpgName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\[.*?\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fhd|uhd|4k|hd|sd|h265|h264)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * XMLTV datetime: YYYYMMDDHHMMSS [{+-}HHMM]
 * @param {string | null} raw
 */
function parseXmltvTime(raw) {
  if (!raw) return NaN
  const m = String(raw).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/)
  if (!m) return NaN
  const [, Y, Mo, D, H, Mi, S, sign, oh, om] = m
  const base = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}`
  if (sign && oh != null && om != null) {
    const d = Date.parse(`${base}${sign}${oh}:${om}`)
    return Number.isFinite(d) ? d : NaN
  }
  const d = Date.parse(`${base}Z`)
  return Number.isFinite(d) ? d : NaN
}

/**
 * @param {string} xmlText
 * @returns {{ channelLabels: Record<string, string>; programmesByChannel: Record<string, EpgProgramme[]>; normalizedNameToIds: Record<string, string[]> }}
 */
export function parseXmltv(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
  const pe = doc.querySelector('parsererror')
  if (pe) throw new Error('Could not parse EPG XML')

  /** @type {Record<string, string>} */
  const channelLabels = {}
  doc.querySelectorAll('channel[id]').forEach((el) => {
    const id = el.getAttribute('id')
    if (!id) return
    const dn = el.querySelector('display-name')
    channelLabels[id] = (dn?.textContent || id).trim() || id
  })

  /** @type {EpgProgramme[]} */
  const all = []
  doc.querySelectorAll('programme[channel]').forEach((el) => {
    const channelId = el.getAttribute('channel')
    const start = parseXmltvTime(el.getAttribute('start'))
    const stop = parseXmltvTime(el.getAttribute('stop'))
    if (!channelId || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return
    const title = el.querySelector('title')?.textContent?.trim() || ''
    const desc = el.querySelector('desc')?.textContent?.trim() || ''
    all.push({ channelId, start, stop, title, desc })
  })

  all.sort((a, b) => a.start - b.start)

  /** @type {Record<string, EpgProgramme[]>} */
  const programmesByChannel = {}
  for (const p of all) {
    if (!programmesByChannel[p.channelId]) programmesByChannel[p.channelId] = []
    programmesByChannel[p.channelId].push(p)
  }

  /** @type {Record<string, string[]>} */
  const normalizedNameToIds = {}
  for (const [cid, label] of Object.entries(channelLabels)) {
    const k = normalizeEpgName(label)
    if (!k) continue
    if (!normalizedNameToIds[k]) normalizedNameToIds[k] = []
    normalizedNameToIds[k].push(cid)
  }

  return { channelLabels, programmesByChannel, normalizedNameToIds }
}

/**
 * @param {{ channelLabels: Record<string, string>; programmesByChannel: Record<string, EpgProgramme[]>; normalizedNameToIds: Record<string, string[]> }} guide
 * @param {{ name?: string; tvgId?: string }} ch
 */
export function resolveXmltvChannelId(guide, ch) {
  const tvgId = ch.tvgId?.trim()
  if (tvgId && guide.programmesByChannel[tvgId]?.length) return tvgId
  if (tvgId && guide.channelLabels[tvgId]) return tvgId

  const n = normalizeEpgName(ch.name || '')
  if (!n) return ''
  const hits = guide.normalizedNameToIds[n]
  if (hits?.length === 1) return hits[0]
  if (hits && hits.length > 1) {
    // Prefer id that has programme data
    const withData = hits.filter((id) => (guide.programmesByChannel[id]?.length || 0) > 0)
    if (withData.length === 1) return withData[0]
  }
  return ''
}

/**
 * @param {Record<string, EpgProgramme[]>} programmesByChannel
 * @param {string} channelId
 * @param {number} [now]
 * @returns {{ now: EpgProgramme | null; next: EpgProgramme | null }}
 */
export function getNowAndNext(programmesByChannel, channelId, now = Date.now()) {
  const list = programmesByChannel[channelId]
  if (!list?.length) return { now: null, next: null }
  /** @type {EpgProgramme | null} */ let cur = null
  /** @type {EpgProgramme | null} */ let nx = null
  for (const p of list) {
    if (p.start <= now && now < p.stop) cur = p
    else if (p.start > now && !nx) nx = p
    if (cur && nx) break
  }
  return { now: cur, next: nx }
}
