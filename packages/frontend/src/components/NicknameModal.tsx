import React, { useEffect, useState } from 'react'

interface Props {
  open: boolean
  initial?: string
  /** When required, the modal can't be dismissed without saving — used for the
   *  first-launch prompt so we always know who's adding bookmarks. */
  required?: boolean
  onSave: (nickname: string) => void
  onCancel?: () => void
}

const NicknameModal: React.FC<Props> = ({ open, initial = '', required, onSave, onCancel }) => {
  const [val, setVal] = useState(initial)

  useEffect(() => { if (open) setVal(initial) }, [open, initial])

  if (!open) return null

  const trimmed = val.trim()
  const canSave = trimmed.length > 0 && trimmed.length <= 32

  return (
    <div
      style={overlayStyle}
      onClick={() => { if (!required && onCancel) onCancel() }}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>你的暱稱</div>
        <input
          type="text"
          className="search-input"
          placeholder="例如:mars"
          value={val}
          maxLength={32}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSave) onSave(trimmed) }}
          style={inputStyle}
        />
        <div style={btnRow}>
          {!required && onCancel && (
            <button className="action-btn" onClick={onCancel}>取消</button>
          )}
          <button
            className="action-btn primary"
            disabled={!canSave}
            onClick={() => onSave(trimmed)}
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8, 10, 20, 0.6)',
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
  zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const cardStyle: React.CSSProperties = {
  background: 'rgba(26, 29, 39, 0.97)',
  border: '1px solid rgba(108, 140, 255, 0.3)',
  borderRadius: 10, padding: '20px 22px', width: 360, color: '#e0e0e0',
  boxShadow: '0 24px 64px rgba(12, 18, 40, 0.7)',
}
const titleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 8 }
const helpStyle: React.CSSProperties = { fontSize: 12, opacity: 0.7, lineHeight: 1.6, margin: '0 0 14px' }
const inputStyle: React.CSSProperties = { width: '100%', marginBottom: 14, fontSize: 13 }
const btnRow: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }

export default NicknameModal
