export const DEFAULT_HSY_WATER_MAPSERVER_URL =
  "https://arcgis.hsy.fi/arcgis/rest/services/H%C3%A4iri%C3%B6viestint%C3%A4kartta_MIL1/MapServer";

export const HSY_WATER_INFO_URL =
  "https://www.hsy.fi/vesi-ja-viemarit/vesikatkot-ja-hairiot/";

const LAYERS = [
  { id: 17, type: "usage_ban", sourceName: "Käyttökielto" },
  { id: 18, type: "boil_advisory_and_restriction", sourceName: "Keittokehote - käytönrajoitus" },
  { id: 19, type: "usage_restriction", sourceName: "Vedenkäytönrajoitus" },
  { id: 20, type: "boil_water_advisory", sourceName: "Keittokehotus" },
  { id: 21, type: "water_outage", sourceName: "Vesikatko" },
  { id: 22, type: "water_disruption", sourceName: "Häiriö" },
] as const;

interface ArcGisFeature {
  attributes?: Record<string, unknown>;
}

interface ArcGisResponse {
  features?: ArcGisFeature[];
  error?: { message?: string; details?: string[] };
}

type FetchLike = typeof fetch;

export interface WaterEvent {
  layerId: number;
  type: string;
  sourceType: string;
  globalId: string | null;
  name: string | null;
  startsAt: string | null;
  endsAt: string | null;
  lastModifiedAt: string | null;
  incidentId: number | null;
  affectedResidents: number | null;
  note: string | null;
}

function dateIso(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function normalizeEvent(
  layer: (typeof LAYERS)[number],
  feature: ArcGisFeature
): WaterEvent {
  const attributes = feature.attributes ?? {};
  return {
    layerId: layer.id,
    type: layer.type,
    sourceType: layer.sourceName,
    globalId: optionalString(attributes.GlobalID),
    name: optionalString(attributes.nimi),
    startsAt: dateIso(attributes.alkuaika),
    endsAt: dateIso(attributes.loppuaika),
    lastModifiedAt: dateIso(attributes.muokattu),
    incidentId: optionalNumber(attributes.vikapaivakirjaid),
    affectedResidents: optionalNumber(attributes.asukkaat),
    note: optionalString(attributes.huomautus),
  };
}

function eventState(event: WaterEvent, nowMs: number): "current" | "upcoming" | "expired" {
  const startsMs = event.startsAt ? Date.parse(event.startsAt) : null;
  const endsMs = event.endsAt ? Date.parse(event.endsAt) : null;
  if (startsMs !== null && startsMs > nowMs) return "upcoming";
  if (endsMs !== null && endsMs < nowMs) return "expired";
  return "current";
}

export class HsyWaterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    baseUrl = process.env.HSY_WATER_MAPSERVER_URL?.trim() ||
      DEFAULT_HSY_WATER_MAPSERVER_URL,
    fetchImpl: FetchLike = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = fetchImpl;
  }

  private async queryLayerOnce(
    layer: (typeof LAYERS)[number],
    longitude: number,
    latitude: number
  ): Promise<WaterEvent[]> {
    const url = new URL(`${this.baseUrl}/${layer.id}/query`);
    url.search = new URLSearchParams({
      where: "1=1",
      geometry: `${longitude},${latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields:
        "GlobalID,tyyppi,alkuaika,loppuaika,nimi,vikapaivakirjaid,asukkaat,huomautus,muokattu",
      returnGeometry: "false",
      f: "json",
    }).toString();

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error(`HSY layer ${layer.id} returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as ArcGisResponse;
    if (body.error) {
      throw new Error(
        `HSY layer ${layer.id} query failed: ${body.error.message ?? "unknown ArcGIS error"}`
      );
    }
    return (body.features ?? []).map((feature) => normalizeEvent(layer, feature));
  }

  private async queryLayer(
    layer: (typeof LAYERS)[number],
    longitude: number,
    latitude: number
  ): Promise<WaterEvent[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.queryLayerOnce(layer, longitude, latitude);
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    }
    throw lastError;
  }

  async checkPoint(
    longitude: number,
    latitude: number,
    now = new Date()
  ) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error("A valid WGS84 longitude and latitude are required.");
    }
    const checkedAt = now.toISOString();
    const settled = await Promise.allSettled(
      LAYERS.map((layer) => this.queryLayer(layer, longitude, latitude))
    );
    const successfulLayerCount = settled.filter(
      (item) => item.status === "fulfilled"
    ).length;
    const failures = settled.flatMap((item, index) =>
      item.status === "rejected"
        ? [{ layerId: LAYERS[index].id, error: String(item.reason) }]
        : []
    );
    if (successfulLayerCount === 0) {
      throw new Error(`All HSY water-layer queries failed: ${JSON.stringify(failures)}`);
    }

    const events = settled.flatMap((item) =>
      item.status === "fulfilled" ? item.value : []
    );
    const currentEvents = events.filter(
      (event) => eventState(event, now.getTime()) === "current"
    );
    const upcomingEvents = events.filter(
      (event) => eventState(event, now.getTime()) === "upcoming"
    );
    const expiredEventsExcluded = events.filter(
      (event) => eventState(event, now.getTime()) === "expired"
    ).length;
    const completeCoverage = successfulLayerCount === LAYERS.length;
    const activeDisruption =
      currentEvents.length > 0 ? true : completeCoverage ? false : null;

    return {
      source: "HSY water-disruption ArcGIS MapServer",
      sourceUrl: this.baseUrl,
      officialInformationUrl: HSY_WATER_INFO_URL,
      checkedAt,
      coordinatesWgs84: [longitude, latitude] as [number, number],
      spatialMethod: "point-in-polygon at the parcel representative coordinate",
      status:
        currentEvents.length > 0
          ? "ACTIVE_EVENT_FOUND"
          : completeCoverage
            ? "NO_MAPPED_EVENT_AT_POINT"
            : "UNKNOWN_PARTIAL_QUERY_FAILURE",
      activeDisruption,
      currentEvents,
      upcomingEvents,
      expiredEventsExcluded,
      queriedLayers: LAYERS.length,
      successfulLayerCount,
      failures,
      caveat: completeCoverage
        ? "No matching polygon means HSY has no mapped event at this representative point at check time; it does not rule out an internal building plumbing issue."
        : "One or more HSY layers failed, so absence of a returned event is not evidence that no mapped disruption exists. Retry the live check.",
    };
  }
}
