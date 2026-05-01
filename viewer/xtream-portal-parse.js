/**
 * Xtream portal links (get.php…?username=…&password=…) share credentials in the URL.
 * Stripping the .php leaf yields the HTTP base used for `/player_api.php`.
 * @param {string} raw
 * @returns {{ base: string, username: string, password: string } | null}
 */
export function extractXtreamFromPortalUrl(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let u
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
  const base = `${u.origin}${basePath}`.replace(/\/+$/, '') || u.origin
  return { base, username: username.trim(), password }
}
