import React, { useState } from 'react'
import type { SyncStatus, UploadResult } from '../services/api'

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

interface Props {
  status: SyncStatus | null
  syncing: boolean
  onSync: () => Promise<void>
  onUpload: () => Promise<UploadResult>
}

const RouteSyncBar: React.FC<Props> = ({ status, syncing, onSync, onUpload }) => {
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const pending = status?.pending_local_count ?? 0

  const flash = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(null), 3500)
  }

  return (
    <>
      <div style={barStyle}>
        <button
          className="action-btn"
          style={{ ...syncBtnStyle, opacity: syncing ? 0.6 : 1 }}
          disabled={syncing}
          onClick={async () => {
            setErr(null)
            try { await onSync(); flash('✓ 已下載雲端路線') } catch (e: any) { setErr(e?.message || '下載失敗') }
          }}
        >
          <ArrowDownIcon /> {syncing ? '下載中⋯' : '下載雲端'}
        </button>
        {pending > 0 && (
          <button
            className="action-btn"
            style={{ ...uploadBtnStyle, opacity: uploading ? 0.6 : 1 }}
            disabled={uploading}
            onClick={async () => {
              setErr(null)
              setUploading(true)
              try {
                const r = await onUpload()
                if (r.status === 'noop') flash('沒有待上傳的路線')
                else flash(`✓ 已同步路線: 新增 ${r.added || 0}、修改 ${r.updated || 0}${r.deleted ? `、刪除 ${r.deleted}` : ''}`)
              } catch (e: any) {
                setErr(e?.message || '上傳失敗')
              } finally {
                setUploading(false)
              }
            }}
          >
            <ArrowUpIcon /> {uploading ? '上傳中⋯' : `上傳變更 ${pending}`}
          </button>
        )}
        <span style={lastSyncedStyle}>
          {msg || (pending > 0 ? `本地有 ${pending} 筆變更` : (!status?.last_synced_at ? '尚未同步' : `最後同步 ${formatRelative(status.last_synced_at)}`))}
        </span>
      </div>
      {err && (
        <div style={syncErrStyle}>
          {err}
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

const barStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '4px 4px 6px', fontSize: 11,
  borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: 6,
}
const syncBtnStyle: React.CSSProperties = { padding: '3px 9px', fontSize: 11 }
const uploadBtnStyle: React.CSSProperties = {
  padding: '3px 9px', fontSize: 11,
  background: 'rgba(255, 193, 7, 0.18)',
  border: '1px solid rgba(255, 193, 7, 0.5)',
  color: '#ffc107',
}
const lastSyncedStyle: React.CSSProperties = { marginLeft: 'auto', opacity: 0.6, fontSize: 10, fontFamily: 'monospace' }
const syncErrStyle: React.CSSProperties = {
  padding: '6px 8px', background: 'rgba(244,67,54,0.12)',
  border: '1px solid rgba(244,67,54,0.4)', borderRadius: 4,
  fontSize: 11, color: '#ff7066', marginBottom: 6,
}

export default RouteSyncBar
