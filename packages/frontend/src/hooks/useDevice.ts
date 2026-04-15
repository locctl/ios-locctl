import { useState, useCallback, useEffect } from 'react'
import {
  listDevices, connectDevice, disconnectDevice,
} from '../services/api'
import type { WsMessage } from './useWebSocket'

export interface DeviceInfo {
  udid: string
  name: string
  ios_version: string
  connection_type: string
  is_connected: boolean
  wifi_ip?: string
}

export function useDevice(wsMessage?: WsMessage | null) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connectedDevice, setConnectedDevice] = useState<DeviceInfo | null>(null)

  // React to real-time device state broadcasts
  useEffect(() => {
    if (!wsMessage) return
    if (wsMessage.type === 'device_disconnected') {
      setConnectedDevice(null)
      setDevices((prev) => prev.map((d) => ({ ...d, is_connected: false })))
    } else if (wsMessage.type === 'device_reconnected') {
      listDevices().then((list) => {
        setDevices(list)
        const udid = wsMessage.data?.udid
        const match = udid ? list.find((d) => d.udid === udid) : null
        setConnectedDevice(match ?? list.find((d) => d.is_connected) ?? null)
      }).catch(() => {})
    }
  }, [wsMessage])

  const [scanning, setScanning] = useState(false)

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const result = await listDevices()
      const list: DeviceInfo[] = Array.isArray(result) ? result : []
      setDevices(list)
      const active = list.find((d) => d.is_connected) ?? null
      if (active) {
        setConnectedDevice(active)
      } else if (list.length === 1) {
        // Auto-connect when exactly one device is found
        const dev = list[0]
        try {
          await connectDevice(dev.udid, dev.wifi_ip)
          const refreshed = await listDevices()
          const rList: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
          setDevices(rList)
          setConnectedDevice(rList.find((d) => d.udid === dev.udid) ?? dev)
        } catch {
          setConnectedDevice(null)
        }
      } else {
        setConnectedDevice(null)
      }
      return list
    } catch (err) {
      console.error('Failed to scan devices:', err)
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const connect = useCallback(
    async (udid: string, wifiIp?: string) => {
      try {
        await connectDevice(udid, wifiIp)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        const active = list.find((d) => d.udid === udid) ?? null
        setConnectedDevice(active)
        return active
      } catch (err) {
        console.error('Failed to connect device:', err)
        throw err
      }
    },
    [],
  )

  const disconnect = useCallback(
    async (udid: string) => {
      try {
        await disconnectDevice(udid)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        setConnectedDevice(null)
      } catch (err) {
        console.error('Failed to disconnect device:', err)
        throw err
      }
    },
    [],
  )

  return {
    devices, connectedDevice, scanning, scan, connect, disconnect,
  }
}
