import React, { useEffect, useState } from 'react'
import type { SyncStatus } from '../services/api'

interface Props {
  status: SyncStatus | null
  syncing: boolean
  onSync: () => Promise<void>
  onSetConfig: (urlOrId: string) => Promise<void>
}

/**
 * Compact bar above the bookmark list with three pieces of state:
 *   • last-synced relative time (or "未設定" / "未同步")
 *   • ☁️ 同步 button (disabled while in flight)
 *   • ⚙️ button → opens the Sheets URL config modal
 *
 * If the user hasn't configured a sheet yet, clicking 同步 also opens the
 * config modal (so first-run is one click, not two).
 */
const BookmarkSyncBar: React.FC<Props> = ({ status, syncing, onSync, onSetConfig }) => {
  const [showConfig, setShowConfig] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [configError, setConfigError] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncedJustNow, setSyncedJustNow] = useState(false)

  useEffect(() => {
    if (showConfig && status?.sheet_id) setUrlInput(status.sheet_id)
  }, [showConfig, status?.sheet_id])

  const handleSync = async () => {
    if (!status?.configured) { setShowConfig(true); return }
    setSyncError(null)
    try {
      await onSync()
      setSyncedJustNow(true)
      setTimeout(() => setSyncedJustNow(false), 3000)
    } catch (e: any) {
      setSyncError(e?.message || '同步失敗')
    }
  }

  const handleSaveConfig = async () => {
    setConfigError(null)
    setConfigSaving(true)
    try {
      await onSetConfig(urlInput.trim())
      setShowConfig(false)
      // Auto-sync right after first config — user just typed the URL, they
      // expect data to appear without clicking again.
      try { await onSync() } catch { /* surface as syncError next render */ }
    } catch (e: any) {
      setConfigError(e?.message || '無法儲存設定')
    } finally {
      setConfigSaving(false)
    }
  }

  return (
    <>
      <div style={barStyle}>
        <button
          className="action-btn"
          style={{ ...syncBtnStyle, opacity: syncing ? 0.6 : 1 }}
          disabled={syncing}
          onClick={handleSync}
          title={status?.configured ? '從 Google Sheets 拉最新書籤' : '設定 Sheets URL 後按此同步'}
        >
          {syncing ? '☁︎ 同步中⋯' : '☁ 同步'}
        </button>
        <span style={lastSyncedStyle}>
          {!status?.configured && '未設定共編 Sheets'}
          {status?.configured && !status.last_synced_at && '尚未同步'}
          {status?.configured && status.last_synced_at && (
            syncedJustNow ? '✓ 剛剛同步' : `上次:${formatRelative(status.last_synced_at)}`
          )}
        </span>
        <button
          className="action-btn"
          style={configBtnStyle}
          onClick={() => setShowConfig(true)}
          title="設定 Google Sheets URL"
        >
          ⚙
        </button>
      </div>
      {syncError && (
        <div style={syncErrStyle} onClick={() => setSyncError(null)}>{syncError}</div>
      )}

      {showConfig && (
        <div style={modalOverlay} onClick={() => !configSaving && setShowConfig(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={modalTitle}>設定共編 Google Sheets</div>
            <p style={modalHelp}>
              貼上 Google Sheets 的 URL 或 ID。試算表必須設成「<strong>知道連結的人都能查看</strong>」，
              tab 名稱固定為 <code>bookmarks</code>。
            </p>
            <input
              type="text"
              className="search-input"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={urlInput}
              autoFocus
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveConfig() }}
              style={modalInput}
            />
            {configError && <div style={modalErr}>{configError}</div>}
            <div style={modalBtnRow}>
              <button className="action-btn" disabled={configSaving} onClick={() => setShowConfig(false)}>
                取消
              </button>
              <button
                className="action-btn primary"
                disabled={configSaving || !urlInput.trim()}
                onClick={handleSaveConfig}
              >
                {configSaving ? '儲存中⋯' : '儲存並同步'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (!Number.isFinite(t) || diff < 0) return iso
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '剛剛'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分鐘前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小時前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

// ── Styles ───────────────────────────────────────────────────────

const barStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 4px 6px',
  fontSize: 11,
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  marginBottom: 6,
}
const syncBtnStyle: React.CSSProperties = { padding: '3px 9px', fontSize: 11 }
const configBtnStyle: React.CSSProperties = { padding: '3px 7px', fontSize: 11, marginLeft: 'auto' }
const lastSyncedStyle: React.CSSProperties = {
  opacity: 0.6, fontSize: 10, fontFamily: 'monospace',
}
const syncErrStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: 'rgba(244, 67, 54, 0.12)',
  border: '1px solid rgba(244, 67, 54, 0.4)',
  borderRadius: 4,
  fontSize: 11,
  color: '#ff7066',
  marginBottom: 6,
  cursor: 'pointer',
}
const modalOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8, 10, 20, 0.55)',
  backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
  zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const modalCard: React.CSSProperties = {
  background: 'rgba(26, 29, 39, 0.96)',
  border: '1px solid rgba(108, 140, 255, 0.25)',
  borderRadius: 10, padding: 18, width: 380, color: '#e0e0e0',
  boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
}
const modalTitle: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 8 }
const modalHelp: React.CSSProperties = { fontSize: 12, opacity: 0.7, lineHeight: 1.6, margin: '0 0 10px' }
const modalInput: React.CSSProperties = { width: '100%', marginBottom: 8, fontSize: 12 }
const modalErr: React.CSSProperties = {
  padding: 8, background: 'rgba(244,67,54,0.12)', border: '1px solid rgba(244,67,54,0.4)',
  borderRadius: 4, fontSize: 11, color: '#ff7066', marginBottom: 8,
}
const modalBtnRow: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }

export default BookmarkSyncBar
