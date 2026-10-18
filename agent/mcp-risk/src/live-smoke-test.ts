import { HsyWaterClient } from "./hsy-water.js";

const longitude = Number(process.argv[2] ?? 24.94287769);
const latitude = Number(process.argv[3] ?? 60.19966947);

const result = await new HsyWaterClient().checkPoint(longitude, latitude);
console.log(
  JSON.stringify(
    {
      checkedAt: result.checkedAt,
      coordinatesWgs84: result.coordinatesWgs84,
      status: result.status,
      activeDisruption: result.activeDisruption,
      currentEvents: result.currentEvents,
      upcomingEvents: result.upcomingEvents,
      expiredEventsExcluded: result.expiredEventsExcluded,
      successfulLayerCount: result.successfulLayerCount,
      failures: result.failures,
    },
    null,
    2
  )
);
