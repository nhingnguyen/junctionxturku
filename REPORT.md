# Pasila Intelligence – Technical & Data Report

A web map of the Pasila district (Helsinki). Click a building to see its details, building-permit history, area price development, postal-area statistics, zoning plans and nearby events. Only official open data is used. Data values are shown exactly as published (Finnish).

---

## 1. Technology

| Layer | Technology | Purpose |
|---|---|---|
| Data pipeline | Python 3 (standard library only: `urllib`, `json`) – [scripts/build_data.py](scripts/build_data.py) | Fetches all APIs once for a fixed BBOX, joins them, writes one static data file |
| Data file | [data/pasila-data.js](data/pasila-data.js) (`window.PASILA_DATA = {...}`, ~950 KB) | GeoJSON + statistics consumed by the frontend; no backend needed |
| Frontend | HTML + vanilla JavaScript – [index.html](index.html), [app.js](app.js), [style.css](style.css) | UI, sidebar tabs, filters, search |
| Map | Leaflet 1.9.4 | Base maps, footprint polygons (`L.geoJSON`), WMS layers |
| Chart | Chart.js 4.4.1 | Price history chart |
| Icons / font | Font Awesome 6.4, Google Fonts (Plus Jakarta Sans) | UI |
| Hosting | Any static web server (e.g. `python -m http.server`) | OSM tiles require an HTTP origin, `file://` does not work |

```
                build time (python scripts/build_data.py)                       run time (browser)
 ┌───────────────────────────────┐
 │ Helsinki WFS (footprints,      │──┐
 │ protection, zoning plans)      │  │
 │ Ryhti OGC API (buildings,      │  │   join by VTJ-PRT,      ┌──────────────────────┐     ┌──────────────────────────┐
 │ addresses, permits)            │──┼─► point-in-polygon, ──► │ data/pasila-data.js  │ ──► │ index.html + app.js       │
 │ koodistot.suomi.fi (labels)    │  │   postal code           └──────────────────────┘     │ Leaflet: base map (as-is) │
 │ StatFin PxWeb (prices, Paavo)  │──┤                                                      │ + footprint overlay       │
 │ Linked Events (events)         │──┘                                                      │ click → sidebar (5 tabs)  │
 └───────────────────────────────┘                                                         └────────────┬─────────────┘
                                                                                                        │ tiles at run time
                                                              OSM tiles / Helsinki WMS (ortho, Kantakartta) ◄┘
```

### Data area (BBOX)

`BBOX = [24.915, 60.191, 24.950, 60.209]` (minLon, minLat, maxLon, maxLat; WGS84), covering Länsi-, Keski- and Itä-Pasila. Defined in [scripts/build_data.py](scripts/build_data.py). Change it and re-run the script to cover another area.

---

## 2. Where each piece of information comes from

| Shown in the app | Source | API / layer | Field(s) |
|---|---|---|---|
| **Building polygon (footprint)** | City of Helsinki | WFS `avoindata:Rakennukset_alue_rekisteritiedot` | `geometry` (Polygon) |
| Address, postal code | City of Helsinki | same layer | `katunimi_suomi`, `osoitenumero`, `postinumero` |
| Secondary addresses (other entrances) | Ryhti (Syke) | OGC API `open_address` | `address_fin`, `postal_code` |
| VTJ-PRT, property ID | City of Helsinki | `Rakennukset_alue_rekisteritiedot` | `vtj_prt`, `c_kiinteistotunnus` |
| Building type | City of Helsinki | same layer | `tyyppi` |
| Purpose (e.g. *Kerrostalo*) | Ryhti | `open_building` | `main_purpose` → code list label |
| Completion date, storeys, apartments, floor area, total area, volume, elevator | City of Helsinki (fallback: Ryhti) | `Rakennukset_alue_rekisteritiedot` | `c_valmpvm`, `i_kerrlkm`, `i_asuinhuoneistojen_lkm`, `i_kerrosala`, `i_kokala`, `i_raktilav`, `c_hissi` |
| Heating method, energy source, load-bearing structure, facade | Ryhti | `open_building` | `heating_method`, `heating_energy_source`, `material_of_load_bearing_structures`, `facade_material` → code list labels |
| "Location verified" note | Ryhti + Helsinki | `open_building` point vs. Helsinki polygon | point-in-polygon test |
| Protection in zoning plan | City of Helsinki | WFS `Asemakaavoissa_suojellut_rakennukset_alue` | `s_merk`, `kaava` (joined on `ratu = pys_raknro`) |
| **Permits / renovation timeline** | Ryhti | `open_permit_building` | `construction_action_type`, `status_of_construction_action`, `decision_date`, `start_date`, `completion_date`, `permanent_permit_identifier` |
| **Price history (€/m², sales)** | Statistics Finland | PxWeb `StatFin/ashi/13mu.px` | `keskihinta_aritm_nw`, `lkm_julk20` by postal code |
| **Area statistics** | Statistics Finland (Paavo) | PxWeb `Postinumeroalueittainen_avoin_tieto/uusin/12f7.px` | `he_vakiy`, `hr_mtu`, `te_omis_as`, `ra_asunn`, … |
| **Zoning plans covering the building** | City of Helsinki | WFS `Kaavahakemisto_alue_kaava_voimassa`, `…_vireilla` | `kaavatunnus`, `luokka`, `hyvaksymispvm`, `voimaantulopvm` |
| **Events nearby** | City of Helsinki | Linked Events API | `name`, `start_time`, `location.position` |
| Base maps | OpenStreetMap; City of Helsinki | OSM tiles; WMS `Ortoilmakuva_2025_5cm`, `Kantakartta` | raster tiles, loaded at run time |

> Ryhti `open_building` only has a **point** per building. All **polygons** come from the City of Helsinki.

---

## 3. APIs and what they return

Examples below are real responses for **Pasilankatu 13** (VTJ-PRT `1038421946`), shortened with `…`.

### 3.1 Building footprints – City of Helsinki WFS

**Request**
```
GET https://kartta.hel.fi/ws/geoserver/avoindata/wfs
    ?service=WFS&version=2.0.0&request=GetFeature
    &typeName=avoindata:Rakennukset_alue_rekisteritiedot
    &outputFormat=application/json
    &srsName=EPSG:4326
    &bbox=60.191,24.915,60.209,24.950,urn:ogc:def:crs:EPSG::4326     ← lat,lon order in WFS 2.0
```
**Response:** GeoJSON `FeatureCollection` with 875 features in the BBOX.
```json
{
  "type": "Feature",
  "id": "Rakennukset_alue_rekisteritiedot.77500",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[24.92750333, 60.19999795], [24.92750629, 60.19999168], [24.92754409, 60.19999609], …]]
  },
  "properties": {
    "id": 877026,
    "ratu": 68914,
    "vtj_prt": "1038421946",
    "tyyppi": "Asuin- ja liikerakennus",
    "tila": "voimassa",
    "ratu_vastaavuus": "1/1 = 1 geometria / 1 RATU",
    "ratu_laatu": "määritelty luotettavasti",
    "i_raktilav": 18310, "i_kokala": 5396, "i_kerrosala": 4783, "i_kerrlkm": 8,
    "i_huoneistojen_lkm": 51, "i_asuinhuoneistojen_lkm": 51,
    "c_valmpvm": "2022-11-29T00:00:00+02:00",
    "c_kiinteistotunnus": "091-017-0105-0006",
    "c_hissi": "x",
    "katunimi_suomi": "Pasilankatu", "katunimi_ruotsi": "Bölegatan", "osoitenumero": "13", "postinumero": "00520",
    "datanomistaja": "Helsinki/RAVA",
    "paivitetty_tietopalveluun": "2026-10-16"
  }
}
```
- The polygons are surveyed building outlines from the city base map (kantakartta). They are stored natively in ETRS-GK25 (EPSG:3879), and GeoServer returns them in WGS84 because of `srsName=EPSG:4326`.
- `ratu_vastaavuus` / `ratu_laatu` tell whether the polygon is linked to a register record. 217 polygons in the BBOX have no link; they are minor structures (sheds, transformers, barracks).
- **The app never modifies these geometries.** There is no rounding, merging or simplification, and Leaflet is set to `smoothFactor: 0`. A re-fetch confirmed all 616 stored geometries are identical to the WFS.

### 3.2 Buildings – Ryhti `open_building` (OGC API Features)

**Request**
```
GET https://paikkatiedot.ymparisto.fi/geoserver/ryhti_building/ogc/features/v1/collections/open_building/items
    ?bbox=24.915,60.191,24.950,60.209&limit=2000&f=json
```
(One building: `?filter=permanent_building_identifier='1038421946'&filter-lang=cql-text&f=json`. Plain `?permanent_building_identifier=` query parameters are ignored by the server.)

**Response:** GeoJSON with **Point** geometry. 703 buildings in the BBOX. Pages are followed via `links[rel=next]`.
```json
{
  "type": "Feature",
  "id": "open_building.2f5a3da4-1ca7-4d0e-b800-124e8419ba5e",
  "geometry": { "type": "Point", "coordinates": [24.92777068, 60.19974857] },
  "properties": {
    "building_key": "2f5a3da4-1ca7-4d0e-b800-124e8419ba5e",
    "permanent_building_identifier": "1038421946",
    "property_identifier": "09101701050006",
    "completion_date": "2022-11-29Z",
    "main_purpose": "http://uri.suomi.fi/codelist/rytj/avoin_rakennusluokitus/code/06",
    "usage_status": "http://uri.suomi.fi/codelist/vtj/rake_kaytossaolotilanne/code/01",
    "facade_material": "http://uri.suomi.fi/codelist/rytj/julkisivunrakennusaine/code/02",
    "heating_method": "http://uri.suomi.fi/codelist/rytj/lammitystapa/code/01",
    "heating_energy_source": "http://uri.suomi.fi/codelist/rytj/lammitysenergianlahde/code/01",
    "material_of_load_bearing_structures": "http://uri.suomi.fi/codelist/rytj/kantavanrakenteenrakennusaine/code/01",
    "volume": 18310, "number_of_storeys": 8, "gross_floor_area": 4783, "total_area": 5396, "floor_area": 2795,
    "apartment_count": 51,
    "is_protected": false,
    "modified_timestamp_utc": "2026-10-01T23:15:41.839Z"
  }
}
```
Code fields are URIs and are resolved to labels via the code list API (3.5).

### 3.3 Addresses – Ryhti `open_address`

**Request:** `…/ryhti_building/ogc/features/v1/collections/open_address/items?bbox=…&limit=2000&f=json`
**Response:** One feature per address. A building can have several addresses, joined on `building_key`. 1 168 addresses in the BBOX. Pasilankatu 13 also has *Tenderinlenkki 10*:
```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [24.92777068, 60.19974857] },
  "properties": {
    "address_key": "28e1eb62-8833-4da7-9560-6dc78ef7ae40",
    "building_key": "2f5a3da4-1ca7-4d0e-b800-124e8419ba5e",
    "address_fin": "Tenderinlenkki 10",
    "address_swe": "Tenderlänken 10",
    "address_number": 2,
    "postal_code": "00520",
    "postal_office_fin": "HELSINKI",
    "municipality_number": "091"
  }
}
```

### 3.4 Building permits – Ryhti `open_permit_building`

**Request:** `https://paikkatiedot.ymparisto.fi/geoserver/ryhti_permit/ogc/features/v1/collections/open_permit_building/items?bbox=…&limit=2000&f=json`
**Response:** One feature per permitted construction action. 924 in the BBOX; 520 buildings have at least one.
```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [24.92777068, 60.19974857] },
  "properties": {
    "permanent_building_identifier": "1038421946",
    "permanent_permit_identifier": "3002201897",
    "dvv_permit_identifier": "09100020-02460012004",
    "decision_date": "2020-04-23Z",
    "start_date": "2021-08-18Z",
    "completion_date": "2022-11-29Z",
    "expiry_date": null,
    "construction_action_type": "http://uri.suomi.fi/codelist/rytj/Rakentamistoimenpide/code/01",
    "status_of_construction_action": "http://uri.suomi.fi/codelist/rytj/rakkohteen-toimenpiteen-tila/code/5",
    "number_of_storeys": 8, "apartment_count": 51
  }
}
```
`construction_action_type` codes: 01 Uusi rakennus tai rakennelma, 02 Laajentaminen, 03 Uudelleen rakentamiseen verrattava muutostyö, 04 Muu muutostyö, 05 Purkaminen, 06 Rakennuksen osittainen purkaminen, 07 Kaupunkikuvatoimenpide, 08 Maisemaa muuttava toimenpide, 09 Rakennuksen tai rakennelman päivitys. Codes 02–04 count as "alterations / extensions" in the app.
Status values seen in the BBOX: Valmistunut, Suunniteltu, Aloitettu, Rauennut.

### 3.5 Code lists – koodistot.suomi.fi

**Request:** `GET https://koodistot.suomi.fi/codelist-api/api/v1/coderegistries/{registry}/codeschemes/{scheme}/codes/?format=json`
The `{registry}` and `{scheme}` values are taken from the URI, e.g. `rytj` / `lammitystapa`.
```json
{ "codeValue": "01",
  "uri": "http://uri.suomi.fi/codelist/rytj/lammitystapa/code/01",
  "prefLabel": { "fi": "Vesikeskuslämmitys", "sv": "Vattenburen centralvärme", "en": "Central hot-water heating" } }
```
The app stores the `fi` label.

### 3.6 Protected buildings – City of Helsinki WFS

**Request:** same WFS as 3.1 with `typeName=avoindata:Asemakaavoissa_suojellut_rakennukset_alue`
**Response:** GeoJSON polygons, 96 in the BBOX. They are joined to footprints on `pys_raknro = ratu`.
```json
"properties": {
  "pys_raknro": "35769", "osoite": "Tapiolantie 12", "kaava": "6619", "voimaantulo_pvm": "1971-11-01",
  "laji": "rakennus", "s_merk": "s",
  "kaavaselitys": "Sivistyshistoriallisesti ja kaupunkikuvan säilyttämisen kannalta rakennustaiteellisesti arvokas rakennus. …",
  "datanomistaja": "Helsinki/MAKA"
}
```

### 3.7 Zoning plans – City of Helsinki WFS

**Request:** same WFS with `typeName=avoindata:Kaavahakemisto_alue_kaava_voimassa` (in force, 119 in the BBOX) and `…_kaava_vireilla` (pending, 4)
**Response:** Plan area polygons. A plan is linked to a building when the building's Ryhti point (or polygon centroid) lies inside the plan area.
```json
"properties": {
  "kaavatunnus": "12360", "luokka": "Voimassa",
  "hyvaksymispvm": "17.05.2017", "voimaantulopvm": "2017-06-30", "lainvoimaisuuspvm": "2017-06-30",
  "datanomistaja": "Helsinki/KAMI"
}
```

### 3.8 Prices of old dwellings – Statistics Finland PxWeb (table 13mu)

**Request**
```
POST https://pxdata.stat.fi/PxWeb/api/v1/fi/StatFin/ashi/13mu.px
{ "query": [
    { "code": "postinumeroalue_4_20220101", "selection": { "filter": "item", "values": ["00240","00520", …] } },
    { "code": "talotyyppi_6_20131021",      "selection": { "filter": "item", "values": ["1","2","3"] } } ],
  "response": { "format": "json-stat2" } }
```
**Response (json-stat2):** `value` is a flat array in row-major order over `id` / `size`.
```json
{
  "id": ["timeperiod_y", "postinumeroalue_4_20220101", "talotyyppi_6_20131021", "contentscode"],
  "size": [2, 1, 1, 2],
  "value": [5187, 61, 5651, 73],
  "dimension": {
    "timeperiod_y": { "index": { "2024": 0, "2025": 1 } },
    "postinumeroalue_4_20220101": { "label": { "00520": "00520  Itä- ja Keski-Pasila (Helsinki)" } },
    "talotyyppi_6_20131021": { "label": { "2": "Kerrostalo kaksiot" } },
    "contentscode": { "label": { "keskihinta_aritm_nw": "Neliöhinta (EUR/m2)",
                                 "lkm_julk20": "Kauppojen lukumäärä, varainsiirtoverotiedot vuodesta 2020 alkaen" } }
  }
}
```
→ 00520 two-room apartments: 5 187 €/m² from 61 sales in 2024, and 5 651 €/m² from 73 sales in 2025. The app covers 2009–2025 for three dwelling types (Kerrostalo yksiöt, kaksiot, kolmiot+). Prices are per postal code, not per building.

### 3.9 Postal code area statistics – Statistics Finland Paavo (table 12f7)

**Request**
```
POST https://pxdata.stat.fi/PxWeb/api/v1/fi/Postinumeroalueittainen_avoin_tieto/uusin/12f7.px
{ "query": [
    { "code": "postinumeroalue_4_20260101", "selection": { "filter": "item", "values": ["00520", …] } },
    { "code": "timeperiod_y", "selection": { "filter": "item", "values": ["2024"] } },
    { "code": "contentscode", "selection": { "filter": "item",
      "values": ["he_vakiy","he_kika","hr_mtu","te_taly","te_takk","te_as_valj","te_yks","te_laps",
                 "te_omis_as","te_vuok_as","ra_asunn","ra_as_kpa","ra_kt_as","ra_raky"] } } ],
  "response": { "format": "json-stat2" } }
```
**Response:** json-stat2 like 3.8. After parsing, 00520 gives:
```json
{ "he_vakiy": 8732, "he_kika": 39, "hr_mtu": 29589, "te_taly": 4861, "te_takk": 1.8, "te_as_valj": 30.7,
  "te_yks": 2509, "te_laps": 734, "te_omis_as": 2249, "te_vuok_as": 2600,
  "ra_raky": 220, "ra_asunn": 5565, "ra_as_kpa": 53.2, "ra_kt_as": 5545 }
```
Labels come from the table metadata (`GET` on the same URL), e.g. `he_vakiy` → "Asukkaat yhteensä (HE)".

### 3.10 Events – Linked Events API

**Request:** `GET https://api.hel.fi/linkedevents/v1/event/?bbox=24.915,60.191,24.950,60.209&start=today&page_size=100&include=location&sort=start_time`
**Response:** `{ "meta": { "count": 348, "next": "…page=2…" }, "data": [ … ] }`. The app stores the first 100 events.
```json
{
  "id": "lippupiste:serie-4221822",
  "name": { "fi": "Liisa Pelimaassa" },
  "start_time": "2026-12-01T16:30:00Z",
  "location": {
    "name": { "fi": "Studio Pasila", "en": "Theatre Studio Pasila" },
    "position": { "type": "Point", "coordinates": [24.940313, 60.199146] },
    "street_address": { "fi": "Ratamestarinkatu 5" }
  }
}
```
The app shows events within 800 m of the selected building and links to `https://tapahtumat.hel.fi/fi/events/{id}`.

### 3.11 Base maps (loaded by the browser, not stored)

| Layer | URL | Notes |
|---|---|---|
| OpenStreetMap (default) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Native zoom up to 19 |
| Helsinki aerial photo 2025 | WMS `https://kartta.hel.fi/ws/geoserver/avoindata/wms`, layer `avoindata:Ortoilmakuva_2025_5cm` | Same city survey as the footprints |
| Helsinki base map | same WMS, layer `avoindata:Kantakartta` | Same survey; building outlines match the footprints |

---

## 4. Join logic (build_data.py)

1. **Footprint → building:** use the polygon's `vtj_prt` from the Helsinki register. Without a link, a footprint is matched to a Ryhti building only if exactly one Ryhti point lies inside it. Otherwise it is kept as non-clickable *context*.
2. **Verification:** for each linked footprint, check that the building's own Ryhti point lies inside the polygon. Result: **626 / 642 verified, 6 mismatches** (the two registers disagree). The app shows this per building.
3. **Ryhti attributes, addresses, permits:** joined on `permanent_building_identifier` (= VTJ-PRT). Addresses are joined via `building_key`.
4. **Protection:** `ratu` (Helsinki building number) = `pys_raknro`.
5. **Zoning plans:** point-in-polygon of the building point in plan areas.
6. **Prices & Paavo:** by `postinumero`.
7. **Clipping:** only buildings whose point lies inside the BBOX are kept. Result: **616 clickable buildings + 217 context footprints**.

## 5. Output format – `data/pasila-data.js`

```js
window.PASILA_DATA = {
  generated: "2026-10-17",
  bbox: [24.915, 60.191, 24.95, 60.209],
  buildings: { type: "FeatureCollection", features: [ /* one feature per Helsinki footprint */ ] },
  context:   { type: "FeatureCollection", features: [ /* unlinked minor structures */ ] },
  prices:    { years: [...], types: { "1": "Kerrostalo yksiöt", … }, byPostal: { "00520": { "2": { price: {...}, count: {...} } } } },
  paavo:     { year: "2024", labels: {...}, byPostal: { "00520": { name, values } } },
  events:    [ { name, start, place, lon, lat, url } ],
  joinStats: { register: 642, spatial: 0, verified: 626, mismatch: 6, context: 217 }
};
```
One building feature (geometry unchanged from 3.1):
```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": [[[24.92750333, 60.19999795], [24.92750629, 60.19999168], …]] },
  "properties": {
    "id": "1038421946", "vtj": "1038421946", "footprintId": 877026,
    "address": "Pasilankatu 13", "otherAddresses": ["Tenderinlenkki 10"], "postalCode": "00520",
    "type": "Asuin- ja liikerakennus", "purpose": "Kerrostalo",
    "completed": "2022-11-29", "storeys": 8, "apartments": 51,
    "floorArea": 4783, "totalArea": 5396, "volume": 18310, "elevator": true,
    "propertyId": "091-017-0105-0006",
    "heating": "Vesikeskuslämmitys", "energy": "Kauko- tai aluelämpö", "structure": "Betoni", "facade": "Tiili",
    "protection": null,
    "plans": [ { "id": "12360", "status": "Voimassa", "approved": "17.05.2017", "inForce": "2017-06-30" } ],
    "history": [ { "action": "Uusi rakennus tai rakennelma", "actionCode": "01", "status": "Valmistunut",
                   "decision": "2020-04-23", "start": "2021-08-18", "completed": "2022-11-29", "permitId": "3002201897" } ],
    "parts": 1, "verified": true, "match": "register"
  }
}
```

---

## 6. Licences & attribution

| Source | Licence | Attribution shown |
|---|---|---|
| City of Helsinki – buildings, protection, plans, ortho, Kantakartta | CC BY 4.0 ([HRI: helsingin-rakennukset](https://hri.fi/data/fi/dataset/helsingin-rakennukset), helsingin-ortoilmakuvat, helsingin-kantakartta) | © Helsingin kaupunki |
| Ryhti (Syke) – buildings, addresses, permits | CC BY 4.0 (Syke open data terms, [Käyttölupa ja vastuut](https://www.syke.fi/fi/ymparistotieto/kayttolupa-ja-vastuut)) | Lähde: Syke, Ryhti |
| Statistics Finland – 13mu, Paavo | CC BY 4.0 | © Tilastokeskus |
| Linked Events | CC BY 4.0 ([HRI](https://hri.fi/data/fi/dataset/linked-events-tapahtumarajapinta)) | City of Helsinki |
| OpenStreetMap tiles | ODbL + Tile Usage Policy | © OpenStreetMap contributors |

Attribution is shown in the map corner and in the *Sources & Licences* dialog. The Ryhti API metadata has no licence field. The licence follows from Syke's general open-data terms, so confirm with ryhti@syke.fi before a public launch.

**Not available as legal open data, so not shown:** apartments for sale (Etuovi and Oikotie have no open API and forbid scraping), per-apartment or per-building transaction prices, and land prices per parcel.

---

## 7. Known display limitations

The footprint data is exact. Visible offsets come from display, not from the data:
- **Leaflet rounds every vertex to whole screen pixels** (`latLngToLayerPoint`). One pixel is ≈ 1.19 m at zoom 16 and ≈ 0.30 m at zoom 18 in Helsinki. Small corners therefore look slightly off when zoomed out.
- Polygons are scaled during the zoom animation and redrawn when it ends.
- OSM tiles are upscaled above zoom 19.
- OSM buildings are volunteer-drawn, usually traced from roof outlines, and often merge a whole block into one shape. Use the Helsinki aerial photo or Kantakartta base map to compare against the same survey.

## 8. Run / update

```powershell
python scripts/build_data.py      # refresh data/pasila-data.js (~1–2 min)
python -m http.server 8000        # open http://localhost:8000
```
