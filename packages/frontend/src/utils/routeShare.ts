// One-line shareable route encoding so users can swap routes via chat apps
// without dealing with .gpx files. Format:
//
//   ios-locctl-route:<base64(JSON)>
//
// where JSON is `{ name, waypoints: [{lat,lng}, ...] }`. The magic prefix
// rejects accidentally-pasted text (URLs, regular GPX, etc.) before we try
// to parse it.

const PREFIX = 'ios-locctl-route:'

export interface SharedRoute {
  name: string
  waypoints: { lat: number; lng: number }[]
}

// btoa/atob choke on multi-byte chars, so we round-trip through TextEncoder
// to keep Chinese / Japanese / emoji route names intact.
function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function fromBase64Utf8(s: string): string {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeRoute(route: SharedRoute): string {
  const minimal = {
    name: route.name,
    waypoints: route.waypoints.map((w) => ({
      lat: Number(w.lat),
      lng: Number(w.lng),
    })),
  }
  return PREFIX + toBase64Utf8(JSON.stringify(minimal))
}

export function decodeRoute(input: string): SharedRoute {
  const trimmed = (input || '').trim()
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error(`格式錯誤:share 碼必須以 "${PREFIX}" 開頭`)
  }
  const b64 = trimmed.slice(PREFIX.length).trim()
  let obj: any
  try {
    obj = JSON.parse(fromBase64Utf8(b64))
  } catch (e: any) {
    throw new Error(`解碼失敗:${e?.message || 'invalid base64/JSON'}`)
  }
  if (!obj || typeof obj.name !== 'string' || !Array.isArray(obj.waypoints)) {
    throw new Error('格式錯誤:缺少 name 或 waypoints 欄位')
  }
  const waypoints = obj.waypoints.map((w: any, i: number) => {
    const lat = Number(w?.lat)
    const lng = Number(w?.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error(`第 ${i + 1} 個 waypoint 座標不合法`)
    }
    return { lat, lng }
  })
  if (waypoints.length === 0) {
    throw new Error('路線沒有任何 waypoint')
  }
  return { name: obj.name, waypoints }
}
