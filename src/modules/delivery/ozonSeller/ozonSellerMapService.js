import { getOzonSellerAccessToken } from "./ozonSellerOAuthService.js";
import { getOzonDeliveryPointInfo, calculateDistanceMeters as distanceMeters } from "../ozon/ozonDeliveryService.js";

const SELLER_API_URL = "https://api-seller.ozon.ru";
const REQUEST_TIMEOUT_MS = 5000;
const LOOKUP_TIMEOUT_MS = 15000;
const MAX_MAP_REQUESTS = 8;
const MAX_POINT_IDS = 1000;

function lookupError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

function viewportAround(latitude, longitude, radiusMeters) {
  const latDelta = radiusMeters / 6371000 * 180 / Math.PI;
  const lonDelta = Math.abs(latitude) + latDelta >= 90 ? 180 :
    Math.asin(Math.min(1, Math.sin(radiusMeters / 6371000) /
      Math.cos(latitude * Math.PI / 180))) * 180 / Math.PI;
  // Split at the antimeridian instead of searching almost the whole world.
  const left = longitude - lonDelta;
  const right = longitude + lonDelta;
  const viewport = (low, high) => ({
    left_bottom: { lat: Math.max(-90, latitude - latDelta), long: low },
    right_top: { lat: Math.min(90, latitude + latDelta), long: high },
  });
  if (left < -180) return [viewport(-180, right), viewport(left + 360, 180)];
  if (right > 180) return [viewport(left, 180), viewport(-180, right - 360)];
  return [viewport(left, right)];
}

function validViewport(viewport) {
  return validCoordinates(viewport?.left_bottom?.lat, viewport?.left_bottom?.long) &&
    validCoordinates(viewport?.right_top?.lat, viewport?.right_top?.long) &&
    viewport.left_bottom.lat <= viewport.right_top.lat &&
    viewport.left_bottom.long <= viewport.right_top.long;
}

function overlaps(a, b) {
  return a.left_bottom.lat <= b.right_top.lat && a.right_top.lat >= b.left_bottom.lat &&
    a.left_bottom.long <= b.right_top.long && a.right_top.long >= b.left_bottom.long;
}

async function sellerRequest(path, body, token, signal) {
  const response = await fetch(`${SELLER_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw lookupError(`Ozon Seller lookup failed (HTTP ${response.status})`,
      response.status === 429 ? 503 : 502);
  }
  try {
    return await response.json();
  } catch {
    throw lookupError("Invalid Ozon Seller JSON response");
  }
}

function pointId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function normalizedAddress(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
}

// Proximity is a candidate match only. The returned real address must be
// reviewed by the customer; this does not verify an order's deliverability.
export async function findOzonSellerDeliveryPointAtLocation(
  latitude,
  longitude,
  { radiusMeters = Number(process.env.OZON_SELLER_PVZ_MATCH_RADIUS_METERS || 150) } = {}
) {
  if (!validCoordinates(latitude, longitude)) {
    throw lookupError("Invalid pickup point coordinates", 400);
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 1000) {
    throw lookupError("Invalid Ozon Seller PVZ match radius", 500);
  }

  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  try {
    const token = await getOzonSellerAccessToken({ signal });
    const viewports = viewportAround(latitude, longitude, radiusMeters);
    const queue = viewports.map((viewport) => ({ viewport, zoom: 19 }));
    const seen = new Set();
    const ids = new Set();
    let requests = 0;
    while (queue.length) {
      const request = queue.shift();
      const key = JSON.stringify(request);
      if (seen.has(key)) throw lookupError("Ozon map cluster could not be resolved");
      seen.add(key);
      if (++requests > MAX_MAP_REQUESTS) throw lookupError("Ozon map search limit exceeded");
      const data = await sellerRequest("/v1/delivery/map", request, token, signal);
      if (!Array.isArray(data?.clusters)) throw lookupError("Invalid Ozon map response");
      for (const cluster of data.clusters) {
        if (!cluster || !Array.isArray(cluster.map_point_ids) ||
          !Number.isInteger(cluster.points_count) || cluster.points_count < 0) {
          throw lookupError("Invalid Ozon map cluster");
        }
        for (const value of cluster.map_point_ids) {
          const id = pointId(value);
          if (id === null) throw lookupError("Invalid Ozon map point ID");
          ids.add(id);
        }
        if (ids.size > MAX_POINT_IDS) throw lookupError("Ozon map point limit exceeded");
        // Explicit IDs resolve same-building clusters without another map call.
        if (cluster.points_count > new Set(cluster.map_point_ids.map(String)).size) {
          if (!validViewport(cluster.viewport)) throw lookupError("Invalid Ozon cluster viewport");
          if (!viewports.some((viewport) => overlaps(viewport, cluster.viewport))) continue;
          if (request.zoom >= 21) throw lookupError("Ozon map cluster remains unresolved");
          queue.push({ viewport: cluster.viewport, zoom: request.zoom + 1 });
        }
      }
    }

    const candidates = [];
    const idList = [...ids];
    for (let index = 0; index < idList.length; index += 100) {
      const batch = idList.slice(index, index + 100);
      const data = await sellerRequest("/v1/delivery/point/info",
        { map_point_ids: batch.map(String) }, token, signal);
      if (!Array.isArray(data?.points)) throw lookupError("Invalid Ozon Seller point info response");
      for (const point of data.points) {
        if (typeof point?.enabled !== "boolean" || !point.delivery_method) {
          throw lookupError("Invalid Ozon Seller point details");
        }
        const details = point.delivery_method;
        const id = pointId(details.map_point_id);
        if (!batch.includes(id)) throw lookupError("Unexpected Ozon Seller point ID");
        if (!point.enabled) continue;
        const { lat, long } = details.coordinates || {};
        if (!validCoordinates(lat, long)) throw lookupError("Invalid Ozon Seller point coordinates");
        const distance = distanceMeters(latitude, longitude, lat, long);
        if (distance <= radiusMeters) candidates.push({ id, details, distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.id - b.id);

    let nearest = null;
    let nearestDistance = Infinity;
    for (let index = 0; index < candidates.length; index += 100) {
      const batch = candidates.slice(index, index + 100);
      const businessPoints = await getOzonDeliveryPointInfo(batch.map(({ id }) => id), { signal, strictResponse: true });
      for (const candidate of batch) {
        const business = businessPoints.find((point) => pointId(point.delivery_point_id) === candidate.id);
        if (!business || business.is_active !== true || business.type !== "pvz") continue;
        const { latitude: lat, longitude: lon } = business.coordinates || {};
        const seller = candidate.details;
        if (!validCoordinates(lat, lon) ||
          distanceMeters(lat, lon, seller.coordinates.lat, seller.coordinates.long) > 30 ||
          distanceMeters(latitude, longitude, lat, lon) > radiusMeters) continue;
        const sellerAddress = normalizedAddress(seller.address);
        const businessAddress = normalizedAddress(business.full_address);
        // Fail closed on missing or conflicting physical-address information.
        if (!sellerAddress || !businessAddress || sellerAddress !== businessAddress) continue;
        const distance = distanceMeters(latitude, longitude, lat, lon);
        if (distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearest = {
          deliveryPointId: candidate.id,
          name: typeof business.name === "string" ? business.name : null,
          address: business.full_address,
          type: business.type,
          latitude: lat,
          longitude: lon,
          distanceMeters: Math.round(distance),
          storagePeriodDays: Number.isInteger(business.storage_period_days) ? business.storage_period_days : null,
        };
      }
    }
    return nearest;
  } catch (error) {
    if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw lookupError("Ozon pickup point lookup timed out", 504);
    }
    if (error?.statusCode) throw error;
    // Do not propagate upstream response bodies, credentials, or token errors.
    throw lookupError("Ozon pickup point lookup failed");
  }
}
