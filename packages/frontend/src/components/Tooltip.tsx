import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content?: React.ReactNode
  children: React.ReactElement
  placement?: 'top' | 'bottom'
  offset?: number
}

type Pos = { top: number; left: number }

const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'top',
  offset = 10,
}) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos>({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  const updatePosition = () => {
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const rect = trigger.getBoundingClientRect()
    const tipRect = tip.getBoundingClientRect()
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - tipRect.width / 2),
      window.innerWidth - tipRect.width - 8,
    )
    const desiredTop = placement === 'bottom'
      ? rect.bottom + offset
      : rect.top - tipRect.height - offset
    const top = desiredTop < 8 && placement === 'top'
      ? rect.bottom + offset
      : desiredTop
    setPos({
      left,
      top: Math.max(8, top),
    })
  }

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => updatePosition())
    const onChange = () => updatePosition()
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open, placement, offset])

  if (!content) return children

  const child = React.cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const childRef = (children as any).ref
      if (typeof childRef === 'function') childRef(node)
      else if (childRef && typeof childRef === 'object') childRef.current = node
    },
    onMouseEnter: (e: React.MouseEvent) => {
      setOpen(true)
      children.props.onMouseEnter?.(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      setOpen(false)
      children.props.onMouseLeave?.(e)
    },
  })

  return (
    <>
      {child}
      {open && createPortal(
        <div
          ref={tipRef}
          className="ui-tooltip"
          style={{ top: pos.top, left: pos.left }}
          role="tooltip"
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}

export default Tooltip
