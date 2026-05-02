import React, { useState, useCallback, useEffect } from 'react'
import { useT } from './i18n'
import { useWebSocket } from './hooks/useWebSocket'
import { useDevice } from './hooks/useDevice'
import { useSimulation } from './hooks/useSimulation'
import { useJoystick } from './hooks/useJoystick'
import { useBookmarks } from './hooks/useBookmarks'
import * as api from './services/api'

import MapView from './components/MapView'
import ControlPanel from './components/ControlPanel'
import DeviceStatus from './components/DeviceStatus'
import JoystickPad from './components/JoystickPad'
import EtaBar from './components/EtaBar'
import PauseControl from './components/PauseControl'
import StatusBar from './components/StatusBar'
import BookmarkDialog, { type BookmarkDialogValue } from './components/BookmarkDialog'
import SetupWizard, { isSetupCompleted, resetSetup } from './components/SetupWizard'
import UsageModal from './components/UsageModal'
import NicknameModal from './components/NicknameModal'
import { useNickname } from './hooks/useNickname'

import { SimMode, MoveMode } from './hooks/useSimulation'

const SPEED_MAP: Record<MoveMode, number> = {
  walking: 5,
  running: 10,
  bicycling: 15,
  driving: 40,
}

const roundCoord6 = (n: number) => Number(n.toFixed(6))

const App: React.FC = () => {
  const t = useT()
  const ws = useWebSocket()
  const device = useDevice(ws.lastMessage)
  const sim = useSimulation(ws.lastMessage)
  const joystick = useJoystick(ws.sendMessage, sim.mode === SimMode.Joystick)
  const bm = useBookmarks()

  const [savedRoutes, setSavedRoutes] = useState<any[]>([])
  const [cooldown, setCooldown] = useState(0)
  const [cooldownEnabled, setCooldownEnabled] = useState(true)
  const [randomWalkRadius, setRandomWalkRadius] = useState(500)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [waypointPreviewPath, setWaypointPreviewPath] = useState<{ lat: number; lng: number }[]>([])
  const [directRouteMode, setDirectRouteMode] = useState(false)
  const [loopRouteMode, setLoopRouteMode] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState<{ lat: number; lng: number; label?: string; source?: string } | null>(null)
  const [recenterToCurrentSignal, setRecenterToCurrentSignal] = useState(0)
  const [bookmarkDialog, setBookmarkDialog] = useState<{
    mode: 'create' | 'edit'
    id?: string
    value: BookmarkDialogValue
  } | null>(null)
  const [showSetup, setShowSetup] = useState(() => !isSetupCompleted())
  const [showUsage, setShowUsage] = useState(false)
  const nickname = useNickname()
  const [showNicknameEdit, setShowNicknameEdit] = useState(false)
  // First-launch prompt: required and unsdismissable until set. Only fires
  // once the setup wizard is out of the way so we don't stack two modals.
  const showNicknameRequired = !showSetup && !nickname.isSet

  const showToast = useCallback((msg: string, ms = 2000) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), ms)
  }, [])

  // Show toast when device reconnects with restored position
  useEffect(() => {
    if (ws.lastMessage?.type === 'device_reconnected' && ws.lastMessage.data?.restored_position) {
      const pos = ws.lastMessage.data.restored_position
      showToast(t('toast.position_restored', { lat: pos.lat.toFixed(4), lng: pos.lng.toFixed(4) }), 4000)
    }
  }, [ws.lastMessage, showToast, t])

  const handleRestore = useCallback(async () => {
    // The backend stop + DVT clear can take a few seconds, especially if
    // movement was active or the channel is flaky. Give the user a visible
    // "working on it" toast up front so the UI doesn't feel frozen.
    showToast(t('status.restore_in_progress'), 10000)
    const startedAt = Date.now()
    try {
      await sim.restore()
      // Keep the in-progress toast visible for at least 1.2 s — otherwise a
      // fast restore (sub-second) would overwrite it before the user even
      // noticed it appeared.
      const elapsed = Date.now() - startedAt
      if (elapsed < 1200) {
        await new Promise((r) => setTimeout(r, 1200 - elapsed))
      }
      showToast(t('status.restore_success_wait'))
    } catch {
      showToast(t('status.restore_failed'))
    }
  }, [showToast, t, sim])

  const handleToggleCooldown = useCallback((enabled: boolean) => {
    setCooldownEnabled(enabled)
    api.setCooldownEnabled(enabled).catch(() => setCooldownEnabled((v) => !v))
  }, [])

  // Load saved routes on mount
  useEffect(() => {
    api.getSavedRoutes().then(setSavedRoutes).catch(() => {})
  }, [])

  // Auto-scan devices when WebSocket (re)connects (e.g. after backend restart)
  useEffect(() => {
    if (ws.connected) {
      device.scan()
    }
  }, [ws.connected])

  // Poll cooldown
  useEffect(() => {
    if (!ws.connected) return
    const id = setInterval(() => {
      api.getCooldownStatus().then((s: any) => {
        setCooldown(s.remaining_seconds ?? 0)
        if (typeof s.enabled === 'boolean') setCooldownEnabled(s.enabled)
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(id)
  }, [ws.connected])

  // -- Map handlers --
  const handleMapClick = useCallback((lat: number, lng: number) => {
    // Just set as destination for now
  }, [])

  const handleTeleport = useCallback((lat: number, lng: number) => {
    sim.teleport(lat, lng)
    setSelectedTarget(null)
  }, [sim])

  const handleNavigate = useCallback((lat: number, lng: number) => {
    sim.navigate(lat, lng, directRouteMode)
    setSelectedTarget(null)
  }, [sim, directRouteMode])

  const handleAddWaypointTarget = useCallback((lat: number, lng: number) => {
    sim.setWaypoints((prev: any[]) => {
      if (prev.length === 0 && sim.currentPosition) {
        return [
          { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
          { lat, lng },
        ]
      }
      return [...prev, { lat, lng }]
    })
    setSelectedTarget(null)
  }, [sim])

  const handleSelectTarget = useCallback((lat: number, lng: number, meta?: { label?: string; source?: string }) => {
    setSelectedTarget({ lat, lng, label: meta?.label, source: meta?.source })
  }, [])

  const handleCancelTarget = useCallback(() => {
    setSelectedTarget(null)
    setRecenterToCurrentSignal((prev) => prev + 1)
  }, [])

  const openBookmarkCreateDialog = useCallback((lat?: number, lng?: number) => {
    setBookmarkDialog({
      mode: 'create',
      value: {
        name: '',
        country: '',
        note: '',
        lat: lat != null ? String(roundCoord6(lat)) : '',
        lng: lng != null ? String(roundCoord6(lng)) : '',
        category: bm.categories[0]?.name || t('bm.default'),
      },
    })
  }, [bm.categories, t])

  const openBookmarkEditDialog = useCallback((bookmark: any) => {
    setBookmarkDialog({
      mode: 'edit',
      id: bookmark.id,
      value: {
        name: bookmark.name || '',
        country: bookmark.country || '',
        note: bookmark.note || '',
        lat: bookmark.lat != null ? String(roundCoord6(bookmark.lat)) : '',
        lng: bookmark.lng != null ? String(roundCoord6(bookmark.lng)) : '',
        category: bookmark.category || bm.categories[0]?.name || t('bm.default'),
      },
    })
  }, [bm.categories, t])

  const submitBookmarkDialog = useCallback(async () => {
    if (!bookmarkDialog) return
    const { value } = bookmarkDialog
    const name = value.name.trim()
    const lat = parseFloat(value.lat)
    const lng = parseFloat(value.lng)
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return
    const cat = bm.categories.find(c => c.name === value.category)
    try {
      if (bookmarkDialog.mode === 'edit' && bookmarkDialog.id) {
        await bm.updateBookmark(bookmarkDialog.id, {
          name,
          lat,
          lng,
          country: value.country.trim(),
          note: value.note.trim(),
          category_id: cat?.id || 'default',
          // Stamp the editor — added_by tracks "who last touched this" so
          // the cloud row reflects the most recent contributor.
          added_by: nickname.name,
        })
      } else {
        await bm.createBookmark({
          name,
          lat,
          lng,
          country: value.country.trim(),
          note: value.note.trim(),
          category_id: cat?.id || 'default',
          added_by: nickname.name,
        })
      }
      setBookmarkDialog(null)
    } catch (err) {
      console.error('Failed to save bookmark:', err)
    }
  }, [bookmarkDialog, bm, nickname.name])

  const handleAddWaypoint = useCallback((lat: number, lng: number) => {
    // Seed the list with the current device position as the implicit start
    // point on the first add. This keeps backend route and UI list aligned
    // so waypoint-progress highlighting indexes correctly, and removes the
    // "start button injects current pos every click" footgun.
    sim.setWaypoints((prev: any[]) => {
      if (prev.length === 0 && sim.currentPosition) {
        return [
          { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
          { lat, lng },
        ]
      }
      return [...prev, { lat, lng }]
    })
  }, [sim])

  const handleClearWaypoints = useCallback(() => {
    sim.setWaypoints([])
  }, [sim])

  const handleRemoveWaypoint = useCallback((index: number) => {
    sim.setWaypoints((prev: any[]) => prev.filter((_: any, i: number) => i !== index))
  }, [sim])

  useEffect(() => {
    let cancelled = false
    const route = sim.waypoints
    const shouldPreview = sim.mode === SimMode.MultiStop && route.length > 1

    if (!shouldPreview) {
      setWaypointPreviewPath([])
      return
    }

    const buildStraightPreview = () => {
      const preview = route.map((wp) => ({ lat: wp.lat, lng: wp.lng }))
      if (loopRouteMode && route.length > 1) {
        preview.push({ lat: route[0].lat, lng: route[0].lng })
      }
      return preview
    }

    const run = async () => {
      if (directRouteMode) {
        if (!cancelled) setWaypointPreviewPath(buildStraightPreview())
        return
      }

      const preview: { lat: number; lng: number }[] = []
      const legs: Array<[number, number, number, number]> = []

      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]
        const b = route[i + 1]
        legs.push([a.lat, a.lng, b.lat, b.lng])
      }
      if (loopRouteMode && route.length > 1) {
        const last = route[route.length - 1]
        const first = route[0]
        legs.push([last.lat, last.lng, first.lat, first.lng])
      }

      try {
        for (const [alat, alng, blat, blng] of legs) {
          const res = await api.planRoute({ lat: alat, lng: alng }, { lat: blat, lng: blng }, sim.moveMode)
          const coords = Array.isArray((res as any)?.coords) ? (res as any).coords : []
          if (!Array.isArray(coords) || coords.length === 0) continue
          for (let i = 0; i < coords.length; i++) {
            const pt = coords[i]
            const lat = Array.isArray(pt) ? pt[0] : pt.lat
            const lng = Array.isArray(pt) ? pt[1] : pt.lng
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
            if (preview.length > 0) {
              const prev = preview[preview.length - 1]
              const same = Math.abs(prev.lat - lat) < 1e-7 && Math.abs(prev.lng - lng) < 1e-7
              if (same) continue
            }
            preview.push({ lat, lng })
          }
        }
        if (!cancelled) {
          setWaypointPreviewPath(preview.length > 0 ? preview : buildStraightPreview())
        }
      } catch {
        if (!cancelled) setWaypointPreviewPath(buildStraightPreview())
      }
    }

    const timer = window.setTimeout(() => {
      void run()
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sim.mode, sim.moveMode, sim.waypoints, directRouteMode, loopRouteMode])

  const handleStartWaypointRoute = useCallback(() => {
    const route = sim.waypoints
    if (route.length < 2) {
      showToast(t('toast.no_waypoints'))
      return
    }
    const start = sim.currentPosition
    const routeWithStart = (() => {
      if (!start) return route
      const first = route[0]
      const sameStart = first && Math.abs(first.lat - start.lat) < 1e-7 && Math.abs(first.lng - start.lng) < 1e-7
      return sameStart ? route : [{ lat: start.lat, lng: start.lng }, ...route]
    })()
    if (sim.mode === SimMode.MultiStop) {
      sim.multiStop(routeWithStart, 0, loopRouteMode, directRouteMode)
    }
  }, [sim, showToast, t, loopRouteMode, directRouteMode])

  // -- ControlPanel handlers --
  const handleStart = useCallback(() => {
    if (sim.mode === SimMode.Joystick) {
      sim.joystickStart()
    } else if (sim.mode === SimMode.Navigate) {
      if (!selectedTarget) {
        showToast('請先選擇目標地點')
        return
      }
      sim.navigate(selectedTarget.lat, selectedTarget.lng, directRouteMode)
      setSelectedTarget(null)
    } else if (sim.mode === SimMode.RandomWalk) {
      if (!sim.currentPosition) {
        showToast(t('toast.no_position_random'))
        return
      }
      sim.randomWalk(sim.currentPosition, randomWalkRadius, directRouteMode)
    } else if (sim.mode === SimMode.MultiStop) {
      handleStartWaypointRoute()
    }
  }, [sim, randomWalkRadius, handleStartWaypointRoute, showToast, t, selectedTarget, directRouteMode])

  const handleStop = useCallback(() => {
    // Stop the active movement only — keep the simulated location in place
    // so the device stays where the user paused it. Use the 一鍵還原 button
    // separately to clear the simulated location and restore real GPS.
    sim.stop()
  }, [sim])

  const handleRouteLoad = useCallback((id: string) => {
    const route = savedRoutes.find((r) => r.id === id)
    if (!route || !Array.isArray(route.waypoints)) return
    sim.setWaypoints(route.waypoints.map((w: any) => ({ lat: w.lat, lng: w.lng })))
  }, [savedRoutes, sim])

  const handleRouteSave = useCallback(async (name: string) => {
    if (sim.waypoints.length === 0) {
      showToast(t('toast.route_need_waypoint'))
      return
    }
    try {
      await api.saveRoute({ name, waypoints: sim.waypoints, profile: sim.moveMode })
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.route_saved', { name }))
    } catch (err: any) {
      showToast(t('toast.route_save_failed', { msg: err.message || '' }))
    }
  }, [sim, showToast])

  const handleGpxImport = useCallback(async (file: File) => {
    try {
      const res = await api.importGpx(file)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.gpx_imported', { n: res.points }))
    } catch (err: any) {
      showToast(t('toast.gpx_import_failed', { msg: err.message || '' }))
    }
  }, [showToast])

  const handleGpxExport = useCallback((id: string) => {
    const url = api.exportGpxUrl(id)
    window.open(url, '_blank')
  }, [])

  const handleApplySpeed = useCallback(async () => {
    try {
      await sim.applySpeed()
      showToast(t('panel.apply_speed_success'))
    } catch (err: any) {
      showToast(t('panel.apply_speed_failed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [sim, showToast, t])

  const handleOpenLog = useCallback(async () => {
    try {
      // Open the folder, not the file — log can be large and copy/paste
      // from a multi-MB Notepad window is painful. Folder lets the user
      // attach the file directly to the Issue.
      await api.openLogFolder()
    } catch (err: any) {
      showToast(t('status.open_log_failed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [showToast, t])

  const handleOpenUsage = useCallback(() => {
    setShowUsage(true)
  }, [])

  const handleResetSetup = useCallback(() => {
    resetSetup()
    setShowSetup(true)
  }, [])

  const handleBookmarkImport = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const res = await api.importBookmarksCsv(text)
      await bm.refresh()
      const dup = res.skipped_duplicates
        ? `,跳過重複 ${res.skipped_duplicates}` : ''
      const errMsg = res.errors?.length
        ? `,${res.errors.length} 列格式錯誤(詳見 log)` : ''
      showToast(`匯入 ${res.imported} 筆${dup}${errMsg}`)
    } catch (err: any) {
      showToast(`匯入失敗: ${err?.message || 'unknown'}`)
    }
  }, [bm, showToast])

  const handleRouteRename = useCallback(async (id: string, name: string) => {
    try {
      await api.renameRoute(id, name)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
    } catch (err: any) {
      showToast(err.message || t('toast.route_rename_failed'))
    }
  }, [showToast])

  const handleRouteDelete = useCallback(async (id: string) => {
    try {
      await api.deleteRoute(id)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.route_deleted'))
    } catch (err: any) {
      showToast(err.message || t('toast.route_delete_failed'))
    }
  }, [showToast])

  // Build props for components
  const currentPos = sim.currentPosition
    ? { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }
    : null

  const destPos = sim.destination
    ? { lat: sim.destination.lat, lng: sim.destination.lng }
    : null

  const speed = SPEED_MAP[sim.moveMode] || 5
  // Status-bar display: when a route is running, show what the backend is
  // *actually* executing (set when the route starts or applySpeed succeeds);
  // otherwise show the typed inputs as a preview.
  const fmtSpeedFromInputs = (kmh: number | null, lo: number | null, hi: number | null): number | string => {
    if (lo != null && hi != null) return `${Math.min(lo, hi)}~${Math.max(lo, hi)}`
    if (kmh != null) return kmh
    return speed
  }
  const displaySpeed: number | string = sim.status.running && sim.effectiveSpeed
    ? fmtSpeedFromInputs(sim.effectiveSpeed.kmh, sim.effectiveSpeed.min, sim.effectiveSpeed.max)
    : fmtSpeedFromInputs(sim.customSpeedKmh, sim.speedMinKmh, sim.speedMaxKmh)

  // Determine running/paused state from status
  const isRunning = sim.status.running
  const isPaused = sim.status.paused

  return (
    <div className="app-layout">
      <div className="noise-overlay" aria-hidden />
      <div className="sidebar">
        <div className="sidebar-content">
        <DeviceStatus
          device={device.connectedDevice ? {
            id: device.connectedDevice.udid,
            name: device.connectedDevice.name,
            iosVersion: device.connectedDevice.ios_version,
            connectionType: device.connectedDevice.connection_type,
          } : null}
          devices={device.devices.map(d => ({
            id: d.udid,
            name: d.name,
            iosVersion: d.ios_version,
            connectionType: d.connection_type,
            wifiIp: (d as any).wifi_ip,
          }))}
          isConnected={device.connectedDevice !== null}
          onScan={() => {
            sim.clearError()
            void device.scan()
          }}
          onSelect={async (id: string) => {
            sim.clearError()
            const dev = device.devices.find(d => d.udid === id)
            await device.connect(id, (dev as any)?.wifi_ip)
          }}
        />
        <ControlPanel
          simMode={sim.mode}
          moveMode={sim.moveMode}
          speed={speed}
          isRunning={isRunning}
          isPaused={isPaused}
          currentPosition={currentPos}
          onModeChange={sim.setMode}
          onSpeedChange={(s: number) => {
            if (s <= 5) sim.setMoveMode(MoveMode.Walking)
            else if (s <= 10) sim.setMoveMode(MoveMode.Running)
            else if (s <= 16) sim.setMoveMode(MoveMode.Bicycling)
            else sim.setMoveMode(MoveMode.Driving)
          }}
          onMoveModeChange={sim.setMoveMode}
          customSpeedKmh={sim.customSpeedKmh}
          onCustomSpeedChange={sim.setCustomSpeedKmh}
          speedMinKmh={sim.speedMinKmh}
          onSpeedMinChange={sim.setSpeedMinKmh}
          speedMaxKmh={sim.speedMaxKmh}
          onSpeedMaxChange={sim.setSpeedMaxKmh}
          onStart={handleStart}
          onStop={handleStop}
          onPause={sim.pause}
          onResume={sim.resume}
          onRestore={handleRestore}
          onApplySpeed={handleApplySpeed}
          waypointProgress={sim.waypointProgress}
          onLocationPick={handleSelectTarget}
          bookmarks={bm.bookmarks.map(b => ({
            id: b.id,
            name: b.name,
            lat: b.lat,
            lng: b.lng,
            category: bm.categories.find(c => c.id === b.category_id)?.name || t('bm.default'),
            country: (b as any).country || '',
            note: b.note || '',
            source: (b as any).source || 'cloud',
            added_by: (b as any).added_by || '',
            added_at: (b as any).added_at || '',
          }))}
          bookmarkCategories={bm.categories.map(c => c.name)}
          onBookmarkClick={(b: any) => handleSelectTarget(b.lat, b.lng, { label: b.name, source: 'bookmark' })}
          onOpenBookmarkCreate={openBookmarkCreateDialog}
          onBookmarkDelete={(id: string) => bm.deleteBookmark(id)}
          onBookmarkEdit={openBookmarkEditDialog}
          onCategoryAdd={(name: string) => bm.createCategory({ name, color: '#6c8cff' })}
          onCategoryDelete={(name: string) => {
            const cat = bm.categories.find(c => c.name === name)
            if (cat) bm.deleteCategory(cat.id)
          }}
          onBookmarkImport={handleBookmarkImport}
          bookmarkExportUrl={api.bookmarksExportUrl()}
          bookmarkSyncStatus={bm.syncStatus}
          bookmarkSyncing={bm.syncing}
          onBookmarkSync={bm.syncFromSheets}
          onBookmarkSetSyncConfig={bm.setSheetConfig}
          onBookmarkUploadLocal={bm.uploadLocal}
          savedRoutes={savedRoutes.map(r => ({ id: r.id, name: r.name, waypoints: r.waypoints ?? [] }))}
          onRouteGpxImport={handleGpxImport}
          onRouteGpxExport={handleGpxExport}
          onRouteRename={handleRouteRename}
          onRouteDelete={handleRouteDelete}
          onRouteLoad={handleRouteLoad}
          onRouteSave={handleRouteSave}
          randomWalkRadius={randomWalkRadius}
          pauseRandomWalk={sim.pauseRandomWalk}
          onPauseRandomWalkChange={sim.setPauseRandomWalk}
          onRandomWalkRadiusChange={setRandomWalkRadius}
          currentWaypointsCount={sim.waypoints.length}
          movementSection={(sim.mode === SimMode.Navigate || sim.mode === SimMode.MultiStop || sim.mode === SimMode.RandomWalk || sim.mode === SimMode.Joystick) ? (
          <div className="section" style={{ margin: '0 0 8px 0' }}>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18" />
                <path d="M14 5l7 7-7 7" />
              </svg>
              移動方式
            </div>
            <div
              className="section-content"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 6,
              }}
            >
              <button
                type="button"
                className={`mode-btn${!directRouteMode ? ' active' : ''}`}
                disabled={sim.mode === SimMode.Joystick}
                onClick={() => setDirectRouteMode(false)}
                title={sim.mode === SimMode.Joystick ? '搖桿不支援道路規劃' : '沿道路'}
                style={{
                  justifyContent: 'flex-start',
                  minWidth: 0,
                  opacity: sim.mode === SimMode.Joystick ? 0.45 : 1,
                  cursor: sim.mode === SimMode.Joystick ? 'not-allowed' : 'pointer',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 18h4l3-7 4 3 3-6h4" />
                  <circle cx="7" cy="18" r="1.6" fill="currentColor" stroke="none" />
                  <circle cx="17" cy="8" r="1.6" fill="currentColor" stroke="none" />
                </svg>
                <span style={{ fontSize: 11, whiteSpace: 'normal', lineHeight: 1.15 }}>
                  沿道路
                </span>
              </button>
              <button
                type="button"
                className={`mode-btn${directRouteMode ? ' active' : ''}`}
                onClick={() => setDirectRouteMode(true)}
                title="直線移動"
                style={{ justifyContent: 'flex-start', minWidth: 0 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 19L20 5" />
                  <circle cx="4" cy="19" r="2" fill="currentColor" stroke="none" />
                  <circle cx="20" cy="5" r="2" fill="currentColor" stroke="none" />
                </svg>
                <span style={{ fontSize: 11, whiteSpace: 'normal', lineHeight: 1.15 }}>
                  直線移動
                </span>
              </button>
              {sim.mode === SimMode.Joystick && (
                <div style={{ gridColumn: '1 / -1', fontSize: 11, opacity: 0.55 }}>搖桿為即時自由移動，不支援道路規劃</div>
              )}
            </div>
          </div>
          ) : null}
          modeExtraSection={(sim.mode === SimMode.MultiStop) ? (
          <div className="section" style={{ margin: '0 0 8px 0' }}>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <line x1="12" y1="5" x2="12" y2="1" />
                <line x1="12" y1="23" x2="12" y2="19" />
              </svg>
              {t('panel.waypoints')} ({sim.waypoints.length})
              <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>{t('panel.waypoints_hint')}</span>
            </div>
              <div className="section-content">
                <PauseControl
                  labelKey='pause.multi_stop'
                  value={sim.pauseMultiStop}
                  onChange={sim.setPauseMultiStop}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 8px', fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={loopRouteMode}
                    onChange={(e) => setLoopRouteMode(e.target.checked)}
                  />
                  <span>循環巡迴</span>
                </label>
              {sim.waypoints.length === 0 && (
                <div style={{ fontSize: 12, opacity: 0.5, padding: '4px 0' }}>
                  {t('panel.waypoints_empty')}
                </div>
              )}
              {sim.waypoints.map((wp: any, i: number) => {
                // UI waypoints[0] = the implicit start position (current
                // device location at add-time). Backend seg_idx N = traveling
                // from waypoints[N] toward waypoints[N+1]; the *target* of
                // that segment is waypoints[N+1], so highlight i == seg+1.
                const seg = sim.waypointProgress?.current
                const approaching = seg != null && i === seg + 1
                const passed = seg != null && i <= seg
                const isStart = i === 0;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize: 12,
                      borderRadius: 4, marginBottom: 2,
                      background: approaching ? 'rgba(255, 152, 0, 0.18)' : 'transparent',
                      border: approaching ? '1px solid rgba(255, 152, 0, 0.6)' : '1px solid transparent',
                      opacity: passed ? 0.4 : 1,
                      transition: 'background 0.25s, border-color 0.25s',
                      animation: approaching ? 'wp-pulse 1.4s ease-in-out infinite' : undefined,
                    }}
                  >
                    <span style={{ color: approaching ? '#ff9800' : passed ? '#666' : isStart ? '#4caf50' : '#ff9800', fontWeight: 600, width: 24, fontSize: isStart ? 10 : undefined }}>
                      {approaching ? '>' : passed ? 'OK' : isStart ? t('panel.waypoint_start') : `#${i}`}
                    </span>
                    <span style={{ flex: 1, opacity: 0.85 }}>{wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}</span>
                    <button
                      className="action-btn"
                      style={{ padding: '2px 6px', fontSize: 10 }}
                      onClick={() => handleRemoveWaypoint(i)}
                      title={t('panel.waypoints_remove')}
                    >X</button>
                  </div>
                );
              })}
              {sim.waypoints.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    className="action-btn"
                    style={{ flex: 1 }}
                    onClick={handleClearWaypoints}
                    disabled={sim.status?.running}
                  >{t('generic.clear')}</button>
                </div>
              )}
            </div>
          </div>
          ) : null}
        />

        </div>
      </div>
      <div className="map-container">
        <EtaBar
          state={sim.status?.state ?? 'idle'}
          progress={sim.progress}
          remainingDistance={sim.status?.distance_remaining ?? 0}
          traveledDistance={sim.status?.distance_traveled ?? 0}
          eta={sim.eta ?? 0}
        />
        {sim.ddiMounting && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10000,
              background: 'rgba(20, 22, 32, 0.85)',
              backdropFilter: 'blur(3px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'auto',
            }}
          >
            <div
              style={{
                background: '#23232a',
                border: '1px solid #3a3a42',
                borderRadius: 8,
                padding: '20px 28px',
                maxWidth: 420,
                textAlign: 'center',
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
            >
              <svg
                width="32" height="32" viewBox="0 0 24 24" fill="none"
                stroke="#6c8cff" strokeWidth="2"
                style={{ animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}
              >
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
              </svg>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {t('ddi.mounting_title')}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                {t('ddi.mounting_hint')}
              </div>
            </div>
          </div>
        )}
        {sim.pauseRemaining != null && sim.pauseRemaining > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 38,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 901,
              background: 'rgba(255, 152, 0, 0.95)',
              color: '#1a1a1a',
              padding: '6px 14px',
              borderRadius: 18,
              fontSize: 12,
              fontWeight: 600,
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
            {t('toast.pause_countdown', { n: sim.pauseRemaining })}
          </div>
        )}
        <MapView
          currentPosition={currentPos}
          destination={selectedTarget ?? destPos}
          selectedTarget={selectedTarget}
          recenterToCurrentSignal={recenterToCurrentSignal}
          waypoints={sim.waypoints.map((w, i) => ({ ...w, index: i }))}
          routePath={sim.status?.running ? (sim.activeRoutePath.length > 0 ? sim.activeRoutePath : waypointPreviewPath) : waypointPreviewPath}
          randomWalkRadius={sim.mode === SimMode.RandomWalk ? randomWalkRadius : null}
          onMapClick={handleMapClick}
          onTeleport={handleTeleport}
          onNavigate={handleNavigate}
          onLocationPick={handleSelectTarget}
          onCancelTarget={handleCancelTarget}
          onAddTargetWaypoint={handleAddWaypointTarget}
          onRequestBookmarkCreateAt={openBookmarkCreateDialog}
          onAddWaypoint={handleAddWaypoint}
          showWaypointOption={sim.mode === SimMode.MultiStop || sim.mode === SimMode.Navigate}
          deviceConnected={device.connectedDevice !== null}
          onShowToast={showToast}
        />
        {sim.mode === SimMode.Joystick && (
          <JoystickPad
            direction={joystick.direction}
            intensity={joystick.intensity}
            onMove={joystick.updateFromPad}
            onRelease={() => joystick.updateFromPad(0, 0)}
          />
        )}
        <BookmarkDialog
          open={bookmarkDialog !== null}
          mode={bookmarkDialog?.mode ?? 'create'}
          categories={bm.categories.map(c => c.name)}
          value={bookmarkDialog?.value ?? {
            name: '',
            country: '',
            note: '',
            lat: '',
            lng: '',
            category: bm.categories[0]?.name || t('bm.default'),
          }}
          onChange={(value) => {
            setBookmarkDialog((prev) => prev ? { ...prev, value } : prev)
          }}
          onSave={submitBookmarkDialog}
          onCancel={() => setBookmarkDialog(null)}
        />
        {sim.error && (
          <div
            style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              zIndex: 2000, background: '#e53935', color: '#fff', padding: '8px 20px',
              borderRadius: 6, fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              cursor: 'pointer', maxWidth: '80%', textAlign: 'center',
            }}
            onClick={sim.clearError}
          >
            {sim.error}
          </div>
        )}
        <StatusBar
          isConnected={device.connectedDevice !== null}
          deviceName={device.connectedDevice?.name ?? ''}
          iosVersion={device.connectedDevice?.ios_version ?? ''}
          currentPosition={currentPos}
          speed={displaySpeed}
          mode={sim.mode}
          cooldown={cooldown}
          cooldownEnabled={cooldownEnabled}
          onToggleCooldown={handleToggleCooldown}
          onRestore={handleRestore}
          onOpenLog={handleOpenLog}
          onOpenUsage={handleOpenUsage}
          onResetSetup={handleResetSetup}
          nickname={nickname.name}
          onEditNickname={() => setShowNicknameEdit(true)}
        />

        {toastMsg && (
          <div
            key={toastMsg}
            className="anim-fade-slide-down"
            style={{
              position: 'fixed',
              top: 72,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1500,
              background: 'rgba(26, 29, 39, 0.92)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              color: '#fff',
              padding: '10px 18px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
              border: '1px solid rgba(108, 140, 255, 0.3)',
              maxWidth: '70vw',
              textAlign: 'center',
            }}
          >
            {toastMsg}
          </div>
        )}
      </div>
      {showSetup && <SetupWizard onComplete={() => setShowSetup(false)} onOpenUsage={() => setShowUsage(true)} />}
      <UsageModal open={showUsage} onClose={() => setShowUsage(false)} />
      <NicknameModal
        open={showNicknameRequired || showNicknameEdit}
        initial={nickname.name}
        required={showNicknameRequired}
        onSave={(n) => { nickname.set(n); setShowNicknameEdit(false) }}
        onCancel={() => setShowNicknameEdit(false)}
      />
    </div>
  )
}

export default App
