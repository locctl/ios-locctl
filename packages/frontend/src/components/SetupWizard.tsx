import React, { useEffect, useState, useCallback } from 'react'
import * as api from '../services/api'

const SETUP_FLAG = 'setup_completed_v1'

export function isSetupCompleted(): boolean {
  try {
    return localStorage.getItem(SETUP_FLAG) === 'true'
  } catch {
    return false
  }
}

export function resetSetup(): void {
  try {
    localStorage.removeItem(SETUP_FLAG)
  } catch {
    /* ignore */
  }
}

function markCompleted(): void {
  try {
    localStorage.setItem(SETUP_FLAG, 'true')
  } catch {
    /* ignore */
  }
}

type Step = 'welcome' | 'device' | 'trigger' | 'devmode' | 'ddi' | 'done'
type DevModePath = 'manual' | 'auto'

interface DeviceItem {
  udid: string
  name: string
  ios_version: string
  is_connected: boolean
  connection_type?: string
}

interface SetupWizardProps {
  onComplete: () => void
  onOpenUsage?: () => void
}

const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete, onOpenUsage }) => {
  const [step, setStep] = useState<Step>('welcome')
  const [devModePath, setDevModePath] = useState<DevModePath>('manual')
  const [devices, setDevices] = useState<DeviceItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // ── Step 2: poll for device while on the device step ─────────────
  useEffect(() => {
    if (step !== 'device') return
    let alive = true
    const tick = async () => {
      try {
        const list = await api.listDevices()
        if (!alive) return
        setDevices(list as DeviceItem[])
      } catch {
        /* ignore polling errors */
      }
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [step])

  const goNext = useCallback((next: Step) => {
    setError(null)
    setInfo(null)
    setStep(next)
  }, [])

  const handleTrigger = useCallback(async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await api.triggerDevModeToggle()
      setInfo(r.next_step)
      // Auto-advance after a beat so the user sees the success message
      setTimeout(() => goNext('devmode'), 1200)
    } catch (e: any) {
      setError(e?.message || '無法觸發 Developer Mode toggle')
    } finally {
      setBusy(false)
    }
  }, [goNext])

  const handleManualConfirm = useCallback(async () => {
    // No real verification — Developer Mode status isn't exposed on lockdown
    // until you try to use a dev service. Trust the user and continue.
    goNext('ddi')
  }, [goNext])

  const handleAutoEnable = useCallback(async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await api.enableDevMode()
      setInfo(r.next_step)
    } catch (e: any) {
      const msg = e?.message || '無法自動開啟開發者模式'
      if (msg.includes('密碼')) {
        setError(msg + '\n\n關閉密碼後再點一次這個按鈕。')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const handleMountDdi = useCallback(async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await api.mountDdi()
      const msg = r.status === 'already_mounted'
        ? 'Developer Disk Image 已掛載'
        : 'Developer Disk Image 掛載成功'
      setInfo(msg)
      setTimeout(() => goNext('done'), 1200)
    } catch (e: any) {
      setError(e?.message || 'DDI 掛載失敗 — 可能還沒開啟 Developer Mode 或網路無法連到 github.com')
    } finally {
      setBusy(false)
    }
  }, [goNext])

  const handleFinish = useCallback(() => {
    markCompleted()
    onComplete()
  }, [onComplete])

  const usbDevice = devices.find((d) => (d.connection_type || 'USB').toUpperCase() === 'USB')
  const hasUsb = !!usbDevice

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <ProgressBar step={step} />
        {step === 'welcome' && (
          <WelcomeStep onNext={() => goNext('device')} />
        )}
        {step === 'device' && (
          <DeviceStep
            devices={devices}
            usbDevice={usbDevice}
            onNext={() => goNext('trigger')}
            onSkip={() => goNext('done')}
          />
        )}
        {step === 'trigger' && (
          <TriggerStep
            busy={busy}
            error={error}
            info={info}
            hasUsb={hasUsb}
            onRun={handleTrigger}
            onSkip={() => goNext('devmode')}
          />
        )}
        {step === 'devmode' && (
          <DevModeStep
            path={devModePath}
            onSwitchPath={setDevModePath}
            busy={busy}
            error={error}
            info={info}
            onConfirmManual={handleManualConfirm}
            onAutoEnable={handleAutoEnable}
          />
        )}
        {step === 'ddi' && (
          <DdiStep
            busy={busy}
            error={error}
            info={info}
            onMount={handleMountDdi}
            onSkip={() => goNext('done')}
          />
        )}
        {step === 'done' && (
          <DoneStep onFinish={handleFinish} onOpenUsage={onOpenUsage} />
        )}
      </div>
    </div>
  )
}

// ── Step components ──────────────────────────────────────────────

const WelcomeStep: React.FC<{ onNext: () => void }> = ({ onNext }) => (
  <div>
    <h1 style={h1Style}>歡迎使用 ios-locctl</h1>
    <p style={pStyle}>
      接下來引導你完成首次設定。整個過程大約 3-5 分鐘。
    </p>
    <ul style={ulStyle}>
      <li>準備一條 USB 資料線（不能只是充電線）</li>
      <li>iPhone / iPad 需要 iOS 17 以上</li>
      <li>過程中可能會跳出系統密碼視窗，請輸入你 Mac 的登入密碼</li>
    </ul>
    <button style={primaryBtn} onClick={onNext}>開始 →</button>
  </div>
)

const DeviceStep: React.FC<{
  devices: DeviceItem[]
  usbDevice?: DeviceItem
  onNext: () => void
  onSkip: () => void
}> = ({ usbDevice, onNext, onSkip }) => (
  <div>
    <h1 style={h1Style}>連接 iPhone</h1>
    <ol style={olStyle}>
      <li>用 USB 資料線把 iPhone 接到這台 Mac</li>
      <li>iPhone 解鎖</li>
      <li>iPhone 跳出「信任這台電腦」→ 按「信任」→ 輸入裝置密碼</li>
    </ol>
    <div style={statusBoxStyle}>
      {usbDevice ? (
        <span style={{ color: '#4caf50' }}>
          ✓ 偵測到 {usbDevice.name}（iOS {usbDevice.ios_version}）
        </span>
      ) : (
        <span style={{ color: '#ffc107' }}>等待裝置中⋯</span>
      )}
    </div>
    <div style={btnRow}>
      <button style={ghostBtn} onClick={onSkip}>跳過</button>
      <button style={primaryBtn} disabled={!usbDevice} onClick={onNext}>下一步 →</button>
    </div>
  </div>
)

const TriggerStep: React.FC<{
  busy: boolean
  error: string | null
  info: string | null
  hasUsb: boolean
  onRun: () => void
  onSkip: () => void
}> = ({ busy, error, info, hasUsb, onRun, onSkip }) => (
  <div>
    <h1 style={h1Style}>準備 Developer Mode 選項</h1>
    <p style={pStyle}>
      iOS 16 以後，Developer Mode 的開關預設是<strong>隱藏</strong>的，必須先有電腦對 iPhone 做過開發者操作，這個選項才會出現。
    </p>
    <p style={pStyle}>
      點下面的按鈕讓 app 幫你戳一下 iPhone — 之後到 設定 → 隱私權與安全性，最底下就會看到 Developer Mode 選項。
    </p>
    {error && <div style={errBoxStyle}>{error}</div>}
    {info && <div style={infoBoxStyle}>{info}</div>}
    <div style={btnRow}>
      <button style={ghostBtn} onClick={onSkip}>跳過（toggle 已經出現了）</button>
      <button style={primaryBtn} disabled={busy || !hasUsb} onClick={onRun}>
        {busy ? '處理中⋯' : '幫我準備'}
      </button>
    </div>
  </div>
)

const DevModeStep: React.FC<{
  path: DevModePath
  onSwitchPath: (p: DevModePath) => void
  busy: boolean
  error: string | null
  info: string | null
  onConfirmManual: () => void
  onAutoEnable: () => void
}> = ({ path, onSwitchPath, busy, error, info, onConfirmManual, onAutoEnable }) => (
  <div>
    <h1 style={h1Style}>開啟 Developer Mode</h1>
    <div style={tabRow}>
      <button
        style={path === 'manual' ? tabActive : tab}
        onClick={() => onSwitchPath('manual')}
      >
        推薦：手動開啟（不用清密碼）
      </button>
      <button
        style={path === 'auto' ? tabActive : tab}
        onClick={() => onSwitchPath('auto')}
      >
        備用：自動開啟（要先清密碼）
      </button>
    </div>

    {path === 'manual' && (
      <>
        <ol style={olStyle}>
          <li>到 iPhone 的 <strong>設定 → 隱私權與安全性</strong></li>
          <li>滑到最底下，找到 <strong>「開發者模式」</strong></li>
          <li>把開關打開</li>
          <li>iPhone 會要求<strong>重新開機</strong>，按「重新啟動」</li>
          <li>重開機後解鎖 → 會跳「Turn On Developer Mode」→ 按「開啟」→ 輸入裝置密碼</li>
          <li>回來這裡按「我已開啟」</li>
        </ol>
        <div style={hintBoxStyle}>
          找不到「開發者模式」這個選項？回上一步點「幫我準備」，或切到「自動開啟」。
        </div>
        <div style={btnRow}>
          <button style={primaryBtn} onClick={onConfirmManual}>我已開啟 →</button>
        </div>
      </>
    )}

    {path === 'auto' && (
      <>
        <ol style={olStyle}>
          <li>到 iPhone 的 <strong>設定 → Face ID 與密碼</strong>，<strong>關閉密碼</strong>（暫時的，等下會設回來）</li>
          <li>回來這裡點下面的按鈕</li>
          <li>iPhone 會跳「Turn On Developer Mode」→ 按「開啟」→ 重新開機</li>
          <li>重開機後可以把密碼設回來</li>
          <li>完成後按「我已重開」</li>
        </ol>
        {error && <div style={errBoxStyle}>{error}</div>}
        {info && <div style={infoBoxStyle}>{info}</div>}
        <div style={btnRow}>
          <button style={ghostBtn} disabled={busy} onClick={onAutoEnable}>
            {busy ? '處理中⋯' : '自動開啟 Developer Mode'}
          </button>
          <button style={primaryBtn} onClick={onConfirmManual}>我已重開 →</button>
        </div>
      </>
    )}
  </div>
)

const DdiStep: React.FC<{
  busy: boolean
  error: string | null
  info: string | null
  onMount: () => void
  onSkip: () => void
}> = ({ busy, error, info, onMount, onSkip }) => (
  <div>
    <h1 style={h1Style}>掛載 Developer Disk Image</h1>
    <p style={pStyle}>
      最後一步：掛載 DDI（讓 app 可以模擬定位）。會從 GitHub 下載約 20MB，第一次需要幾秒。
    </p>
    {error && <div style={errBoxStyle}>{error}</div>}
    {info && <div style={infoBoxStyle}>{info}</div>}
    <div style={btnRow}>
      <button style={ghostBtn} onClick={onSkip}>跳過</button>
      <button style={primaryBtn} disabled={busy} onClick={onMount}>
        {busy ? '掛載中⋯' : '開始掛載'}
      </button>
    </div>
    <div style={hintBoxStyle}>
      失敗的話：確認 Developer Mode 已開啟、確認可以連到 github.com、把 iPhone 拔掉重插一次。
    </div>
  </div>
)

const DoneStep: React.FC<{ onFinish: () => void; onOpenUsage?: () => void }> = ({ onFinish, onOpenUsage }) => (
  <div>
    <h1 style={h1Style}>設定完成 🎉</h1>
    <p style={pStyle}>
      現在可以開始用 ios-locctl 了。常用功能：
    </p>
    <ul style={ulStyle}>
      <li>地圖點擊瞬移</li>
      <li>右鍵選單：瞬移、導航、加書籤</li>
      <li>搖桿即時控制（WASD / 方向鍵）</li>
    </ul>
    <p style={pStyle}>
      之後如果要重新跑這個設定（例如換手機），點狀態列右下角版本號旁邊的「重設設定」。
    </p>
    <div style={btnRow}>
      {onOpenUsage && (
        <button style={ghostBtn} onClick={onOpenUsage}>📖 打開使用說明</button>
      )}
      <button style={primaryBtn} onClick={onFinish}>完成 →</button>
    </div>
  </div>
)

// ── Progress bar ─────────────────────────────────────────────────

const STEP_ORDER: Step[] = ['welcome', 'device', 'trigger', 'devmode', 'ddi', 'done']
const STEP_LABELS: Record<Step, string> = {
  welcome: '歡迎',
  device: '連接裝置',
  trigger: '準備選項',
  devmode: '開發者模式',
  ddi: '掛載 DDI',
  done: '完成',
}

const ProgressBar: React.FC<{ step: Step }> = ({ step }) => {
  const idx = STEP_ORDER.indexOf(step)
  return (
    <div style={progressBarRow}>
      {STEP_ORDER.map((s, i) => (
        <div key={s} style={progressItemStyle(i, idx)}>
          <div style={progressDotStyle(i, idx)}>{i + 1}</div>
          <span style={{ fontSize: 11, opacity: i <= idx ? 1 : 0.4 }}>{STEP_LABELS[s]}</span>
        </div>
      ))}
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 17, 23, 0.92)',
  backdropFilter: 'blur(8px)',
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const cardStyle: React.CSSProperties = {
  background: '#1a1d28',
  border: '1px solid rgba(108, 140, 255, 0.25)',
  borderRadius: 12,
  padding: '32px 40px',
  maxWidth: 640,
  width: '100%',
  color: '#e5e7eb',
  boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
}

const h1Style: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  margin: '0 0 16px',
  color: '#fff',
}

const pStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  margin: '0 0 14px',
  color: '#c7cbd9',
}

const ulStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  paddingLeft: 20,
  marginBottom: 20,
  color: '#c7cbd9',
}

const olStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  paddingLeft: 20,
  marginBottom: 16,
  color: '#c7cbd9',
}

const btnRow: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 20,
}

const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  background: '#6c8cff',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}

const ghostBtn: React.CSSProperties = {
  padding: '10px 20px',
  background: 'transparent',
  color: '#c7cbd9',
  border: '1px solid rgba(108, 140, 255, 0.3)',
  borderRadius: 6,
  fontSize: 14,
  cursor: 'pointer',
}

const tabRow: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  marginBottom: 16,
  borderBottom: '1px solid rgba(108, 140, 255, 0.2)',
}

const tab: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  color: '#888',
  border: 'none',
  borderBottom: '2px solid transparent',
  fontSize: 13,
  cursor: 'pointer',
}

const tabActive: React.CSSProperties = {
  ...tab,
  color: '#6c8cff',
  borderBottomColor: '#6c8cff',
  fontWeight: 600,
}

const statusBoxStyle: React.CSSProperties = {
  padding: 14,
  background: 'rgba(108, 140, 255, 0.08)',
  border: '1px solid rgba(108, 140, 255, 0.25)',
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 8,
}

const errBoxStyle: React.CSSProperties = {
  padding: 12,
  background: 'rgba(244, 67, 54, 0.12)',
  border: '1px solid rgba(244, 67, 54, 0.4)',
  borderRadius: 6,
  fontSize: 13,
  color: '#ff7066',
  marginBottom: 12,
  whiteSpace: 'pre-wrap',
}

const infoBoxStyle: React.CSSProperties = {
  padding: 12,
  background: 'rgba(76, 175, 80, 0.12)',
  border: '1px solid rgba(76, 175, 80, 0.4)',
  borderRadius: 6,
  fontSize: 13,
  color: '#7dd87d',
  marginBottom: 12,
  whiteSpace: 'pre-wrap',
}

const hintBoxStyle: React.CSSProperties = {
  padding: 10,
  background: 'rgba(255, 193, 7, 0.08)',
  border: '1px solid rgba(255, 193, 7, 0.25)',
  borderRadius: 6,
  fontSize: 12,
  color: '#ffc107',
  marginTop: 8,
}

const progressBarRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginBottom: 28,
  position: 'relative',
}

const progressItemStyle = (i: number, currentIdx: number): React.CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  flex: 1,
  opacity: i <= currentIdx ? 1 : 0.5,
})

const progressDotStyle = (i: number, currentIdx: number): React.CSSProperties => {
  const done = i < currentIdx
  const active = i === currentIdx
  return {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: done ? '#4caf50' : active ? '#6c8cff' : '#2a2f3d',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 600,
  }
}

export default SetupWizard
