import { useCallback, useEffect, useState } from 'react'

const KEY = 'bm.nickname'

export function getNickname(): string {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

export function saveNickname(name: string): void {
  try { localStorage.setItem(KEY, name) } catch { /* ignore */ }
  // Notify other instances of useNickname in the same tab so the StatusBar
  // updates immediately when the modal saves a new value.
  try { window.dispatchEvent(new CustomEvent('nickname-changed', { detail: name })) } catch { /* ignore */ }
}

export function useNickname() {
  const [name, setName] = useState<string>(() => getNickname())

  useEffect(() => {
    const onChange = (e: Event) => {
      const v = (e as CustomEvent<string>).detail
      setName(typeof v === 'string' ? v : getNickname())
    }
    window.addEventListener('nickname-changed', onChange)
    return () => window.removeEventListener('nickname-changed', onChange)
  }, [])

  const set = useCallback((n: string) => {
    const trimmed = n.trim()
    saveNickname(trimmed)
    setName(trimmed)
  }, [])

  return { name, set, isSet: !!name }
}
