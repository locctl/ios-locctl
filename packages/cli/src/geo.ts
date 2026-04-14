export interface Coord {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

/** Calculate distance between two coordinates in km (Haversine formula) */
export function haversine(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Linear interpolation between two coordinates */
export function lerp(a: Coord, b: Coord, t: number): Coord {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

/** Get recommended cooldown time based on distance */
export function getCooldown(distKm: number): { text: string; minutes: number } {
  if (distKm <= 1) return { text: "1 分鐘", minutes: 1 };
  if (distKm <= 5) return { text: "2 分鐘", minutes: 2 };
  if (distKm <= 10) return { text: "6 分鐘", minutes: 6 };
  if (distKm <= 25) return { text: "11 分鐘", minutes: 11 };
  if (distKm <= 50) return { text: "22 分鐘", minutes: 22 };
  if (distKm <= 100) return { text: "35 分鐘", minutes: 35 };
  if (distKm <= 250) return { text: "53 分鐘", minutes: 53 };
  if (distKm <= 500) return { text: "1 小時", minutes: 60 };
  if (distKm <= 750) return { text: "1 小時 18 分鐘", minutes: 78 };
  if (distKm <= 1000) return { text: "1.5 小時", minutes: 90 };
  return { text: "2 小時", minutes: 120 };
}
