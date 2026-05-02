import React, { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
// USAGE.md sits at repo root; pull it as raw text at build time so the modal
// works offline and doesn't need a backend round trip.
import usageRaw from '../../../../USAGE.md?raw'

interface Props {
  open: boolean
  onClose: () => void
}

const UsageModal: React.FC<Props> = ({ open, onClose }) => {
  const html = useMemo(() => marked.parse(usageRaw, { async: false }) as string, [])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reset scroll to top when reopening
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={titleStyle}>📖 使用說明</span>
          <button style={closeBtn} onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div ref={scrollRef} style={scrollStyle}>
          <div className="usage-md" style={contentStyle} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 17, 23, 0.85)',
  backdropFilter: 'blur(8px)',
  zIndex: 9998,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const cardStyle: React.CSSProperties = {
  background: '#1a1d28',
  border: '1px solid rgba(108, 140, 255, 0.25)',
  borderRadius: 12,
  width: 'min(820px, 95vw)',
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  color: '#e5e7eb',
  boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 20px',
  borderBottom: '1px solid rgba(108, 140, 255, 0.15)',
  flexShrink: 0,
}

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#fff',
}

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 10px',
  borderRadius: 4,
  lineHeight: 1,
}

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 28px 28px',
}

const contentStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: '#c7cbd9',
}

export default UsageModal
