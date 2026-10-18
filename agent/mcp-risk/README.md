# Property Risk MCP

This MCP exposes the normalized parcel-risk snapshot without treating stale or
area-level context as a current parcel fact.

## Tools

- `risk_get_property_profile`: resolve by address or Finnish property identifier
  and return selected `static`, `periodic`, or `live` evidence groups.
- `risk_check_live_water_disruptions`: query the six official HSY disruption
  polygon layers at the parcel representative coordinate and filter events by
  their start/end timestamps.

Legacy radon fallback and untimestamped water values are hidden by default.
`includeLegacyEvidence=true` exists only for migration audits.

## Run

```bash
npm install
npm test
npm run build
npm run test:live -- 24.94287769 60.19966947
```

Environment variables:

- `RISK_DATA_PATH`: normalized risk JSON path.
- `HSY_WATER_MAPSERVER_URL`: optional override for the official HSY ArcGIS
  MapServer.
