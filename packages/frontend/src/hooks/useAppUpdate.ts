import { useEffect, useState } from 'react'

const RELEASE_REPO = 'locctl/ios-locctl'
const CHECK_DELAY_MS = 5000

export interface AppUpdate {
  latest: string
  current: string
  download_url: string
}

/**
 * Naïve semver-greater-than: numeric component comparison, pre-release
 * suffix (after `-`) dropped. Adequate for our v0.x.y release cadence
 * where we never compare two pre-releases against each other.
 */
function semverGt(a: string, b: string): boolean {
  const norm = (s: string) => s.split('-')[0].split('.').map((p) => parseInt(p, 10) || 0)
  const aa = norm(a)
  const bb = norm(b)
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] ?? 0
    const bv = bb[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

/**
 * Polls GitHub Releases once at startup. Failures are silent — a NEW pill
 * appearing late is fine, but a noisy error dialog every time the user is
 * offline isn't. The 5-second delay keeps the request out of the critical
 * path of first paint.
 */
export function useAppUpdate(currentVersion: string): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const ctrl = new AbortController()
        const abortTimer = setTimeout(() => ctrl.abort(), 8000)
        const res = await fetch(
          `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
          { signal: ctrl.signal },
        )
        clearTimeout(abortTimer)
        if (cancelled || !res.ok) return
        const data = await res.json() as { tag_name?: string; html_url?: string }
        const latest = String(data.tag_name || '').replace(/^v/, '')
        if (latest && data.html_url && semverGt(latest, currentVersion)) {
          setUpdate({ latest, current: currentVersion, download_url: data.html_url })
        }
      } catch {
        // Network failure / CORS / abort — leave NEW pill hidden.
      }
    }, CHECK_DELAY_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [currentVersion])

  return update
}
