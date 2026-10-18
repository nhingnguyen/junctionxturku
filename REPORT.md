# Pasila Intelligence – Technical & Data Report

A web map of the Pasila district (Helsinki). Click a building to see its details, building-permit history, area price development, postal-area statistics, detailed plans, nearby events, traffic noise and the nearest environmental permit facility. An optional AI assistant panel can focus the map on the places it names (§9). Only official open data with a verified licence is used (§6). The app is English-only: it uses the official English labels published by the sources; values without an official translation are shown in Finnish (see §5.1).

---

## 1. Technology

| Layer | Technology | Purpose |
|---|---|---|
| Data pipeline | Python 3 (standard library only: `urllib`, `json`, `concurrent.futures`) – [scripts/build_data.py](scripts/build_data.py) | Fetches all APIs in parallel (with retries) for a fixed BBOX, joins them, writes one static data file (~30 s) |
| Data file | [data/pasila-data.js](data/pasila-data.js) (`window.PASILA_DATA = {...}`, ~1.1 MB, ~220 KB gzipped) | GeoJSON + statistics consumed by the frontend; no backend needed |
| Frontend | HTML + vanilla JavaScript – [index.html](index.html), [app.js](app.js), [style.css](style.css) | UI, sidebar tabs, search |
| Map | Leaflet 1.9.4 | Base maps, footprint polygons (`L.geoJSON`), WMS layers |
| Chart | Chart.js 4.4.1 | Price history chart |
| Icons / font | Font Awesome 6.4, Google Fonts (Plus Jakarta Sans) | UI |
| Hosting | Any static web server (e.g. `python -m http.server`) | OSM tiles require an HTTP origin, `file://` does not work |

```
                build time (python scripts/build_data.py)                       run time (browser)
 ┌───────────────────────────────┐
 │ Helsinki WFS (footprints,      │──┐
 │ protection, detailed plans,    │  │
 │ noise zones, env. permits)     │  │
 │ Ryhti OGC API (buildings,      │  │   join by VTJ-PRT,      ┌──────────────────────┐     ┌──────────────────────────┐
 │ addresses, permits)            │──┼─► point-in-polygon, ──► │ data/pasila-data.js  │ ──► │ index.html + app.js       │
 │ Stat. Finland classifications  │  │   postal code           └──────────────────────┘     │ Leaflet: base map (as-is) │
 │ StatFin PxWeb (prices, Paavo)  │──┤                                                      │ + footprint overlay       │
 │ Linked Events (events)         │──┘                                                      │ click → sidebar (6 tabs)  │
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
| Address, postal code | Ryhti (Syke); fallback City of Helsinki | OGC API `open_address`; `Rakennukset_alue_rekisteritiedot` | `address_fin`, `postal_code` (first address = main address); the Helsinki register address `katunimi_suomi` + `osoitenumero` is kept as another address when it differs |
| Secondary addresses (other entrances) | Ryhti (Syke) | OGC API `open_address` | further `address_fin` values of the building |
| VTJ-PRT, property ID | City of Helsinki; Ryhti (Syke) | `Rakennukset_alue_rekisteritiedot`, `open_building` | `vtj_prt`; property ID from Ryhti `property_identifier`, fallback Helsinki `c_kiinteistotunnus` (the Helsinki register still names 091-432-0001-0026 for four buildings at Auroranportti 2/4, which Ryhti and the plan units place on 091-018-9903/9904-0002) |
| Distance to the official address point | City of Helsinki | WFS `Osoiteluettelo_piste_rekisteritiedot` | `katuosoite`, point geometry; metres from the footprints to the point of each registered address. Some addresses are registered for several buildings (e.g. *Veturitori 3*: an office building 9 m and a transformer 356 m from the point); search lists them nearest first and shows the distance |
| Building class (e.g. *Residential blocks of flats*) | City of Helsinki + Statistics Finland | same layer | `c_rakennusluokka` → Classification of Buildings 2018 English label (Statistics Finland classifications API); fallback `tyyppi` |
| Completion date, storeys, apartments, floor area, total area, volume | Ryhti (fallback: City of Helsinki) | `open_building`; `Rakennukset_alue_rekisteritiedot` | `completion_date`, `number_of_storeys`, `apartment_count`, `gross_floor_area`, `total_area`, `volume`; Ryhti's 0 for storeys/areas/volume means unknown and falls back to `c_valmpvm`, `i_kerrlkm`, `i_asuinhuoneistojen_lkm`, `i_kerrosala`, `i_kokala`, `i_raktilav` |
| Elevator | City of Helsinki | `Rakennukset_alue_rekisteritiedot` | `c_hissi` (Ryhti publishes no elevator field) |
| Heating energy source, heating method, load-bearing material, facade | City of Helsinki | `Rakennukset_alue_rekisteritiedot` | `c_poltaine`, `c_lammtapa`, `c_rakeaine`, `c_julkisivu` → Finnish labels from the dataset's [code explanations](https://kartta.hel.fi/avoindata/dokumentit/2017-01-10_Rakennusaineisto_avoindata_koodistot.pdf) (stored in `scripts/helsinki_building_codes.json`) |
| Network connections | City of Helsinki | `Rakennukset_alue_rekisteritiedot` | `c_vesilii`, `c_viemlii`, `c_sahkolii`: listed only when the register flag is `x`; an empty flag is shown as not recorded, never as "no connection" |
| Protection in detailed plan | City of Helsinki | WFS `Asemakaavoissa_suojellut_rakennukset_alue` | `s_merk`, `kaava` (joined on `ratu = pys_raknro`) |
| **Permit timeline** – click a permit for details | Ryhti + Syke data model | `open_permit_building` | `construction_action_type` (type of work, labelled from `sykefi/rakennuskohteet`), `decision_date`, `start_date`, `completion_date`, `expiry_date`, `construction_to_be_completed_by_extension` (extension decision ID), `permanent_permit_identifier`, `dvv_permit_identifier` + building data stated in the permit (`number_of_storeys`, `apartment_count`, areas, `volume`). The app shows these values as published and does not infer a status |
| **Price history (€/m², sales)** | Statistics Finland | PxWeb `StatFin/ashi/13mu.px` | `keskihinta_aritm_nw`, `lkm_julk20` by postal code |
| **Area statistics** | Statistics Finland (Paavo) | PxWeb `Postinumeroalueittainen_avoin_tieto/uusin/12f7.px` | `he_vakiy`, `hr_mtu`, `tr_ktu`, `tr_mtu`, `te_omis_as`, `ra_asunn`, … |
| **Plot zoning** (permitted use, building rights, plot area) | City of Helsinki | WFS `avoindata:Kaavayksikot` | `kaavayksikkotunnus` (= property ID), `kayttotarkoitusluokka`, `rakennusoikeus`, `rekisteriala`, `kaavatunnus`; joined only on the building's property ID, no location-based guessing (543/616 buildings) |
| **Detailed plans (asemakaava) covering the building** – click a plan for details and its boundary on the map | City of Helsinki | WFS `Kaavahakemisto_alue_kaava_voimassa`, `…_vireilla` | `kaavatunnus`, `luokka`, `hyvaksymispvm`, `vahvistamispvm`, `lainvoimaisuuspvm`, `voimaantulopvm`, `pintaala`, `muokkauspvm`, `geometry` |
| **Events nearby** | City of Helsinki | Linked Events API | `name.en` (fallback `fi`), `start_time`, `location.name.en`, `location.position` |
| **Traffic noise** (Environment tab) – road, railway, tram | City of Helsinki noise survey 2022 | WFS `Meluselvitys_2022_Helsinki_kadut_ja_maantiet_Lden`, `…_rautatiet_Lden`, `…_raitiotie_Lden` | `db_lo`, `db_hi`, `geometry`; the highest Lden zone that touches any of the building's footprints, shown as published (e.g. *60–65 dB*, *75+ dB*) |
| **Nearest environmental permit facility** (Environment tab) | City of Helsinki | WFS `Ymparistolupakohteet` | `nimi`, `katuosoite`, `postitoimipaikka`, `toiminnan_luokittelun_tarkenne`, point geometry; distance in metres from the footprint edge |
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
Code fields are URIs pointing to koodistot.suomi.fi code lists. **The app does not use them**: the code-list service publishes no licence for its content (see §3.5, §6).

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

A building permit (*rakennuslupa*) is the municipality's decision allowing construction work. Ryhti's open data has the permit's dates and IDs, plus the building data stated in the permit (as the building will be after the work). The type of work (`construction_action_type`, e.g. `…/Rakentamistoimenpide/code/02`) is labelled from Syke's own data model [sykefi/rakennuskohteet](https://github.com/sykefi/rakennuskohteet/blob/be5339e07544a91e7bcf8e7f96ef8f28f4e496f8/looginenmalli/elinkaarisaannot.md) (CC BY 4.0): 01 Uusi rakennus tai rakennelma (new building), 02 Laajentaminen (extension), 03 Uudelleen rakentamiseen verrattava muutostyö (alteration comparable to rebuilding), 04 Muu muutostyö (other alteration), 05 Purkaminen (demolition); stored in `scripts/ryhti_permit_codes.json`. The status code has no licensed label list with code numbers, so the app does not show a status; it shows the published dates (decision, start, completion, expiry) only. The description of the work, drawings and conditions are only in Ryhti's licensed, paid interface (stated in the [Syke metadata](https://ckan.ymparisto.fi/dataset/rakennetun-ympariston-tietojarjestelman-rakennustiedot)).

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
`construction_to_be_completed_by_extension` is the ID of an extension decision, not a date.

### 3.5 Labels for coded values

| Value | Label source | Licence |
|---|---|---|
| Building class (`c_rakennusluokka`, e.g. `0121`) | Statistics Finland classifications API `https://data.stat.fi/api/classifications/v2/classifications/rakennus_1_20180712/classificationItems?lang=en` → *Residential blocks of flats* | CC BY 4.0 |
| Heating energy source, heating method, load-bearing material, facade (`c_poltaine`, `c_lammtapa`, `c_rakeaine`, `c_julkisivu`) | Code explanations published with the Helsinki building dataset ([PDF](https://kartta.hel.fi/avoindata/dokumentit/2017-01-10_Rakennusaineisto_avoindata_koodistot.pdf)), transcribed into `scripts/helsinki_building_codes.json` (Finnish only) | CC BY 4.0 (part of `helsingin-rakennukset`) |
| Permit type (`construction_action_type`, codes 01–05) | Syke data model [sykefi/rakennuskohteet](https://github.com/sykefi/rakennuskohteet) (LICENSE: CC BY 4.0), transcribed into `scripts/ryhti_permit_codes.json` | CC BY 4.0 |
| Other Ryhti code URIs (`main_purpose`, `heating_energy_source`, materials, `status_of_construction_action`, `construction_method`) | koodistot.suomi.fi | **No published licence → not used** |

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

### 3.7 Detailed plans (asemakaava) – City of Helsinki WFS

A detailed plan is the legally binding local land-use plan: it fixes what each plot may be used for, how much and how high may be built, and which buildings are protected. *Voimassa* = in force, *Vireillä* = being prepared.

**Request:** same WFS with `typeName=avoindata:Kaavahakemisto_alue_kaava_voimassa` (in force, 119 in the BBOX) and `…_kaava_vireilla` (pending, 4)
**Response:** Plan area polygons. A plan is linked to a building when the building's Ryhti point (or polygon centroid) lies inside the plan area. `hyvaksymispvm` is parsed into a date and an optional approving body (e.g. `kylk 14.5.2024` → `2024-05-14`, `kylk`).
```json
"properties": {
  "kaavatunnus": "12360", "luokka": "Voimassa",
  "hyvaksymispvm": "17.05.2017", "voimaantulopvm": "2017-06-30", "lainvoimaisuuspvm": "2017-06-30",
  "datanomistaja": "Helsinki/KAMI"
}
```

### 3.7b Plot zoning – City of Helsinki WFS `Kaavayksikot`

**Request:** same WFS with `typeName=avoindata:Kaavayksikot` (653 plan units in the BBOX; only `luokka = Voimassa` is used)
```json
"properties": {
  "kaavayksikkotunnus": "09101701050006", "kaavatunnus": "12360", "luokka": "Voimassa",
  "kayttotarkoitusluokka": "AK Asuinkerrostalot", "kayttotarkoitusluokka_koodi": "AK",
  "rakennusoikeus": 4250, "rekisteriala": 1712, "osoite": "Tenderinlenkki 10 00520 Helsinki",
  "datanomistaja": "Helsinki/KMO"
}
```
This is the actual content of the detailed plan for the building's plot: what the plot may be used for (AK = residential blocks of flats) and how much floor area may be built (building rights, m²). Ryhti's plan service (`ryhti_plan`) has no Helsinki plans yet.

### 3.8 Prices of old dwellings – Statistics Finland PxWeb (table 13mu)

**Request**
```
POST https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin/ashi/13mu.px      ← /en/ gives English labels, /fi/ Finnish
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
    "talotyyppi_6_20131021": { "label": { "2": "Blocks of flats, two-room flat" } },
    "contentscode": { "label": { "keskihinta_aritm_nw": "Neliöhinta (EUR/m2)",
                                 "lkm_julk20": "Kauppojen lukumäärä, varainsiirtoverotiedot vuodesta 2020 alkaen" } }
  }
}
```
→ 00520 two-room apartments: 5 187 €/m² from 61 sales in 2024, and 5 651 €/m² from 73 sales in 2025. The app covers 2009–2025 for three dwelling types (one-room, two-room, three-room+ flats in blocks of flats). Prices are per postal code, not per building.

### 3.9 Postal code area statistics – Statistics Finland Paavo (table 12f7)

**Request**
```
POST https://pxdata.stat.fi/PxWeb/api/v1/en/Postinumeroalueittainen_avoin_tieto/uusin/12f7.px
{ "query": [
    { "code": "postinumeroalue_4_20260101", "selection": { "filter": "item", "values": ["00520", …] } },
    { "code": "timeperiod_y", "selection": { "filter": "item", "values": ["2024"] } },
    { "code": "contentscode", "selection": { "filter": "item",
      "values": ["he_vakiy","he_kika","hr_mtu","tr_kuty","tr_ktu","tr_mtu","tr_pi_tul","tr_ke_tul","tr_hy_tul","te_taly","te_takk","te_as_valj","te_yks","te_laps",
                 "te_omis_as","te_vuok_as","ra_asunn","ra_as_kpa","ra_kt_as","ra_raky"] } } ],
  "response": { "format": "json-stat2" } }
```
**Response:** json-stat2 like 3.8. After parsing, 00520 gives:
```json
{ "he_vakiy": 8732, "he_kika": 39, "hr_mtu": 29589,
  "tr_kuty": 4861, "tr_ktu": 51629, "tr_mtu": 41300, "tr_pi_tul": 982, "tr_ke_tul": 2498, "tr_hy_tul": 1381, "te_taly": 4861, "te_takk": 1.8, "te_as_valj": 30.7,
  "te_yks": 2509, "te_laps": 734, "te_omis_as": 2249, "te_vuok_as": 2600,
  "ra_raky": 220, "ra_asunn": 5565, "ra_as_kpa": 53.2, "ra_kt_as": 5545 }
```
Labels come from the English table metadata (`GET` on the same URL), e.g. `he_vakiy` → "Inhabitants, total (HE)". Postal area names (*Itä- ja Keski-Pasila*) are place names and are not translated.

### 3.10 Events – Linked Events API

**Request:** `GET https://api.hel.fi/linkedevents/v1/event/?bbox=24.915,60.191,24.950,60.209&start=today&page_size=100&include=location&sort=start_time&hide_recurring_children=true`
**Response:** `{ "meta": { "count": …, "next": "…page=2…" }, "data": [ … ] }`. The script follows `meta.next` through all pages. `hide_recurring_children=true` collapses repeated performances into their series (e.g. 348 raw items → 115 events).
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
The app stores `name.en` (falling back to `fi`), `location.name.en`, start/end, and shows events within 800 m of the selected building, linking to `https://tapahtumat.hel.fi/en/events/{id}`.

### 3.10b Traffic noise zones – City of Helsinki WFS (noise survey 2022)

**Request:** same WFS as 3.1 with `typeName=avoindata:Meluselvitys_2022_Helsinki_kadut_ja_maantiet_Lden` (road traffic, 447 zones in the BBOX), `…_rautatiet_Lden` (railway, 179) and `…_raitiotie_Lden` (tram, 191). One request returns every zone (`numberMatched` = `numberReturned`), so nothing is cut off by paging.
**Response:** Polygons, one per 5 dB band. Bands start at 45 dB; `db_hi` is `null` for the top band (75+ dB). Some zones have up to ~42 000 vertices.
```json
"properties": {
  "id": 17156, "db_lo": 70, "db_hi": 75, "colour": "#FF0000",
  "datanomistaja": "Helsinki/Ympa", "paivitetty_tietopalveluun": "2025-06-16"
}
```
Lden is the modelled day-evening-night outdoor level; the zones are not indoor levels. The published colours are not used.

### 3.10c Environmental permit facilities – City of Helsinki WFS `Ymparistolupakohteet`

**Request:** same WFS with `typeName=avoindata:Ymparistolupakohteet`, but with the BBOX widened by 1 km on every side (31 facilities). The widening makes the nearest facility correct for every building whenever it lies within 1 km; buildings with none within 1 km would show "no facility" (none in the current build, the furthest is 714 m).
```json
"properties": {
  "id": "4966208", "nimi": "Pohjolan Liikenne Oy / Veturitien varikko ja jakelupiste",
  "katuosoite": "Veturitie 25", "postitoimipaikka": "00240 HELSINKI",
  "toiminnan_luokittelun_tarkenne": "YSL 527/2014 liite 4.6 ajoneuvovarikko",
  "datanomistaja": "Helsingin kaupunki, ympäristöpalvelut", "paivitetty_tietopalveluun": "2026-10-16"
}
```
The register lists where permitted activities are; it does not describe emissions or risk, and the app does not add any.

### 3.11 Base maps (loaded by the browser, not stored)

| Layer | URL | Notes |
|---|---|---|
| OpenStreetMap (default) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Native zoom up to 19 |
| Helsinki aerial photo 2025 | WMS `https://kartta.hel.fi/ws/geoserver/avoindata/wms`, layer `avoindata:Ortoilmakuva_2025_5cm` | Same city survey as the footprints |
| Helsinki base map | same WMS, layer `avoindata:Kantakartta` | Same survey; building outlines match the footprints |

---

## 4. Join logic (build_data.py)

1. **Footprint → building:** use the polygon's `vtj_prt` from the Helsinki register. Without a link, a footprint is matched to a Ryhti building only if exactly one Ryhti point lies inside it. Otherwise it is kept as non-clickable *context*.
2. **Verification:** for each linked footprint, check that the building's own Ryhti point lies inside the polygon. Result: **626 / 642 verified, 6 mismatches** (the two registers disagree). This is a build-time quality check printed in the build log; the app does not show conclusions of its own.
3. **Ryhti attributes, addresses, permits:** joined on `permanent_building_identifier` (= VTJ-PRT). Addresses are joined via `building_key`.
4. **Protection:** `ratu` (Helsinki building number) = `pys_raknro`.
5. **Detailed plans:** point-in-polygon of the building point in plan areas. Each plan used is stored once in `plans` (details + boundary as published); buildings reference plan numbers.
6. **Prices & Paavo:** by `postinumero`.
7. **Clipping:** only buildings whose point lies inside the BBOX are kept. Result: **616 clickable buildings + 217 context footprints**.
8. **Traffic noise:** for each noise layer, the zones are tested from the loudest band down; the first zone whose polygon overlaps any of the building's footprints (shared area or boundary, holes respected) gives the band. The large zone polygons are indexed by latitude rows so each footprint only checks nearby edges. 520 of 616 buildings touch at least one zone. Cross-checked against shapely for all buildings: 0 differences.
9. **Nearest environmental permit facility:** shortest distance in metres from each facility point to the building's footprints (0 if inside), planar metres at 60.2° N (<1 % error inside the BBOX). Facilities used are stored once in `permitSites`; buildings reference the id. Cross-checked against shapely: same facility for all 616 buildings, distances within 1 m.

## 5. Output format – `data/pasila-data.js`

`null` values and empty lists are dropped to keep the file small; the frontend treats missing fields as empty. The build also stamps `index.html` with `data/pasila-data.js?v=<build time>` so browsers never use a stale dataset.

```js
window.PASILA_DATA = {
  generated: "2026-10-18",
  bbox: [24.915, 60.191, 24.95, 60.209],
  buildings: { type: "FeatureCollection", features: [ /* one feature per Helsinki footprint */ ] },
  context:   { type: "FeatureCollection", features: [ /* unlinked minor structures, geometry only */ ] },
  plans:     { "12360": { id, status, approved, approvedBy, confirmed, legallyValid, inForce, areaM2, updated, geometry }, … },
  prices:    { years: [...], types: { "1": "Blocks of flats, one-room flat", … }, byPostal: { "00520": { "2": { price: {...}, count: {...} } } } },
  paavo:     { year: "2024", labels: {...}, byPostal: { "00520": { name, values } } },
  events:    [ { name, start, end, place, lon, lat, url } ],
  noiseSurvey: { year: 2022, metric: "Lden", updated: "2025-06-16" },
  permitSites: { "5350916": { name, address, postOffice, activity, updated, lonlat }, … },
  permitSiteRadius: 1000,
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
    "class": "Residential blocks of flats",
    "completed": "2022-11-29", "storeys": 8, "apartments": 51,
    "floorArea": 4783, "totalArea": 5396, "volume": 18310, "elevator": true,
    "propertyId": "091-017-0105-0006",
    "energy": "Kauko- tai aluelämpö", "structure": "Betoni tai kevytbetoni", "facade": "Tiili",
    "plans": ["12360"],
    "noise": { "road": [60, 65], "rail": [50, 55], "tram": [55, 60] },
    "permitSite": { "id": "5350916", "m": 130 },
    "history": [ { "decision": "2020-04-23", "start": "2021-08-18", "completed": "2022-11-29",
                   "permitId": "3002201897", "dvvId": "09100020-02460012004",
                   "storeys": 8, "apartments": 51, "grossFloorArea": 4783, "floorArea": 2795, "totalArea": 5396, "volume": 18310 } ]
  }
}
```

### 5.1 Values without an official English label

The build prints every Finnish value it could not resolve to an official English label (81 values, ~2 140 characters in the current build). They are shown in Finnish for now and are the input for a planned machine-translation step:

| Kind | Examples | Why |
|---|---|---|
| Heating energy source, heating method, load-bearing material, facade | Kauko- tai aluelämpö, Vesikeskuslämmitys, Betoni tai kevytbetoni, Tiili, … | Helsinki's code explanations are Finnish only |
| Plot permitted use | Asuinkerrostalot, Keskustatoiminnot, … | Helsinki WFS publishes Finnish only |
| Plan status, approving body | Voimassa, Vireillä, kylk | Helsinki WFS publishes Finnish only |
| Building class fallback | Muuntamo, Toimistorakennus, … | footprints without a `c_rakennusluokka` code |
| Event names | Satutunti, Perheaamu, … | event has no `name.en` in Linked Events |
| Environmental permit activity | YSL 527/2014 liite 2.3 jakeluasema, … | Helsinki WFS publishes Finnish only |

---

## 6. Licences & attribution

| Source / layer | Used for | Licence | Where the licence is stated | Attribution |
|---|---|---|---|---|
| Helsinki WFS `Rakennukset_alue_rekisteritiedot` | Footprints, register data | CC BY 4.0 | [HRI: helsingin-rakennukset](https://hri.fi/data/fi/dataset/helsingin-rakennukset) (layer named in the dataset) | © Helsingin kaupunki |
| Helsinki WFS `Asemakaavoissa_suojellut_rakennukset_alue` | Protection | CC BY 4.0 | [HRI: asemakaavoilla-suojellut-rakennukset-ja-alueet-helsingissa](https://hri.fi/data/fi/dataset/asemakaavoilla-suojellut-rakennukset-ja-alueet-helsingissa) | © Helsingin kaupunki |
| Helsinki WFS `Kaavahakemisto_alue_kaava_voimassa / _vireilla` | Detailed plan records + boundaries | CC BY 4.0 | [HRI: helsingin-asemakaavahakemistokartta-asemakaavahakemisto](https://hri.fi/data/fi/dataset/helsingin-asemakaavahakemistokartta-asemakaavahakemisto) | © Helsingin kaupunki |
| Helsinki WFS `Kaavayksikot` | Plot zoning (use, building rights) | CC BY 4.0 | [HRI: helsingin-kaavayksikot](https://hri.fi/data/fi/dataset/helsingin-kaavayksikot) | © Helsingin kaupunki |
| Helsinki WMS `Ortoilmakuva_2025_5cm`, `Kantakartta` | Optional base maps | CC BY 4.0 | [HRI: helsingin-ortoilmakuvat](https://hri.fi/data/fi/dataset/helsingin-ortoilmakuvat), [HRI: helsingin-kantakartta](https://hri.fi/data/fi/dataset/helsingin-kantakartta) | © Helsingin kaupunki |
| Ryhti `open_building`, `open_address`, `open_permit_building` | Building points (verification), addresses, permits | CC BY 4.0 | [Syke metadata: Ryhti rakennustiedot](https://ckan.ymparisto.fi/dataset/rakennetun-ympariston-tietojarjestelman-rakennustiedot) – *"Open data on completed buildings, project buildings, and addresses … The open data content of the dataset is part of SYKE's open data (CC BY 4.0)"*; [Syke terms](https://www.syke.fi/fi/ymparistotieto/kayttolupa-ja-vastuut) | Lähde: Syke, Ryhti |
| StatFin `ashi/13mu`, Paavo `12f7` (PxWeb) | Prices, area statistics | CC BY 4.0 | [Statistics Finland: Open data and interfaces](https://stat.fi/en/services/statistical-data-services/open-data-and-interfaces), [Terms of use](https://stat.fi/en/about-us/get-to-know-statistics-finland/legislation/terms-of-use); Paavo also listed as CC BY 4.0 on [research.fi](https://research.fi/en/results/dataset/ff0c88e8-5d2c-4e8f-85ef-96d6a951c552) | © Tilastokeskus |
| Statistics Finland classifications API `rakennus_1_20180712` | Building class (fi + en) | CC BY 4.0 | [Open data and interfaces](https://stat.fi/en/services/statistical-data-services/open-data-and-interfaces) (lists the classifications API under the open-data licence) | © Tilastokeskus |
| Helsinki building register code explanations (PDF) | Energy source, heating method, material, facade labels | CC BY 4.0 | Linked from [HRI: helsingin-rakennukset](https://hri.fi/data/fi/dataset/helsingin-rakennukset) | © Helsingin kaupunki |
| Syke GitHub `sykefi/rakennuskohteet` | Permit type labels (codes 01–05) | CC BY 4.0 | [LICENSE](https://github.com/sykefi/rakennuskohteet/blob/HEAD/LICENSE) in the repository | Syke |
| Helsinki WFS `Meluselvitys_2022_Helsinki_*_Lden` | Traffic noise zones | CC BY 4.0 | [HRI: helsingin-kaupungin-meluselvitys-2017](https://hri.fi/data/fi/dataset/helsingin-kaupungin-meluselvitys-2017) (the city's noise survey dataset; the 2022 layers are served from the same WFS) | © Helsingin kaupunki |
| Helsinki WFS `Ymparistolupakohteet` | Environmental permit facilities | CC BY 4.0 | [HRI: helsingin-ymparistolupakohteet](https://hri.fi/data/fi/dataset/helsingin-ymparistolupakohteet) | © Helsingin kaupunki |
| Helsinki WFS `Osoiteluettelo_piste_rekisteritiedot` | Official address points (search order for shared addresses) | CC BY 4.0 | [HRI: helsingin-osoiteluettelo](https://hri.fi/data/fi/dataset/helsingin-osoiteluettelo) | © Helsingin kaupunki |
| Linked Events | Events | CC BY 4.0 | [HRI: linked-events-tapahtumarajapinta](https://hri.fi/data/fi/dataset/linked-events-tapahtumarajapinta) | City of Helsinki |
| Syke WFS `inspire_nz` flood hazard layers | Flood hazard zones, mapped areas | CC BY 4.0 | [Syke metadata](https://ckan.ymparisto.fi/dataset/tulvavaaravyohykkeet-perusskenaariot-flood-hazard-zones-basic-scenarios) | Lähde: Syke ja Elinvoimakeskukset |
| Helsinki WFS `FMI_Turvalliset_rakentamiskorkeudet_piste_2024` | Sea level estimates on the shoreline | CC BY 4.0 | [HRI: turvalliset-rakentamiskorkeudet-…](https://hri.fi/data/fi/dataset/turvalliset-rakentamiskorkeudet-ja-suurin-arvioitu-merkitseva-aallonkorkeus-helsingissa) | © Helsingin kaupunki, Ilmatieteen laitos |
| Service Map API (api.hel.fi/servicemap) | Rescue stations | CC BY 4.0 | [HRI: paakaupunkiseudun-palvelukartan-rest-rajapinta](https://hri.fi/data/fi/dataset/paakaupunkiseudun-palvelukartan-rest-rajapinta) | City of Helsinki |
| Statistics Finland WFS `postialue:pno_<year>` | Postal code areas touching the BBOX | CC BY 4.0 | [Statistics Finland: Open data and interfaces](https://stat.fi/en/services/statistical-data-services/open-data-and-interfaces) | © Tilastokeskus |
| STUK radon tables by postal code (web pages) | Indoor radon | **not stated** – used on request | [workplaces](https://stuk.fi/hae-tyopaikkojen-radonmittaustuloksia-postinumeroalueittain), [detached houses](https://stuk.fi/pientalojen-radonpitoisuudet-postinumeroalueittain) | Lähde: STUK |
| OpenStreetMap tiles | Default base map | ODbL + Tile Usage Policy | [OSM copyright](https://www.openstreetmap.org/copyright), [Tile policy](https://operations.osmfoundation.org/policies/tiles/) | © OpenStreetMap contributors |

**Rules:** a source is used only if its licence is stated by the publisher, and the app shows published values without drawing its own conclusions (no inferred statuses, no verification verdicts, no good/bad colouring; plots are linked only by ID). **Not used:** koodistot.suomi.fi code-list labels (no licence published for the content; only the software is EUPL-1.2). As a result the app does not show Ryhti's permit status labels, construction method or Ryhti's purpose label (permit types come from Syke's CC BY data model instead). HSY's water-supply disruption map (ArcGIS `Julkinen_Hairiokartta_katselu`) publishes no licence; it was added on request. Only `OBJECTID, tyyppi, alkuaika, loppuaika, nimi, asukkaat` are requested, so no contact fields (staff e-mail addresses) are downloaded. A building lists every disruption area its footprint touches.

**Hazards (Environment tab), all fetched when the data is built – no fixed values:**
- **Flood hazard** – Syke WFS `inspire_nz:NZ.Tulvavaaravyohykkeet_{Meritulva,Vesistotulva}_1_{2…1000}a` (zones with a water depth, `syvsuojluokka_id` 1–98) and `NZ.Tulvavaarakartoitetut_alueet_*` (mapped areas). Per building: the most frequent scenario whose zone touches a footprint and the deepest depth class touched, or "outside every mapped zone" / "not covered by a flood hazard map". In the current build every building is inside the Helsinki sea-flood map and outside all zones up to 1/1000 a; no river flood map covers the area. Licence: CC BY 4.0, "Lähde: Syke ja Elinvoimakeskukset" ([Syke metadata](https://ckan.ymparisto.fi/dataset/tulvavaaravyohykkeet-perusskenaariot-flood-hazard-zones-basic-scenarios)).
- **Sea level at the nearest shoreline point** – City of Helsinki WFS `FMI_Turvalliset_rakentamiskorkeudet_piste_2024` (FMI's combined wave and water level estimates for 2020/2050/2100, N2000), the point nearest to the footprint and its distance (0.8–2.5 km in the current build). It describes the shore, not the building. CC BY 4.0 ([HRI](https://hri.fi/data/fi/dataset/turvalliset-rakentamiskorkeudet-ja-suurin-arvioitu-merkitseva-aallonkorkeus-helsingissa)).
- **Nearest rescue station** – Service Map API, service 501 "rescue stations" (units named *…asema*), straight-line distance from the footprint; no response time is claimed. CC BY 4.0 ([HRI](https://hri.fi/data/fi/dataset/paakaupunkiseudun-palvelukartan-rest-rajapinta)).
- **Indoor radon by postal code** – STUK's two tables (workplaces 2014–2023, at least 5 measured; detached houses 1980–2023, at least 10 measured), read from the tables on [stuk.fi](https://stuk.fi/hae-tyopaikkojen-radonmittaustuloksia-postinumeroalueittain) and [stuk.fi](https://stuk.fi/pientalojen-radonpitoisuudet-postinumeroalueittain). Postal codes STUK does not publish are shown as "not published". The pages state no licence (STUK's CC BY 4.0 covers only its open-data service); used on request.
- **Removed** (no open source): rescue risk class and response targets, power-grid figures (Fingrid/Helen/SAIDI), fire class and ignition hazard mapped from register codes, LOW/MODERATE/HIGH noise labels. The earlier `scripts/risk_profile_values.json` held fixed values typed into the planned risk pipeline (its radon figures for 00510/00520 do not match STUK's tables) and is deleted.

**Postal code areas:** every Statistics Finland postal code area touching the BBOX (WFS `geo.stat.fi/geoserver/postialue`, `pno_<year>`, CC BY 4.0) – currently 00240, 00250, 00270, 00280, 00310, 00320, 00510, 00520, 00550, 00610 – gets Paavo statistics, prices and radon; the Area and Prices tabs let the user switch between them.

Attribution is shown in the map corner and in the *Sources & Licences* dialog.

**Not available as legal open data, so not shown:** apartments for sale or rent, per-apartment or per-building transaction prices, and land prices per parcel.

### 6.1 Listings (for sale / for rent)

Scraping Etuovi, Vuokraovi or Oikotie and attaching listings to parcels was evaluated and **rejected**:

| Site | robots.txt | Terms of use |
|---|---|---|
| Etuovi.com, Vuokraovi.com (Alma Media) | Vuokraovi disallows `/api/*` for all agents | [Alma Media marketplace terms](https://www.almamedia.fi/markkinapaikkaehdot/#etuovi-vuokraovi): using search robots or other technical tools to collect content, and building your own service or dataset from parts of the service, are forbidden without prior written consent |
| Oikotie Asunnot | `User-agent: * / Disallow: /` | [Oikotie terms](https://asunnot.oikotie.fi/sopimukset): regular, systematic or continuous collection, storage, indexing or distribution is not allowed without written permission |

Listings also contain personal data (agents, sellers), and the listing databases are protected as catalogues/databases under the Finnish Copyright Act.

**What the app does instead (legal):**
- **Address resolver** – a pasted listing address such as `Fredikanterassi 3 B 14, 00520 Helsinki` resolves to the right building. It strips staircase/apartment parts, keeps house letters (`19a`), expands ranges (`Porvoonkatu 20-22`) and uses secondary entrances from Ryhti. When an address is registered for several buildings, they are listed by distance to the city's official address point.
- **Parcel summary** – all buildings on the same property (kiinteistötunnus), their total floor area against the plot's building rights.
- **Asking-price check** – the user types the price and size of a listing they are viewing; the app compares €/m² with the StatFin average for the postal code and flat size. Nothing is sent or stored.
- A real listings feed would need a written data agreement with Alma Media or Oikotie (their partner interfaces are for business customers).

---

## 7. Known display limitations

The footprint data is exact. Visible offsets come from display, not from the data:
- **Leaflet rounds every vertex to whole screen pixels** (`latLngToLayerPoint`). One pixel is ≈ 1.19 m at zoom 16 and ≈ 0.30 m at zoom 18 in Helsinki. Small corners therefore look slightly off when zoomed out.
- Polygons are scaled during the zoom animation and redrawn when it ends.
- OSM tiles are upscaled above zoom 19.
- OSM buildings are volunteer-drawn, usually traced from roof outlines, and often merge a whole block into one shape. Use the Helsinki aerial photo or Kantakartta base map to compare against the same survey.

## 8. Run / update

```powershell
python scripts/build_data.py      # refresh data/pasila-data.js (~30 s)
python -m http.server 8000        # open http://localhost:8000
```

## 9. AI assistant panel (optional)

The *Assistant* button opens a side panel with an iframe (`#assistantFrame`, loaded lazily from `data-src="http://localhost:3000"`) that shows the agent's own Next.js chat UI. The agent (frontend, Express backend on port 4000, Ollama LLM, MCP servers for Ryhti, MML and Helsinki decisions) is in the [agent/](agent/) folder, taken from the branch `feature/helsinki-decisions`. Its keys go in `agent/.env` (git-ignored). See the README for setup.

**Map focus.** The agent UI posts each reply to the parent page:
```ts
window.parent?.postMessage({ type: "assistant:reply", text: data.reply }, "http://localhost:8000");
```
This is the only change made in the agent's code (marked `ADDED FOR PASILA INTELLIGENCE (map focus)` in `frontend/src/app/page.tsx`). Pasila accepts the message only when it comes from the iframe's window and origin, then matches the text against the official data only:

1. VTJ-PRT and property ID (kiinteistötunnus);
2. street addresses (all buildings at an address, narrowed when a VTJ-PRT is also named);
3. if no building matched: a street name, then a postal code area.

One building opens its panel (on narrow screens it is highlighted instead, so the assistant stays visible); several are highlighted in purple and fitted into view, with a bar naming what was matched. Sending a reply costs no LLM tokens: it is a browser message between two local pages.

**Tested end to end (2026-10-18)** with the live backend: "Which buildings are on Pasilankatu?" → 13 addresses listed → 13 buildings highlighted. Known limitation: matching is purely textual, so a reply that says an address was *not* found still highlights that address.
