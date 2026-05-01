/**
 * Local app preferences (theme accent, default kind on Home, HLS tweaks, etc.).
 * Persisted in localStorage so reloads don't reset choices.
 */

const KEY = 'iptv-viewer-settings-v1'

/**
 * @typedef {{
 *   accent: 'violet' | 'blue' | 'green' | 'amber' | 'rose'
 *   compactList: boolean
 *   defaultKind: 'all' | 'live' | 'vod' | 'series'
 *   autoLoadOnStart: boolean
 *   showRecents: boolean
 *   showFavorites: boolean
 *   confirmRemove: boolean
 *   hlsLowLatency: boolean
 *   hlsMaxBuffer: number
 *   fetchUserAgent: string
 *   epgUrl: string
 *   autoPlayNext: boolean
 *   heroAutoRotate: boolean
 *   playerVolume: number
 *   reduceMotion: boolean
 * }} Settings
 */

/** @type {Settings} */
const DEFAULTS = {
  accent: 'violet',
  compactList: false,
  defaultKind: 'live',
  autoLoadOnStart: true,
  showRecents: true,
  showFavorites: true,
  confirmRemove: true,
  hlsLowLatency: false,
  hlsMaxBuffer: 75,
  fetchUserAgent: '',
  epgUrl: '',
  autoPlayNext: true,
  heroAutoRotate: true,
  playerVolume: 1,
  reduceMotion: false,
}

function safeParse(json) {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** @returns {Settings} */
export function loadSettings() {
  const raw = safeParse(localStorage.getItem(KEY) || '{}')
  return /** @type {Settings} */ ({ ...DEFAULTS, ...raw })
}

/** @param {Settings} next */
export function saveSettings(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* quota / privacy mode */
  }
}

/** @param {Partial<Settings>} patch */
export function updateSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  saveSettings(next)
  return next
}

export function resetSettings() {
  saveSettings({ ...DEFAULTS })
  return { ...DEFAULTS }
}

export const ACCENT_PRESETS = /** @type {const} */ ([
  { id: 'violet', label: 'Violet', accent: '#8b5cf6', accentDim: '#6d46c9' },
  { id: 'blue', label: 'Ocean', accent: '#3b82f6', accentDim: '#1d4ed8' },
  { id: 'green', label: 'Mint', accent: '#10b981', accentDim: '#059669' },
  { id: 'amber', label: 'Amber', accent: '#f59e0b', accentDim: '#b45309' },
  { id: 'rose', label: 'Rose', accent: '#ef4444', accentDim: '#b91c1c' },
])

/** @param {Settings['accent']} id */
export function getAccent(id) {
  return ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0]
}
