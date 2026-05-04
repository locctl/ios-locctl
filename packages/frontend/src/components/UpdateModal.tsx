import React from 'react'

interface Props {
  open: boolean
  latest: string
  current: string
  downloadUrl: string
  onDismiss: () => void
}

const UpdateModal: React.FC<Props> = ({ open, latest, current, downloadUrl, onDismiss }) => {
  if (!open) return null

  const handleDownload = () => {
    window.open(downloadUrl, '_blank')
    onDismiss()
  }

  return (
    <div style={overlayStyle} onClick={onDismiss}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={iconRow}>
          <div style={iconBubble}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div>
            <div style={titleStyle}>有新版本可下載</div>
            <div style={subtitleStyle}>
              <span style={versionPill}>v{latest}</span>
              <span style={{ opacity: 0.5, margin: '0 6px' }}>←</span>
              <span style={{ opacity: 0.65, fontFamily: 'monospace' }}>v{current}</span>
            </div>
          </div>
        </div>
        <p style={bodyStyle}>
          下載新 dmg → 拖到 Applications → 第一次開要右鍵「開啟」一次。
        </p>
        <div style={btnRow}>
          <button className="action-btn" onClick={onDismiss}>稍後再說</button>
          <button className="action-btn primary" onClick={handleDownload} style={{ minWidth: 110 }}>
            前往下載
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8, 10, 20, 0.6)',
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
  zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const cardStyle: React.CSSProperties = {
  background: 'rgba(26, 29, 39, 0.97)',
  border: '1px solid rgba(108, 140, 255, 0.3)',
  borderRadius: 12, padding: '22px 24px', width: 400, color: '#e0e0e0',
  boxShadow: '0 24px 64px rgba(12, 18, 40, 0.7)',
}
const iconRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12,
}
const iconBubble: React.CSSProperties = {
  width: 44, height: 44, borderRadius: 22,
  background: 'linear-gradient(135deg, #ff6b6b, #ffc107)',
  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}
const titleStyle: React.CSSProperties = { fontSize: 16, fontWeight: 600 }
const subtitleStyle: React.CSSProperties = { marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center' }
const versionPill: React.CSSProperties = {
  padding: '1px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
  background: 'linear-gradient(90deg, #ff6b6b, #ffc107)', color: '#fff',
  fontFamily: 'monospace', letterSpacing: 0.3,
}
const bodyStyle: React.CSSProperties = {
  fontSize: 13, opacity: 0.78, lineHeight: 1.7, margin: '4px 0 18px',
}
const btnRow: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }

export default UpdateModal
