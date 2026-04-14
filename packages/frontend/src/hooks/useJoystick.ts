import { useState, useEffect, useCallback, useRef } from 'react'

interface KeyState {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

function keysToDirection(keys: KeyState): { direction: number; intensity: number } {
  const { up, down, left, right } = keys

  // No keys pressed
  if (!up && !down && !left && !right) {
    return { direction: 0, intensity: 0 }
  }

  let dx = 0
  let dy = 0

  if (up) dy += 1
  if (down) dy -= 1
  if (right) dx += 1
  if (left) dx -= 1

  // Convert to compass degrees: 0=N, 90=E, 180=S, 270=W
  // atan2 gives angle from positive x-axis counterclockwise
  // We want clockwise from north (positive y)
  const radians = Math.atan2(dx, dy)
  let degrees = (radians * 180) / Math.PI
  if (degrees < 0) degrees += 360

  return { direction: Math.round(degrees), intensity: 1.0 }
}

const KEY_MAP: Record<string, keyof KeyState> = {
  w: 'up',
  arrowup: 'up',
  s: 'down',
  arrowdown: 'down',
  a: 'left',
  arrowleft: 'left',
  d: 'right',
  arrowright: 'right',
}

export function useJoystick(
  sendWsMessage: (type: string, data: any) => void,
  active: boolean,
) {
  const [direction, setDirection] = useState(0)
  const [intensity, setIntensity] = useState(0)
  const keysRef = useRef<KeyState>({ up: false, down: false, left: false, right: false })
  const activeRef = useRef(active)
  const sendRef = useRef(sendWsMessage)

  // Keep refs in sync
  useEffect(() => {
    activeRef.current = active
  }, [active])
  useEffect(() => {
    sendRef.current = sendWsMessage
  }, [sendWsMessage])

  const emitState = useCallback((dir: number, int: number) => {
    setDirection(dir)
    setIntensity(int)
    sendRef.current('joystick_input', { direction: dir, intensity: int })
  }, [])

  // Reset keys when deactivated
  useEffect(() => {
    if (!active) {
      keysRef.current = { up: false, down: false, left: false, right: false }
      setDirection(0)
      setIntensity(0)
    }
  }, [active])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current) return

      const mapped = KEY_MAP[e.key.toLowerCase()]
      if (!mapped) return

      e.preventDefault()

      const keys = keysRef.current
      if (keys[mapped]) return // already pressed

      keys[mapped] = true
      const { direction: dir, intensity: int } = keysToDirection(keys)
      emitState(dir, int)
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!activeRef.current) return

      const mapped = KEY_MAP[e.key.toLowerCase()]
      if (!mapped) return

      e.preventDefault()

      const keys = keysRef.current
      keys[mapped] = false
      const { direction: dir, intensity: int } = keysToDirection(keys)
      emitState(dir, int)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [emitState])

  // For the virtual joystick pad (mouse / touch)
  const updateFromPad = useCallback(
    (dir: number, int: number) => {
      emitState(dir, Math.min(1, Math.max(0, int)))
    },
    [emitState],
  )

  return { direction, intensity, updateFromPad }
}
