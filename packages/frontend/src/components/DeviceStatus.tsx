import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { wifiRepair, connectDevice } from '../services/api';
import { useT } from '../i18n';

interface Device {
  id: string;
  name: string;
  iosVersion: string;
  connectionType?: string;
  wifiIp?: string;
}

interface DeviceStatusProps {
  device: Device | null;
  devices: Device[];
  isConnected: boolean;
  onScan: () => void | Promise<void>;
  onSelect: (id: string) => void | Promise<void>;
}

const DeviceStatus: React.FC<DeviceStatusProps> = ({
  device,
  devices,
  isConnected,
  onScan,
  onSelect,
}) => {
  const t = useT();
  const [showDropdown, setShowDropdown] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<number | null>(null);
  const scanResultTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const devicesRef = React.useRef(devices);
  devicesRef.current = devices;
  const [connectingDeviceId, setConnectingDeviceId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Manual add device
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualIp, setManualIp] = useState('');
  const [manualConnecting, setManualConnecting] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // Repair pairing
  const [showRepairConfirm, setShowRepairConfirm] = useState(false);
  const [repairState, setRepairState] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [repairMessage, setRepairMessage] = useState('');

  const handleScan = async () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
    setScanning(true);
    setScanResult(null);
    try {
      await Promise.resolve(onScan());
    } finally {
      setScanning(false);
      setScanResult(devicesRef.current.length);
      scanResultTimer.current = setTimeout(() => setScanResult(null), 2000);
    }
  };

  React.useEffect(() => () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
  }, []);

  const handleRepair = async () => {
    setRepairState('running');
    setRepairMessage('');
    try {
      const res = await wifiRepair();
      setRepairState('success');
      setRepairMessage(`${res.name || 'Device'} (iOS ${res.ios_version})`);
    } catch (err: any) {
      setRepairState('failed');
      setRepairMessage(err?.message || 'Unknown error');
    }
  };

  const handleSelectDevice = async (id: string, unsupported: boolean) => {
    if (unsupported) return;
    setConnectError(null);
    setConnectingDeviceId(id);
    try {
      await Promise.resolve(onSelect(id));
      setShowDropdown(false);
    } catch (err: any) {
      setConnectError(err?.message || 'Connection failed');
    } finally {
      setConnectingDeviceId(null);
    }
  };

  const handleManualConnect = async () => {
    if (!manualIp.trim()) return;
    setManualConnecting(true);
    setManualError(null);
    try {
      // Use first known UDID from paired records, or 'auto'
      const udid = devices.length > 0 ? devices[0].id : 'auto';
      await connectDevice(udid, manualIp.trim());
      setShowManualAdd(false);
      setManualIp('');
      // Refresh device list
      await Promise.resolve(onScan());
    } catch (err: any) {
      setManualError(err?.message || 'Connection failed');
    } finally {
      setManualConnecting(false);
    }
  };

  // Connection type badge
  const ConnectionBadge = ({ type }: { type: string }) => {
    const isWifi = type === 'Network' || type === 'WiFi';
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '1px 5px', borderRadius: 3, fontSize: 10,
        background: isWifi ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
        color: isWifi ? '#4caf50' : '#6c8cff',
      }}>
        {isWifi ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M5 12.55a11 11 0 0114 0" />
            <path d="M8.53 16.11a6 6 0 016.95 0" />
            <circle cx="12" cy="20" r="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="9" y="2" width="6" height="20" rx="1" />
            <line x1="9" y1="18" x2="15" y2="18" />
          </svg>
        )}
        {isWifi ? 'WiFi' : 'USB'}
      </span>
    );
  };

  return (
    <div className={`device-status ${isConnected ? 'device-connected' : 'device-disconnected'}`}>
      {/* Header: status dot + device name + scan button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: isConnected ? '#4caf50' : '#f44336',
          boxShadow: isConnected ? '0 0 6px #4caf50' : '0 0 6px #f44336',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {device ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {device.name}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 4 }}>
                iOS {device.iosVersion}
                {device.connectionType && <ConnectionBadge type={device.connectionType} />}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.6 }}>No device</div>
          )}
        </div>
        <button
          className="action-btn"
          onClick={handleScan}
          disabled={scanning}
          style={{ padding: '4px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 70, justifyContent: 'center' }}
          title={t('device.scan_tooltip')}
        >
          {scanning ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
              </svg>
              {t('device.scan_scanning')}
            </>
          ) : scanResult != null && scanResult > 0 ? (
            <span style={{ color: '#4caf50' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3" style={{ marginRight: 2 }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {t('device.scan_found')}
            </span>
          ) : scanResult === 0 ? (
            <span style={{ color: '#f44336' }}>{t('device.scan_none')}</span>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12a7 7 0 0114 0" />
                <path d="M8.5 8.5a4 4 0 017 0" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
              </svg>
              {t('device.scan_scanning') === '掃描中...' ? '掃描' : 'Scan'}
            </>
          )}
        </button>
      </div>

      {/* Device dropdown list */}
      {devices.length >= 1 && (
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <button
            className="action-btn"
            onClick={() => setShowDropdown(!showDropdown)}
            style={{ width: '100%', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18" />
              </svg>
              {devices.length} devices found
            </span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: showDropdown ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>

          {showDropdown && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0,
              background: '#2a2a2e', border: '1px solid #444', borderRadius: 4,
              marginTop: 4, zIndex: 100, boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
            }}>
              {devices.map((d) => {
                const major = parseInt((d.iosVersion || '0').split('.')[0], 10) || 0;
                const unsupported = major > 0 && major < 17;
                return (
                  <div key={d.id}
                    onClick={() => { void handleSelectDevice(d.id, unsupported); }}
                    style={{
                      padding: '8px 12px', cursor: unsupported ? 'not-allowed' : 'pointer',
                      fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
                      borderBottom: '1px solid #333',
                      background: device?.id === d.id ? '#3a3a4e' : 'transparent',
                      opacity: unsupported ? 0.55 : 1,
                    }}
                    onMouseEnter={(e) => { if (!unsupported) (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e'; }}
                    onMouseLeave={(e) => { if (!unsupported) (e.currentTarget as HTMLDivElement).style.background = device?.id === d.id ? '#3a3a4e' : 'transparent'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={unsupported ? '#f44336' : 'currentColor'} strokeWidth="2">
                      <rect x="5" y="2" width="14" height="20" rx="2" />
                      <line x1="12" y1="18" x2="12" y2="18" />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: device?.id === d.id ? 600 : 400 }}>{d.name}</div>
                      <div style={{ opacity: 0.5, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {unsupported
                          ? <span style={{ color: '#f44336' }}>iOS {d.iosVersion} (unsupported)</span>
                          : <>iOS {d.iosVersion}</>}
                        {d.connectionType && !unsupported && <ConnectionBadge type={d.connectionType} />}
                        {d.wifiIp && <span style={{ opacity: 0.5 }}>{d.wifiIp}</span>}
                      </div>
                    </div>
                    {connectingDeviceId === d.id && (
                      <span style={{ fontSize: 10, opacity: 0.7 }}>Connecting...</span>
                    )}
                    {device?.id === d.id && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3">
                        <polyline points="20,6 9,17 4,12" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {connectError && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#f44336' }}>
          {connectError}
        </div>
      )}

      {/* Action buttons: Manual Add + Repair */}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          className="action-btn"
          onClick={() => { setShowManualAdd(true); setManualError(null); }}
          style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
        >
          + {t('device.scan_scanning') === '掃描中...' ? '手動新增' : 'Manual'}
        </button>
        <button
          className="action-btn"
          onClick={() => { setRepairState('idle'); setRepairMessage(''); setShowRepairConfirm(true); }}
          style={{ flex: 1, fontSize: 11, padding: '4px 8px', color: '#ffc107' }}
        >
          ↻ {t('device.scan_scanning') === '掃描中...' ? '修復配對' : 'Repair'}
        </button>
      </div>

      {/* Manual Add Modal */}
      {showManualAdd && createPortal(
        <div
          onClick={() => !manualConnecting && setShowManualAdd(false)}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 400, width: '100%', color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
            }}
          >
            <strong style={{ fontSize: 15, marginBottom: 16, display: 'block' }}>
              {t('device.scan_scanning') === '掃描中...' ? '手動新增裝置' : 'Manual Device'}
            </strong>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
              {t('device.scan_scanning') === '掃描中...'
                ? '輸入裝置的 WiFi IP（設定 → WiFi → (i) → IP 位址）'
                : 'Enter device WiFi IP (Settings → WiFi → (i) → IP Address)'}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10 }}>
              <span style={{ opacity: 0.7, width: 30 }}>IP</span>
              <input type="text" className="search-input" placeholder="192.168.0.197"
                value={manualIp} onChange={(e) => setManualIp(e.target.value)}
                style={{ flex: 1, fontSize: 12 }} disabled={manualConnecting}
                onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
              />
            </label>
            {manualError && (
              <div style={{ fontSize: 11, color: '#f44336', marginBottom: 8, padding: '4px 6px', background: 'rgba(244,67,54,0.1)', borderRadius: 3 }}>
                {manualError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setShowManualAdd(false)} disabled={manualConnecting}
                style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}>
                {t('device.scan_scanning') === '掃描中...' ? '取消' : 'Cancel'}
              </button>
              <button onClick={handleManualConnect} disabled={manualConnecting || !manualIp.trim()}
                style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                {manualConnecting ? '...' : (t('device.scan_scanning') === '掃描中...' ? '連接' : 'Connect')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Repair Pairing Modal */}
      {showRepairConfirm && createPortal(
        <div
          onClick={() => { if (repairState !== 'running') setShowRepairConfirm(false); }}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 460, width: '100%', color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(108, 140, 255, 0.15)', color: '#6c8cff',
                fontSize: 18, fontWeight: 700, border: '1px solid rgba(108,140,255,0.5)',
              }}>↻</span>
              <strong style={{ fontSize: 15 }}>{t('wifi.repair_confirm_title')}</strong>
            </div>

            {repairState === 'idle' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
                  {t('wifi.repair_confirm_body')}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}>
                    {t('wifi.repair_cancel')}
                  </button>
                  <button onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                    {t('wifi.repair_ok')}
                  </button>
                </div>
              </>
            )}

            {repairState === 'running' && (
              <div style={{ fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
                <div style={{
                  width: 32, height: 32, margin: '0 auto 12px',
                  border: '3px solid rgba(108,140,255,0.25)',
                  borderTopColor: '#6c8cff', borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <div style={{ color: '#ffc107' }}>{t('wifi.repair_running')}</div>
              </div>
            )}

            {repairState === 'success' && (
              <>
                <div style={{ fontSize: 13, color: '#4caf50' }}>{t('wifi.repair_success')}</div>
                {repairMessage && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{repairMessage}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                  <button onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                    OK
                  </button>
                </div>
              </>
            )}

            {repairState === 'failed' && (
              <>
                <div style={{ fontSize: 13, color: '#ff6b6b' }}>{t('wifi.repair_failed')}</div>
                {repairMessage && (
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8, padding: 8,
                    background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.3)',
                    borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{repairMessage}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}>
                    {t('wifi.repair_cancel')}
                  </button>
                  <button onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                    {t('wifi.repair_ok')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default DeviceStatus;
