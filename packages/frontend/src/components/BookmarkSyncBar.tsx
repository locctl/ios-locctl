import React, { useEffect, useState } from 'react'
import type { SyncStatus, UploadResult } from '../services/api'

// Inline SVG icons — emoji on macOS render inconsistently across system fonts
// (especially the variation-selector arrows), so we draw them ourselves.
const ICON_SIZE = 12
const iconWrap: React.CSSProperties = {
  display: 'inline-block', verticalAlign: '-2px', marginRight: 3,
}

const ArrowDownIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={iconWrap}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const ArrowUpIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={iconWrap}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

const GearIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={iconWrap}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const CloudIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 3 }}>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </svg>
)

const PinIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 3 }}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
)

export { CloudIcon, PinIcon }

interface Props {
  status: SyncStatus | null
  syncing: boolean
  hasCloudUpdates?: boolean
  onSync: () => Promise<void>
  onSetConfig: (patch: { sheet_url_or_id?: string; tab_name?: string; webhook_url?: string }) => Promise<void>
  onUpload: () => Promise<UploadResult>
}

/**
 * Three controls in one row above the bookmark list:
 *   • ☁ 同步       — pull from Sheets (B1)
 *   • 📤 上傳 N    — push local-only bookmarks via Apps Script webhook (B2)
 *   • ⚙           — config modal: Sheet URL + Webhook URL
 *
 * The upload button is only shown when there are pending local records,
 * so a fresh "all cloud" install isn't cluttered.
 */
const BookmarkSyncBar: React.FC<Props> = ({ status, syncing, hasCloudUpdates, onSync, onSetConfig, onUpload }) => {
  const [showConfig, setShowConfig] = useState(false)
  const [sheetInput, setSheetInput] = useState('')
  const [webhookInput, setWebhookInput] = useState('')
  const [configError, setConfigError] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [uploadingState, setUploadingState] = useState(false)
  const [transientMsg, setTransientMsg] = useState<string | null>(null)

  // Prefill modal whenever it opens — using values from the most recent
  // status fetch, not stale state.
  useEffect(() => {
    if (showConfig) {
      setSheetInput(status?.sheet_id || '')
      setWebhookInput(status?.webhook_url || '')
    }
  }, [showConfig, status])

  const flashMsg = (msg: string) => {
    setTransientMsg(msg)
    setTimeout(() => setTransientMsg(null), 4000)
  }

  const handleSync = async () => {
    if (!status?.configured) { setShowConfig(true); return }
    setSyncError(null)
    try {
      await onSync()
      flashMsg('✓ 已下載雲端書籤')
    } catch (e: any) {
      setSyncError(e?.message || '下載失敗')
    }
  }

  const handleUpload = async () => {
    if (!status?.webhook_configured) {
      setSyncError('請先設定 Webhook URL(按 ⚙)')
      setShowConfig(true)
      return
    }
    setSyncError(null)
    setUploadingState(true)
    try {
      const r = await onUpload()
      if (r.status === 'noop') {
        flashMsg('沒有待上傳的本地書籤')
      } else {
        const parts: string[] = []
        if (r.added) parts.push(`新增 ${r.added}`)
        if (r.updated) parts.push(`更新 ${r.updated}`)
        if (r.skipped) parts.push(`跳過 ${r.skipped}`)
        flashMsg(`✓ 已同步到雲端: ${parts.join('、') || '無變更'}`)
      }
    } catch (e: any) {
      setSyncError(e?.message || '上傳失敗')
    } finally {
      setUploadingState(false)
    }
  }

  const handleSaveConfig = async () => {
    setConfigError(null)
    setConfigSaving(true)
    try {
      await onSetConfig({ sheet_url_or_id: sheetInput.trim(), webhook_url: webhookInput.trim() })
      setShowConfig(false)
    } catch (e: any) {
      setConfigError(e?.message || '無法儲存設定')
    } finally {
      setConfigSaving(false)
    }
  }

  const pendingLocal = status?.pending_local_count ?? 0

  return (
    <>
      <div style={barStyle}>
        <button
          className="action-btn"
          style={{ ...syncBtnStyle, opacity: syncing ? 0.6 : 1, position: 'relative' }}
          disabled={syncing}
          onClick={handleSync}
          title={status?.configured ? '從雲端 Sheets 拉最新書籤到本機' : '設定 Sheets URL 後按此下載'}
        >
          <ArrowDownIcon /> {syncing ? '下載中⋯' : '下載雲端'}
          {hasCloudUpdates && !syncing && (
            <span style={updateBadgeStyle} title="雲端 Sheets 有變動,按下載同步">NEW</span>
          )}
        </button>
        {pendingLocal > 0 && (
          <button
            className="action-btn"
            style={{ ...uploadBtnStyle, opacity: uploadingState ? 0.6 : 1 }}
            disabled={uploadingState}
            onClick={handleUpload}
            title={status?.webhook_configured ? `把 ${pendingLocal} 筆本地書籤推到雲端 Sheets` : '請先設定 Webhook URL'}
          >
            <ArrowUpIcon /> {uploadingState ? '上傳中⋯' : `上傳本地 ${pendingLocal}`}
          </button>
        )}
        <span style={lastSyncedStyle}>
          {!status?.configured && '未設定雲端 Sheets'}
          {status?.configured && !status.last_synced_at && '尚未下載'}
          {status?.configured && status.last_synced_at && (
            transientMsg || `上次:${formatRelative(status.last_synced_at)}`
          )}
        </span>
        <button
          className="action-btn"
          style={configBtnStyle}
          onClick={() => setShowConfig(true)}
          title="設定 Sheets URL 與上傳 Webhook"
        >
          <GearIcon />
        </button>
      </div>
      {syncError && (
        <div style={syncErrStyle} onClick={() => setSyncError(null)}>{syncError}</div>
      )}

      {showConfig && (
        <div style={modalOverlay} onClick={() => !configSaving && setShowConfig(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={modalTitle}>雲端書籤設定</div>

            <label style={fieldLabel}>Google Sheets URL（下載雲端用）</label>
            <input
              type="text"
              className="search-input"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={sheetInput}
              autoFocus
              onChange={(e) => setSheetInput(e.target.value)}
              style={modalInput}
            />
            <p style={modalHelp}>
              試算表必須設成「<strong>知道連結的人都能查看</strong>」,tab 名稱固定為 <code>bookmarks</code>。
            </p>

            <label style={fieldLabel}>Apps Script Webhook URL（上傳本地用,可選）</label>
            <input
              type="text"
              className="search-input"
              placeholder="https://script.google.com/macros/s/.../exec"
              value={webhookInput}
              onChange={(e) => setWebhookInput(e.target.value)}
              style={modalInput}
            />
            <p style={modalHelp}>
              讓 app 內加的書籤一鍵推上雲端 Sheets。部署步驟見&nbsp;
              <code>scripts/sheets_seed/Code.gs</code> 檔頭註解。沒設也可以用 — 加的書籤就只在本機。
            </p>

            {configError && <div style={modalErr}>{configError}</div>}
            <div style={modalBtnRow}>
              <button className="action-btn" disabled={configSaving} onClick={() => setShowConfig(false)}>
                取消
              </button>
              <button
                className="action-btn primary"
                disabled={configSaving}
                onClick={handleSaveConfig}
              >
                {configSaving ? '儲存中⋯' : '儲存'}
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
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '4px 4px 6px', fontSize: 11,
  borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: 6,
}
const syncBtnStyle: React.CSSProperties = { padding: '3px 9px', fontSize: 11 }
const updateBadgeStyle: React.CSSProperties = {
  marginLeft: 6,
  padding: '0 5px',
  borderRadius: 8,
  background: 'linear-gradient(90deg, #ff6b6b, #ffc107)',
  color: '#fff',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.3,
  lineHeight: '14px',
  display: 'inline-block',
  verticalAlign: '1px',
}
const uploadBtnStyle: React.CSSProperties = {
  padding: '3px 9px', fontSize: 11,
  background: 'rgba(255, 193, 7, 0.18)',
  border: '1px solid rgba(255, 193, 7, 0.5)',
  color: '#ffc107',
}
const configBtnStyle: React.CSSProperties = { padding: '3px 7px', fontSize: 11, marginLeft: 'auto' }
const lastSyncedStyle: React.CSSProperties = { opacity: 0.6, fontSize: 10, fontFamily: 'monospace' }
const syncErrStyle: React.CSSProperties = {
  padding: '6px 8px', background: 'rgba(244, 67, 54, 0.12)',
  border: '1px solid rgba(244, 67, 54, 0.4)', borderRadius: 4,
  fontSize: 11, color: '#ff7066', marginBottom: 6, cursor: 'pointer',
}
const modalOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8, 10, 20, 0.55)',
  backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
  zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const modalCard: React.CSSProperties = {
  background: 'rgba(26, 29, 39, 0.96)',
  border: '1px solid rgba(108, 140, 255, 0.25)',
  borderRadius: 10, padding: 18, width: 460, color: '#e0e0e0',
  boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
}
const modalTitle: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 10 }
const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 11, opacity: 0.7, marginBottom: 4, fontWeight: 600,
}
const modalHelp: React.CSSProperties = {
  fontSize: 11, opacity: 0.6, lineHeight: 1.6, margin: '0 0 14px',
}
const modalInput: React.CSSProperties = { width: '100%', marginBottom: 4, fontSize: 12 }
const modalErr: React.CSSProperties = {
  padding: 8, background: 'rgba(244,67,54,0.12)',
  border: '1px solid rgba(244,67,54,0.4)', borderRadius: 4,
  fontSize: 11, color: '#ff7066', marginBottom: 8,
}
const modalBtnRow: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }

export default BookmarkSyncBar
