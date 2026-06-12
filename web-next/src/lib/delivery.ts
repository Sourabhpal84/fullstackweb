"use client";

import { callFunction } from "@/lib/functions";
import type { GeoPointLike } from "@/types/domain";

export const DEFAULT_MAX_DISTANCE_KM = 6;

export function haversineKm(a?: GeoPointLike, b?: GeoPointLike) {
  if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return 0;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 6371;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Number((2 * radius * Math.asin(Math.sqrt(h))).toFixed(2));
}

export async function getBrowserLocation(): Promise<GeoPointLike> {
  if (!navigator.geolocation) throw new Error("Location is not supported on this device");
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Number(pos.coords.latitude),
        lng: Number(pos.coords.longitude),
        accuracy: Number(pos.coords.accuracy || 0),
        updatedAt: new Date().toISOString()
      }),
      () => reject(new Error("Please allow location to check delivery availability")),
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 12000 }
    );
  });
}

export async function calculateRouteDistance(origin: GeoPointLike, destination: GeoPointLike) {
  try {
    const route = await callFunction<{ ok: boolean; distanceKm?: number; durationText?: string }>("calculateRouteDistance", {
      origin,
      destination
    }, 15000);
    return {
      distanceKm: Number(route.distanceKm || 0),
      durationText: route.durationText || "",
      source: "google_routes_backend"
    };
  } catch {
    return {
      distanceKm: haversineKm(origin, destination),
      durationText: "",
      source: "haversine_fallback"
    };
  }
}

export function deliveryChargeFor(distanceKm: number, subtotal: number) {
  if (!distanceKm) return 0;
  if (subtotal >= (distanceKm <= 3 ? 149 : 199)) return 0;
  if (distanceKm <= 3) return 20;
  return 30 + Math.max(0, Math.ceil(distanceKm - 3)) * 7;
}
