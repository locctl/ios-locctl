import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../services/api'

export interface Bookmark {
  id: string
  name: string
  lat: number
  lng: number
  category_id?: string
  note?: string
  created_at?: string
  // Phase A — cloud-coediting fields
  country?: string
  updated_by?: string
  updated_at?: string
  source?: 'cloud' | 'local' | 'deleted'
  last_interacted_at?: string
}

export interface BookmarkCategory {
  id: string
  name: string
  color?: string
  sort_order?: number
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [categories, setCategories] = useState<BookmarkCategory[]>([])
  const [loading, setLoading] = useState(false)
  // Phase B1 — Sheets sync state
  const [syncStatus, setSyncStatus] = useState<api.SyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Cheap "is the cloud ahead of us?" probe. Updated on mount + after every
  // sync; the SyncBar uses it to badge the download button.
  const [hasCloudUpdates, setHasCloudUpdates] = useState(false)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [bms, cats] = await Promise.all([
        api.getBookmarks(),
        api.getCategories(),
      ])
      if (!mountedRef.current) return
      setBookmarks(Array.isArray(bms) ? bms : bms.bookmarks ?? [])
      setCategories(Array.isArray(cats) ? cats : [])
    } catch (err) {
      console.error('Failed to load bookmarks:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const refreshSyncStatus = useCallback(async () => {
    try {
      const s = await api.getSyncStatus()
      if (mountedRef.current) setSyncStatus(s)
    } catch (err) {
      console.error('Failed to load sync status:', err)
    }
  }, [])

  const checkCloudUpdates = useCallback(async () => {
    try {
      const r = await api.checkSyncDiff()
      if (mountedRef.current) setHasCloudUpdates(r.has_updates)
    } catch {
      // Network blip — keep current state, the badge isn't worth a UI alert
    }
  }, [])

  // Load on mount
  useEffect(() => {
    mountedRef.current = true
    refresh()
    refreshSyncStatus()
    checkCloudUpdates()
    return () => {
      mountedRef.current = false
    }
  }, [refresh, refreshSyncStatus, checkCloudUpdates])

  const syncFromSheets = useCallback(async () => {
    setSyncing(true)
    try {
      await api.syncBookmarks()
      await Promise.all([refresh(), refreshSyncStatus()])
      // After sync we're guaranteed to be caught up.
      if (mountedRef.current) setHasCloudUpdates(false)
    } finally {
      if (mountedRef.current) setSyncing(false)
    }
  }, [refresh, refreshSyncStatus])

  const setSheetConfig = useCallback(
    async (patch: { sheet_url_or_id?: string; tab_name?: string; webhook_url?: string }) => {
      await api.setSyncConfig(patch)
      await refreshSyncStatus()
    },
    [refreshSyncStatus],
  )

  const uploadLocal = useCallback(async () => {
    const result = await api.uploadLocalBookmarks()
    await Promise.all([refresh(), refreshSyncStatus()])
    return result
  }, [refresh, refreshSyncStatus])

  // Mutating operations also refresh syncStatus because the upload button's
  // visibility depends on pending_local_count — if we don't refresh here, the
  // sync bar lags behind reality after every add/edit/delete.
  const createBookmark = useCallback(
    async (bm: Omit<Bookmark, 'id'>) => {
      const created = await api.createBookmark(bm)
      await Promise.all([refresh(), refreshSyncStatus()])
      return created
    },
    [refresh, refreshSyncStatus],
  )

  const deleteBookmark = useCallback(
    async (id: string) => {
      await api.deleteBookmark(id)
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
      await refreshSyncStatus()
    },
    [refreshSyncStatus],
  )

  const updateBookmark = useCallback(
    async (id: string, data: Partial<Bookmark>) => {
      const updated = await api.updateBookmark(id, data)
      await Promise.all([refresh(), refreshSyncStatus()])
      return updated
    },
    [refresh, refreshSyncStatus],
  )

  const moveBookmarks = useCallback(
    async (ids: string[], categoryId: string) => {
      await api.moveBookmarks(ids, categoryId)
      await refresh()
    },
    [refresh],
  )

  const createCategory = useCallback(
    async (cat: Omit<BookmarkCategory, 'id'>) => {
      const created = await api.createCategory(cat)
      await refresh()
      return created
    },
    [refresh],
  )

  const deleteCategory = useCallback(
    async (id: string) => {
      await api.deleteCategory(id)
      await refresh()
    },
    [refresh],
  )

  const updateCategory = useCallback(
    async (id: string, data: Partial<BookmarkCategory>) => {
      const updated = await api.updateCategory(id, data)
      await refresh()
      return updated
    },
    [refresh],
  )

  return {
    bookmarks,
    categories,
    loading,
    createBookmark,
    updateBookmark,
    deleteBookmark,
    moveBookmarks,
    createCategory,
    deleteCategory,
    updateCategory,
    refresh,
    // Phase B1
    syncStatus,
    syncing,
    syncFromSheets,
    setSheetConfig,
    refreshSyncStatus,
    hasCloudUpdates,
    checkCloudUpdates,
    // Phase B2
    uploadLocal,
  }
}
