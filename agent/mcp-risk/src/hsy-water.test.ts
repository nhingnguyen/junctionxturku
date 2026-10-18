import assert from "node:assert/strict";
import test from "node:test";
import { HsyWaterClient } from "./hsy-water.js";

function response(features: Array<{ attributes: Record<string, unknown> }>) {
  return new Response(JSON.stringify({ features }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("queries every HSY layer at the parcel point and filters event time windows", async () => {
  const requestedUrls: URL[] = [];
  const now = new Date("2026-10-18T12:00:00.000Z");
  const mockFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    if (url.pathname.includes("/21/query")) {
      return response([
        {
          attributes: {
            GlobalID: "active",
            nimi: "00520 Pasila",
            alkuaika: Date.parse("2026-10-18T11:00:00.000Z"),
            loppuaika: Date.parse("2026-10-18T13:00:00.000Z"),
          },
        },
        {
          attributes: {
            GlobalID: "expired",
            alkuaika: Date.parse("2026-10-17T10:00:00.000Z"),
            loppuaika: Date.parse("2026-10-17T11:00:00.000Z"),
          },
        },
        {
          attributes: {
            GlobalID: "future",
            alkuaika: Date.parse("2026-10-19T10:00:00.000Z"),
            loppuaika: Date.parse("2026-10-19T11:00:00.000Z"),
          },
        },
      ]);
    }
    return response([]);
  };

  const client = new HsyWaterClient("https://example.test/MapServer", mockFetch);
  const result = await client.checkPoint(24.94287769, 60.19966947, now);

  assert.equal(requestedUrls.length, 6);
  assert.ok(
    requestedUrls.every(
      (url) =>
        url.searchParams.get("geometry") === "24.94287769,60.19966947" &&
        url.searchParams.get("inSR") === "4326" &&
        url.searchParams.get("spatialRel") === "esriSpatialRelIntersects"
    )
  );
  assert.equal(result.activeDisruption, true);
  assert.equal(result.currentEvents.length, 1);
  assert.equal(result.currentEvents[0].globalId, "active");
  assert.equal(result.upcomingEvents.length, 1);
  assert.equal(result.expiredEventsExcluded, 1);
  assert.equal(result.successfulLayerCount, 6);
});

test("returns unknown instead of false when one HSY layer fails", async () => {
  let failedLayerAttempts = 0;
  const mockFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/19/query")) {
      failedLayerAttempts += 1;
      return new Response("temporary failure", { status: 503 });
    }
    return response([]);
  };

  const client = new HsyWaterClient("https://example.test/MapServer", mockFetch);
  const result = await client.checkPoint(
    24.94287769,
    60.19966947,
    new Date("2026-10-18T12:00:00.000Z")
  );

  assert.equal(result.status, "UNKNOWN_PARTIAL_QUERY_FAILURE");
  assert.equal(result.activeDisruption, null);
  assert.equal(result.successfulLayerCount, 5);
  assert.equal(result.failures.length, 1);
  assert.equal(failedLayerAttempts, 2);
});
