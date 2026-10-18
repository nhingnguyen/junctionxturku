# Risk data normalization pipeline

This pipeline implements the risk-data hardening steps without
overwriting the original snapshots:

1. Normalize parcel identifiers, postal codes, coordinates and official addresses.
2. Add `scope`, `source`, `as_of`, `method` and `freshness` to every risk factor.
3. Separate factors into `static`, `periodic` and `live` groups.
4. Remove unsupported radon fallback values and stale water flags from usable data.
5. Mark multi-building fire summaries as unresolved for building-specific claims.

## Run

```bash
cd risk-pipeline
npm test
npm run build
```

The build reads `../parcels_with_detailed_risks.json` and
`../bbox_risk_profile.json`, then writes
`../parcels_with_normalized_risks.json` using schema version `2.1.0`.

The original JSON files remain unchanged. The validation step reconstructs each
legacy `risk_profile` from the v2 factor groups and fails if any legacy risk
field or value was lost.

## Cadence groups

- `static`: relatively stable building/property attributes.
- `periodic`: official snapshots that need scheduled refreshes.
- `live`: current-state data that must be fetched and timestamped at request time.

`freshness.usable_for_current_state` is deliberately `false` for snapshots that
cannot support a current-state claim. In particular, stored national-grid and
water-disruption statuses have no trustworthy observation or expiry timestamp.
The old values remain under `legacy_data` only so the migration can be audited;
normal consumers should not request or display them.
