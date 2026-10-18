"""
Build the static dataset for the Pasila app.

Fetches open data once for a fixed BBOX, joins it per building and writes
data/pasila-data.js (one global object), so the frontend needs no backend:
    python scripts/build_data.py

Only official open data with a verified licence is used, every source is CC BY 4.0:
  - Helsinki building footprints + register   kartta.hel.fi WFS  Rakennukset_alue_rekisteritiedot   (hri.fi: helsingin-rakennukset)
  - Helsinki protected buildings / plans      kartta.hel.fi WFS  Asemakaavoissa_suojellut..., Kaavahakemisto_*
  - Helsinki plan units (plot zoning)         kartta.hel.fi WFS  Kaavayksikot (permitted use, building rights)
  - Ryhti buildings, addresses, permits       paikkatiedot.ymparisto.fi OGC API Features  (Syke open data)
  - Prices of old dwellings by postal code    Statistics Finland PxWeb  StatFin/ashi/13mu
  - Postal code area statistics (Paavo)       Statistics Finland PxWeb  Postinumeroalueittainen_avoin_tieto/12f7
  - Events                                    Linked Events API (api.hel.fi)                    (hri.fi: linked-events-tapahtumarajapinta)
  - Traffic noise zones (2022 survey, Lden)   kartta.hel.fi WFS  Meluselvitys_2022_Helsinki_*_Lden  (hri.fi: helsingin-kaupungin-meluselvitys-2017)
  - Environmental permit facilities           kartta.hel.fi WFS  Ymparistolupakohteet               (hri.fi: helsingin-ymparistolupakohteet)
  - Official address points                   kartta.hel.fi WFS  Osoiteluettelo_piste_rekisteritiedot (hri.fi: helsingin-osoiteluettelo)
  - Postal code areas touching the BBOX       Statistics Finland WFS geo.stat.fi  postialue:pno_<year>
  - Flood hazard zones and mapped areas       Syke WFS  inspire_nz:NZ.Tulvavaaravyohykkeet_*, NZ.Tulvavaarakartoitetut_alueet_*
  - Sea level estimates at the shoreline      kartta.hel.fi WFS  FMI_Turvalliset_rakentamiskorkeudet_piste_2024
                                              (hri.fi: turvalliset-rakentamiskorkeudet-ja-suurin-arvioitu-merkitseva-aallonkorkeus-helsingissa)
  - Rescue stations                           Service Map API api.hel.fi/servicemap  (hri.fi: paakaupunkiseudun-palvelukartan-rest-rajapinta)
  - Classification of Buildings 2018          Statistics Finland classifications API (data.stat.fi)
  - Helsinki register code explanations       scripts/helsinki_building_codes.json (from the helsingin-rakennukset dataset)
  - Permit type labels (codes 01-05)          scripts/ryhti_permit_codes.json (from Syke's CC BY repo sykefi/rakennuskohteet)

Code-list labels from koodistot.suomi.fi are NOT used: the service publishes no licence for its content.
HSY's water-supply disruption map (ArcGIS Julkinen_Hairiokartta_katselu) publishes no licence either; it is used on
request, and only the fields below are requested (no contact fields).
STUK's indoor radon tables by postal code (workplaces, detached houses) are read from the tables on its web pages;
the pages state no licence. They are used on request and shown with STUK as the source.

The app is English-only. Official English labels are used wherever the source publishes them;
values without an official translation stay in Finnish and are listed at the end of the build
(input for a later machine-translation step). Footprint geometries are never modified.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

# [minLon, minLat, maxLon, maxLat] - Länsi-, Keski- and Itä-Pasila
BBOX = [24.915, 60.191, 24.950, 60.209]

ROOT = Path(__file__).resolve().parent.parent
HELSINKI_CODES = json.loads((Path(__file__).resolve().parent / "helsinki_building_codes.json").read_text(encoding="utf-8"))
PERMIT_CODES = json.loads((Path(__file__).resolve().parent / "ryhti_permit_codes.json").read_text(encoding="utf-8"))
OUT = ROOT / "data" / "pasila-data.js"
INDEX = ROOT / "index.html"

RYHTI = "https://paikkatiedot.ymparisto.fi/geoserver"
PXWEB = "https://pxdata.stat.fi/PxWeb/api/v1"

# Finnish values that have no official English label (filled during the build)
UNTRANSLATED = set()


def get_json(url, data=None, retries=3):
    """GET (or POST JSON) with retries on timeouts, 429 and 5xx."""
    body = json.dumps(data).encode() if data is not None else None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": "pasila-app/1.0"})
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500 or attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(2 ** attempt)


# ---------- Geometry helpers (lon/lat, small area so planar math is fine) ----------

def polygons_of(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []  # lines/points carry no area


def bounds_of(geom):
    xs = [c[0] for poly in polygons_of(geom) for c in poly[0]]
    ys = [c[1] for poly in polygons_of(geom) for c in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geom(x, y, geom):
    for poly in polygons_of(geom):
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, hole) for hole in poly[1:]):
            return True
    return False


def centroid(geom):
    """Area-weighted centroid of all exterior rings."""
    sx = sy = sa = 0.0
    for poly in polygons_of(geom):
        ring = poly[0]
        for i in range(len(ring) - 1):
            x0, y0 = ring[i][0], ring[i][1]
            x1, y1 = ring[i + 1][0], ring[i + 1][1]
            cross = x0 * y1 - x1 * y0
            sa += cross
            sx += (x0 + x1) * cross
            sy += (y0 + y1) * cross
    if abs(sa) < 1e-15:
        pt = polygons_of(geom)[0][0][0]
        return pt[0], pt[1]
    return sx / (3 * sa), sy / (3 * sa)


def in_bbox(x, y):
    return BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3]


def _segments_cross(a, b, c, d):
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (orient(a, b, c) > 0) != (orient(a, b, d) > 0) and (orient(c, d, a) > 0) != (orient(c, d, b) > 0)


class EdgeIndex:
    """Edges of a large (Multi)Polygon bucketed into latitude rows, for fast tests against small footprints."""
    ROW = 0.0002  # degrees of latitude (about 22 m)

    def __init__(self, geom):
        self.geom = geom
        self.bounds = bounds_of(geom)
        self.rows = {}
        for poly in polygons_of(geom):
            for r in poly:
                for i in range(len(r) - 1):
                    a, b = r[i], r[i + 1]
                    for row in range(int(min(a[1], b[1]) / self.ROW), int(max(a[1], b[1]) / self.ROW) + 1):
                        self.rows.setdefault(row, []).append((a, b))

    def edges_near(self, x0, y0, x1, y1):
        seen = set()
        for row in range(int(y0 / self.ROW), int(y1 / self.ROW) + 1):
            for e in self.rows.get(row, ()):
                a, b = e
                if id(e) in seen or max(a[0], b[0]) < x0 or min(a[0], b[0]) > x1 \
                        or max(a[1], b[1]) < y0 or min(a[1], b[1]) > y1:
                    continue
                seen.add(id(e))
                yield a, b

    def contains(self, x, y):
        """Ray casting over the edges in the point's row (all rings, so holes are respected)."""
        inside = False
        for a, b in self.rows.get(int(y / self.ROW), ()):
            if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
        return inside


def intersects_indexed(geom, zone):
    """True if a small (Multi)Polygon overlaps the indexed zone polygon (holes respected)."""
    x0, y0, x1, y1 = bounds_of(geom)
    zx0, zy0, zx1, zy1 = zone.bounds
    if x1 < zx0 or x0 > zx1 or y1 < zy0 or y0 > zy1:
        return False
    edges = [(r[i], r[i + 1]) for poly in polygons_of(geom) for r in poly for i in range(len(r) - 1)]
    for c, d in zone.edges_near(x0, y0, x1, y1):
        if point_in_geom(c[0], c[1], geom) or any(_segments_cross(a, b, c, d) for a, b in edges):
            return True
    # No boundary contact: the footprint lies wholly inside or wholly outside the zone
    v = edges[0][0]
    return zone.contains(v[0], v[1])


M_PER_DEG_LAT = 110574
M_PER_DEG_LON = 111320 * 0.4977  # cos(60.2°): planar metres are accurate to <1% inside the BBOX


def distance_m(x, y, geom):
    """Distance in metres from a point to a polygon (0 if the point is inside)."""
    if point_in_geom(x, y, geom):
        return 0
    best = float("inf")
    for poly in polygons_of(geom):
        for r in poly:
            for i in range(len(r) - 1):
                ax, ay = (r[i][0] - x) * M_PER_DEG_LON, (r[i][1] - y) * M_PER_DEG_LAT
                bx, by = (r[i + 1][0] - x) * M_PER_DEG_LON, (r[i + 1][1] - y) * M_PER_DEG_LAT
                dx, dy = bx - ax, by - ay
                t = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0
                best = min(best, ((ax + t * dx) ** 2 + (ay + t * dy) ** 2) ** 0.5)
    return best


# ---------- Labels ----------

_codelists = {}  # (source, scheme) -> {code: {"fi": ..., "en": ...}}

BUILDING_CLASSIFICATION = "rakennus_1_20180712"  # Classification of Buildings 2018, Statistics Finland


def load_building_classification():
    """Classification of Buildings 2018 (fi + en) from the Statistics Finland classifications API."""
    labels = {}
    for lang in ("fi", "en"):
        url = (f"https://data.stat.fi/api/classifications/v2/classifications/{BUILDING_CLASSIFICATION}"
               f"/classificationItems?content=data&meta=max&lang={lang}&format=json")
        try:
            for item in get_json(url):
                labels.setdefault(item["code"], {})[lang] = item["classificationItemNames"][0]["name"]
        except Exception as e:  # labels are optional
            print("  building classification failed", lang, e)
    _codelists[("statfi", BUILDING_CLASSIFICATION)] = labels


def english(fi, en=None):
    """Official English label if available, otherwise the Finnish value (recorded for translation)."""
    if en:
        return en
    if fi:
        UNTRANSLATED.add(fi)
    return fi


def helsinki_code(scheme, code):
    """Helsinki register code -> Finnish label from the dataset's code explanations."""
    return english(HELSINKI_CODES[scheme].get(str(code))) if code else None


def building_class(code, fallback_fi):
    """Helsinki c_rakennusluokka -> Classification of Buildings 2018 label."""
    label = _codelists.get(("statfi", BUILDING_CLASSIFICATION), {}).get(code or "")
    return english(label.get("fi"), label.get("en")) if label else english(fallback_fi)


# ---------- Fetchers ----------

def fetch_wfs(layer, bbox=BBOX, base="https://kartta.hel.fi/ws/geoserver/avoindata/wfs", namespace="avoindata"):
    minx, miny, maxx, maxy = bbox
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeName": f"{namespace}:{layer}", "outputFormat": "application/json", "srsName": "EPSG:4326",
        # WFS 2.0 with EPSG:4326 uses lat,lon axis order
        "bbox": f"{miny},{minx},{maxy},{maxx},urn:ogc:def:crs:EPSG::4326",
    }
    return get_json(f"{base}?" + urllib.parse.urlencode(params))["features"]


def widened(bbox, margin_m):
    return [bbox[0] - margin_m / M_PER_DEG_LON, bbox[1] - margin_m / M_PER_DEG_LAT,
            bbox[2] + margin_m / M_PER_DEG_LON, bbox[3] + margin_m / M_PER_DEG_LAT]


def fetch_postal_areas():
    """Postal code areas (Statistics Finland) that touch the BBOX, from the newest published year."""
    for year in range(date.today().year, date.today().year - 3, -1):
        try:
            feats = fetch_wfs(f"pno_{year}", base="https://geo.stat.fi/geoserver/postialue/wfs", namespace="postialue")
        except urllib.error.HTTPError:
            continue
        if feats:
            return {"year": year, "names": {f["properties"]["posti_alue"]: f["properties"]["nimi"] for f in feats}}
    raise RuntimeError("no postal code area layer found")


# ---------- Flood hazard (Syke) ----------

SYKE_WFS = "https://paikkatiedot.ymparisto.fi/geoserver/inspire_nz/wfs"
FLOOD_KINDS = {"sea": "Meritulva", "river": "Vesistotulva"}
FLOOD_RETURN_PERIODS = [2, 5, 10, 20, 50, 100, 250, 1000]  # published scenarios, once in N years


def fetch_syke(layer, cql=None, page=500):
    """All features of a Syke flood layer inside the BBOX (paged; an optional CQL condition is added)."""
    minx, miny, maxx, maxy = BBOX
    flt = f"BBOX(geom,{miny},{minx},{maxy},{maxx},'urn:ogc:def:crs:EPSG::4326')"
    out, start = [], 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"inspire_nz:{layer}",
                  "outputFormat": "application/json", "srsName": "EPSG:4326", "count": page, "startIndex": start,
                  "sortBy": "objectid", "CQL_FILTER": f"{cql} AND {flt}" if cql else flt}
        feats = get_json(f"{SYKE_WFS}?{urllib.parse.urlencode(params)}")["features"]
        out += feats
        if len(feats) < page:
            return out
        start += page


def fetch_flood():
    """Flood hazard zones with a water depth (depth classes 1-98; 0 is dry land, 99 a water body) per scenario,
    and the areas Syke has mapped, for sea and river floods."""
    zones = {(kind, rp): fetch_syke(f"NZ.Tulvavaaravyohykkeet_{layer}_1_{rp}a",
                                    "syvsuojluokka_id >= 1 AND syvsuojluokka_id <= 98")
             for kind, layer in FLOOD_KINDS.items() for rp in FLOOD_RETURN_PERIODS}
    mapped = {kind: fetch_syke(f"NZ.Tulvavaarakartoitetut_alueet_{layer}") for kind, layer in FLOOD_KINDS.items()}
    return {"zones": zones, "mapped": mapped}


# ---------- Rescue stations (Service Map) ----------

def fetch_rescue_stations():
    """Units of the Service Map service 'rescue stations' (501) that are stations and have a location."""
    url = ("https://api.hel.fi/servicemap/v2/unit/?service=501&page_size=100"
           "&only=name,location,street_address,municipality")
    out = []
    while url:
        page = get_json(url)
        out += [u for u in page["results"] if u.get("location") and "asema" in (u.get("name") or {}).get("fi", "")]
        url = page.get("next")
    return out


# ---------- Indoor radon (STUK) ----------

STUK_RADON = {
    "workplaces": "https://stuk.fi/hae-tyopaikkojen-radonmittaustuloksia-postinumeroalueittain",
    "houses": "https://stuk.fi/pientalojen-radonpitoisuudet-postinumeroalueittain",
}


def html_table(page):
    """First <table> of an HTML page -> list of {header: cell text}."""
    import html as htmllib
    table = re.search(r"<table.*?</table>", page, re.S).group()
    rows = [[htmllib.unescape(re.sub(r"<[^>]+>", "", c)).strip()
             for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)] for r in re.findall(r"<tr.*?</tr>", table, re.S)]
    header = [h.split("  ")[0].strip() for h in rows[0]]  # drop the "Järjestä taulukko ..." sort hint
    return [dict(zip(header, r)) for r in rows[1:] if r]


def radon_key(header):
    """STUK column header -> key ('Mediaani Bq/m3' -> 'median', '300 Bq/m3 ylitykset %' -> 'over300')."""
    if header.startswith("Mitattuja"):
        return "measured"
    if header.startswith("Keskiarvo"):
        return "mean"
    if header.startswith("Mediaani"):
        return "median"
    m = re.match(r"(\d+) Bq/m3 ylitykset", header)
    return f"over{m.group(1)}" if m else None


def fetch_radon(postal_codes):
    """STUK indoor radon tables by postal code; areas below STUK's publication threshold are absent."""
    out = {}
    for kind, url in STUK_RADON.items():
        req = urllib.request.Request(url, headers={"User-Agent": "pasila-app/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            rows = html_table(r.read().decode("utf-8"))
        by_postal = {}
        for row in rows:
            code = row.get("Postinumero")
            if code in postal_codes:
                by_postal[code] = {radon_key(k): (float(v) if v else None) for k, v in row.items() if radon_key(k)}
        out[kind] = {"url": url, "byPostal": by_postal}
    return out


# Noise zones of the City of Helsinki noise survey 2022 (Lden, day-evening-night level)
NOISE_LAYERS = {
    "road": "Meluselvitys_2022_Helsinki_kadut_ja_maantiet_Lden",
    "rail": "Meluselvitys_2022_Helsinki_rautatiet_Lden",
    "tram": "Meluselvitys_2022_Helsinki_raitiotie_Lden",
}

# Environmental permit facilities are fetched this far beyond the BBOX, so the nearest one found
# for a building is the true nearest whenever it lies within this distance
PERMIT_SITE_RADIUS_M = 1000
PERMIT_SITE_BBOX = [BBOX[0] - PERMIT_SITE_RADIUS_M / M_PER_DEG_LON, BBOX[1] - PERMIT_SITE_RADIUS_M / M_PER_DEG_LAT,
                    BBOX[2] + PERMIT_SITE_RADIUS_M / M_PER_DEG_LON, BBOX[3] + PERMIT_SITE_RADIUS_M / M_PER_DEG_LAT]


# Address points are fetched this far beyond the BBOX, so a building near the edge still finds its address point
ADDRESS_POINT_BBOX = widened(BBOX, 1000)
# FMI's sea level estimates are points on the shoreline; this margin reaches the nearest shore from every building
SEA_LEVEL_BBOX = widened(BBOX, 3000)


HSY_DISRUPTIONS = ("https://services-eu1.arcgis.com/EKC1wtqlKQ2dy1HY/arcgis/rest/services/"
                   "Julkinen_Hairiokartta_katselu/FeatureServer/0/query")


def fetch_water_disruptions():
    """HSY water-supply disruption areas intersecting the BBOX, as GeoJSON-like polygons (WGS84)."""
    minx, miny, maxx, maxy = BBOX
    params = {
        "geometry": json.dumps({"xmin": minx, "ymin": miny, "xmax": maxx, "ymax": maxy, "spatialReference": {"wkid": 4326}}),
        "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects",
        "inSR": "4326", "outSR": "4326", "outFields": "OBJECTID,tyyppi,alkuaika,loppuaika,nimi,asukkaat", "f": "json",
    }
    data = get_json(f"{HSY_DISRUPTIONS}?{urllib.parse.urlencode(params)}")
    return [{"geometry": {"type": "Polygon", "coordinates": f["geometry"]["rings"]}, "properties": f["attributes"]}
            for f in data.get("features", []) if f.get("geometry", {}).get("rings")]


def fetch_ogc(path):
    """All items of an OGC API Features collection inside BBOX (follows 'next' links)."""
    url = f"{RYHTI}/{path}/items?bbox={','.join(map(str, BBOX))}&limit=2000&f=json"
    out = []
    while url:
        page = get_json(url)
        out += page["features"]
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
    return out


def pxweb(path, query, lang="en"):
    """POST a PxWeb query; returns (labels per dimension, list of (record, value), categories)."""
    js = get_json(f"{PXWEB}/{lang}/{path}", {"query": query, "response": {"format": "json-stat2"}})
    dims, sizes = js["id"], js["size"]
    cats = [list(js["dimension"][d]["category"]["index"].keys()) for d in dims]
    labels = {d: js["dimension"][d]["category"].get("label", {}) for d in dims}
    rows = []
    for i, v in enumerate(js["value"]):  # json-stat2 is row-major over dims
        idx, rem = [], i
        for s in reversed(sizes):
            idx.append(rem % s)
            rem //= s
        idx.reverse()
        rows.append(({d: cats[k][idx[k]] for k, d in enumerate(dims)}, v))
    return labels, rows, dict(zip(dims, cats))


def fetch_prices(postal_codes):
    meta = get_json(f"{PXWEB}/en/StatFin/ashi/13mu.px")
    published = next(v["values"] for v in meta["variables"] if v["code"] == "postinumeroalue_4_20220101")
    labels, rows, cats = pxweb("StatFin/ashi/13mu.px", [
        {"code": "postinumeroalue_4_20220101",
         "selection": {"filter": "item", "values": [pc for pc in postal_codes if pc in published]}},
        {"code": "talotyyppi_6_20131021", "selection": {"filter": "item", "values": ["1", "2", "3"]}},
    ])
    result = {}
    for rec, v in rows:
        series = result.setdefault(rec["postinumeroalue_4_20220101"], {}) \
                       .setdefault(rec["talotyyppi_6_20131021"], {"price": {}, "count": {}})
        series["price" if rec["contentscode"].startswith("keskihinta") else "count"][rec["timeperiod_y"]] = v
    return {"years": cats["timeperiod_y"],
            "types": {k: labels["talotyyppi_6_20131021"][k] for k in cats["talotyyppi_6_20131021"]},
            "byPostal": result}


PAAVO_FIELDS = ["he_vakiy", "he_kika", "hr_mtu", "tr_kuty", "tr_ktu", "tr_mtu", "tr_pi_tul", "tr_ke_tul", "tr_hy_tul",
                "te_taly", "te_takk", "te_as_valj", "te_yks",
                "te_laps", "te_omis_as", "te_vuok_as", "ra_asunn", "ra_as_kpa", "ra_kt_as", "ra_raky"]


def fetch_paavo(postal_codes):
    path = "Postinumeroalueittainen_avoin_tieto/uusin/12f7.px"
    meta = get_json(f"{PXWEB}/en/{path}")
    var = {v["code"]: v for v in meta["variables"]}
    pc_code = next(c for c in var if c.startswith("postinumeroalue"))
    labels = dict(zip(var["contentscode"]["values"], var["contentscode"]["valueTexts"]))
    year = var["timeperiod_y"]["values"][-1]
    available = [pc for pc in postal_codes if pc in var[pc_code]["values"]]
    _, rows, _ = pxweb(path, [
        {"code": pc_code, "selection": {"filter": "item", "values": available}},
        {"code": "timeperiod_y", "selection": {"filter": "item", "values": [year]}},
        {"code": "contentscode", "selection": {"filter": "item", "values": PAAVO_FIELDS}},
    ])
    names = dict(zip(var[pc_code]["values"], var[pc_code]["valueTexts"]))  # place names, not translated
    by_postal = {}
    for rec, v in rows:
        pc = rec[pc_code]
        by_postal.setdefault(pc, {"name": names[pc].split("  ", 1)[-1], "values": {}})["values"][rec["contentscode"]] = v
    return {"year": year, "labels": {k: labels[k] for k in PAAVO_FIELDS}, "byPostal": by_postal}


def fetch_events(max_pages=20):
    """Upcoming events in the BBOX, all pages, recurring sub-events collapsed into their series."""
    url = "https://api.hel.fi/linkedevents/v1/event/?" + urllib.parse.urlencode({
        "bbox": ",".join(map(str, BBOX)), "start": "today", "page_size": 100, "include": "location",
        "sort": "start_time", "hide_recurring_children": "true"})
    events, seen = [], set()
    for _ in range(max_pages):
        page = get_json(url)
        for e in page["data"]:
            loc = e.get("location") or {}
            pos = loc.get("position")
            if not pos or e["id"] in seen:
                continue
            seen.add(e["id"])
            name, place = e.get("name") or {}, loc.get("name") or {}
            events.append({
                "name": name.get("en") or english(name.get("fi") or name.get("sv")),
                "start": e.get("start_time"),
                "end": e.get("end_time"),
                "place": place.get("en") or place.get("fi"),
                "lon": pos["coordinates"][0], "lat": pos["coordinates"][1],
                "url": f"https://tapahtumat.hel.fi/en/events/{e['id']}",
            })
        url = page["meta"].get("next")
        if not url:
            break
    return events


# ---------- Join ----------

def d10(s):
    return s[:10] if s else None


def parse_plan_approval(text):
    """'12.09.2018' or 'kylk 14.5.2024' -> ('2018-09-12', None) / ('2024-05-14', 'kylk'); 'Vireillä' -> (None, None)."""
    m = re.match(r"^\s*([^\d]*?)\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$", text or "")
    if not m:
        return None, None
    body, dd, mm, yyyy = m.groups()
    return f"{yyyy}-{int(mm):02d}-{int(dd):02d}", body or None


def prune(obj):
    """Drop None values and empty lists/dicts to keep the data file small."""
    if isinstance(obj, dict):
        return {k: prune(v) for k, v in obj.items() if v is not None and v != [] and v != {}}
    if isinstance(obj, list):
        return [prune(v) for v in obj]
    return obj


def plot_key(property_id):
    """'091-017-0105-0006' or '09101701050006' -> '09101701050006'."""
    return "".join(ch for ch in (property_id or "") if ch.isdigit()) or None


def property_label(property_id):
    """'09101700260001' or '091-017-0026-0001' -> '091-017-0026-0001'."""
    k = plot_key(property_id)
    return f"{k[:3]}-{k[3:6]}-{k[6:10]}-{k[10:]}" if k and len(k) == 14 else property_id


def norm_address(a):
    return " ".join((a or "").split()).lower()


def plot_info(p):
    use = p.get("kayttotarkoitusluokka") or ""
    code = p.get("kayttotarkoitusluokka_koodi")
    return prune({
        "id": p.get("kaavayksikkotunnus"),
        "plan": p.get("kaavatunnus"),
        "useCode": code,
        "use": english(use[len(code):].strip() if code and use.startswith(code) else use) or None,
        "buildingRights": p.get("rakennusoikeus"),
        "areaM2": p.get("rekisteriala"),
    })


def build(footprints, ryhti, addresses, permits, protected, plans, plots, noise, permit_sites, water, address_points,
          hazards):
    ryhti_by_vtj = {f["properties"]["permanent_building_identifier"]: f for f in ryhti}
    ryhti_points = [(k, *f["geometry"]["coordinates"]) for k, f in ryhti_by_vtj.items()]
    addr_by_key = {}
    for a in addresses:
        p = a["properties"]
        addr_by_key.setdefault(p["building_key"], []).append(p)

    permits_by_vtj = {}
    for f in permits:
        p = f["properties"]
        type_code = (p.get("construction_action_type") or "").rsplit("/", 1)[-1] or None
        type_label = PERMIT_CODES["RakentamistoimenpiteenLaji"].get(type_code or "")
        permits_by_vtj.setdefault(p["permanent_building_identifier"], []).append({
            "typeCode": type_code,
            "type": english(type_label) if type_label else None,
            "decision": d10(p["decision_date"]), "start": d10(p["start_date"]),
            "completed": d10(p["completion_date"]), "expires": d10(p.get("expiry_date")),
            "extensionDecision": p.get("construction_to_be_completed_by_extension"),
            "permitId": p["permanent_permit_identifier"], "dvvId": p.get("dvv_permit_identifier"),
            # Building data as stated in the permit
            "storeys": p.get("number_of_storeys") or None,
            "apartments": p.get("apartment_count") or None,
            "grossFloorArea": p.get("gross_floor_area") or None,
            "floorArea": p.get("floor_area") or None,
            "totalArea": p.get("total_area") or None,
            "volume": p.get("volume") or None,
        })

    protected_by_ratu = {}
    for f in protected:
        p = f["properties"]
        if p.get("pys_raknro"):
            protected_by_ratu[str(p["pys_raknro"])] = {"plan": p.get("kaava"), "mark": p.get("s_merk"),
                                                       "since": d10(p.get("voimaantulo_pvm"))}

    plan_items = [(bounds_of(pl["geometry"]), pl) for pl in plans if polygons_of(pl["geometry"])]

    # Plan units (plots) currently in force, linked only by plot id = property id (no spatial guessing)
    plots_valid = [pl for pl in plots if pl["properties"].get("luokka") == "Voimassa" and polygons_of(pl["geometry"])]
    plot_by_id = {pl["properties"]["kaavayksikkotunnus"]: pl["properties"] for pl in plots_valid}
    plans_used = {}  # plan id -> details + boundary (stored once, buildings reference the id)

    stats = {"register": 0, "spatial": 0, "verified": 0, "mismatch": 0, "context": 0}

    def ryhti_or(ryhti_value, helsinki_value):
        """Ryhti wins; Ryhti publishes 0 for unknown storeys/areas/volume, so 0 falls back to the Helsinki register."""
        return ryhti_value if ryhti_value not in (None, 0, "") else helsinki_value

    # Official address points (several points can carry the same address, e.g. a square)
    points_by_address = {}
    for a in address_points:
        if (a.get("geometry") or {}).get("type") == "Point":
            points_by_address.setdefault(norm_address(a["properties"].get("katuosoite")), []) \
                .append(a["geometry"]["coordinates"][:2])

    def address_point_m(addresses, parts):
        """Registered address -> metres from the building's footprints to its official address point."""
        out = {}
        for a in addresses:
            pts = points_by_address.get(norm_address(a))
            if a and pts:
                out[a] = round(min(distance_m(x, y, part["geometry"]) for x, y in pts for part in parts))
        return out

    # 1) Decide which building (VTJ-PRT) each footprint belongs to
    groups, context, verified = {}, [], set()
    for f in footprints:
        h = f["properties"]
        geom = f["geometry"]
        vtj = h.get("vtj_prt") or h.get("c_vtj_prt")
        x0, y0, x1, y1 = bounds_of(geom)
        inside = [k for k, x, y in ryhti_points
                  if x0 <= x <= x1 and y0 <= y <= y1 and point_in_geom(x, y, geom)]
        if vtj:
            stats["register"] += 1
            if vtj in inside:
                stats["verified"] += 1
                verified.add(vtj)
            elif vtj in ryhti_by_vtj:
                stats["mismatch"] += 1
        elif len(inside) == 1:
            # Footprint without register link: the Ryhti building point lies inside it
            vtj = inside[0]
            stats["spatial"] += 1
            verified.add(vtj)
        if not vtj:
            context.append(f)
            continue
        groups.setdefault(vtj, []).append(f)

    # Noise: per layer, the highest published Lden zone that any footprint of the building touches
    noise_zones = {kind: [(EdgeIndex(z["geometry"]), z["properties"])
                          for z in sorted(zs, key=lambda z: -(z["properties"].get("db_lo") or 0))
                          if polygons_of(z["geometry"])]
                   for kind, zs in noise.items()}

    def noise_of(parts):
        out = {}
        for kind, zones in noise_zones.items():
            hit = next((zp for zone, zp in zones if any(intersects_indexed(p["geometry"], zone) for p in parts)), None)
            if hit:
                out[kind] = [hit.get("db_lo"), hit.get("db_hi")]
        return out

    # Nearest environmental permit facility, measured from the footprint edge
    sites = [s for s in permit_sites if (s.get("geometry") or {}).get("type") == "Point"]
    sites_used = {}

    def permit_site_of(parts):
        best = None
        for site in sites:
            x, y = site["geometry"]["coordinates"][:2]
            d = min(distance_m(x, y, part["geometry"]) for part in parts)
            if best is None or d < best[0]:
                best = (d, site)
        if not best or best[0] > PERMIT_SITE_RADIUS_M:
            return None
        sp = best[1]["properties"]
        sid = str(sp["id"])
        if sid not in sites_used:
            sites_used[sid] = prune({
                "name": sp.get("nimi"), "address": sp.get("katuosoite"), "postOffice": sp.get("postitoimipaikka"),
                "activity": english(sp.get("toiminnan_luokittelun_tarkenne")),
                "updated": d10(sp.get("paivitetty_tietopalveluun")),
                "lonlat": [round(c, 6) for c in best[1]["geometry"]["coordinates"][:2]],
            })
        return {"id": sid, "m": round(best[0])}

    # HSY water-supply disruption areas that any footprint of the building touches
    water_zones = [(EdgeIndex(w["geometry"]), w["properties"]) for w in water]
    water_used = {}

    def water_of(parts):
        ids = []
        for zone, wp in water_zones:
            if any(intersects_indexed(p["geometry"], zone) for p in parts):
                wid = str(wp["OBJECTID"])
                water_used.setdefault(wid, {"area": wp.get("nimi"), "start": wp.get("alkuaika"),
                                            "end": wp.get("loppuaika"), "residents": wp.get("asukkaat"),
                                            "type": wp.get("tyyppi")})
                ids.append(wid)
        return sorted(ids, key=lambda i: water_used[i]["start"] or 0, reverse=True)

    # Syke flood hazard: per kind, whether the building lies in a mapped area and the most frequent scenario
    # whose flooded zone touches a footprint, with the deepest depth class touched
    flood_zones = {key: [(EdgeIndex(z["geometry"]), z["properties"]) for z in zs if polygons_of(z["geometry"])]
                   for key, zs in hazards["flood"]["zones"].items()}
    flood_mapped = {kind: [(EdgeIndex(a["geometry"]), a["properties"].get("nimi")) for a in areas
                           if polygons_of(a["geometry"])] for kind, areas in hazards["flood"]["mapped"].items()}
    flood_maps_used = {}

    def flood_of(parts):
        touches = lambda zone: any(intersects_indexed(p["geometry"], zone) for p in parts)
        out = {}
        for kind in FLOOD_KINDS:
            maps = [name for zone, name in flood_mapped[kind] if touches(zone)]
            if not maps:
                continue  # no flood hazard map covers the building
            flood_maps_used.setdefault(kind, set()).update(maps)
            out[kind] = {"returnPeriod": None}
            for rp in FLOOD_RETURN_PERIODS:
                hit = [zp for zone, zp in flood_zones[(kind, rp)] if touches(zone)]
                if hit:
                    deepest = max(hit, key=lambda zp: zp["syvsuojluokka_id"])
                    out[kind] = {"returnPeriod": rp, "depth": deepest["syvsuojluokka"]}
                    break
        return out

    # Nearest point of a point layer, measured from the footprint edge
    def nearest(points, parts):
        best = min(((min(distance_m(*pt["geometry"]["coordinates"][:2], part["geometry"]) for part in parts), pt)
                    for pt in points), key=lambda b: b[0], default=None)
        return best

    sea_points = [pt for pt in hazards["seaLevel"] if (pt.get("geometry") or {}).get("type") == "Point"]
    sea_used = {}

    def sea_level_of(parts):
        best = nearest(sea_points, parts)
        if not best:
            return None
        sp = best[1]["properties"]
        sid = str(sp["id"])
        sea_used.setdefault(sid, prune({
            "y2020": sp.get("arvio_vuodelle_2020"), "y2050": sp.get("arvio_vuodelle_2050"),
            "y2100": sp.get("arvio_vuodelle_2100"), "measured": sp.get("mittauspiste"),
            "updated": d10(sp.get("paivitetty_tietopalveluun")),
            "lonlat": [round(c, 6) for c in best[1]["geometry"]["coordinates"][:2]]}))
        return {"id": sid, "m": round(best[0])}

    stations = [{"geometry": u["location"], "unit": u} for u in hazards["rescue"]]
    stations_used = {}

    def rescue_of(parts):
        best = nearest(stations, parts)
        if not best:
            return None
        u = best[1]["unit"]
        uid = str(u["id"])
        stations_used.setdefault(uid, prune({
            "name": u["name"].get("en") or u["name"].get("fi"),
            "address": (u.get("street_address") or {}).get("fi"),
            "lonlat": [round(c, 6) for c in u["location"]["coordinates"][:2]]}))
        return {"id": uid, "m": round(best[0])}

    # 2) Building attributes per VTJ-PRT. Footprint geometries are passed through exactly as
    #    published by the City of Helsinki: one feature per footprint, never merged or rounded.
    features = []
    for vtj, parts in groups.items():
        r = ryhti_by_vtj.get(vtj)
        rp = r["properties"] if r else {}
        anchor = next((r["geometry"]["coordinates"] for p in parts
                       if r and point_in_geom(*r["geometry"]["coordinates"], p["geometry"])), None) \
            or centroid(parts[0]["geometry"])
        if not in_bbox(*anchor):
            continue
        # The register part that carries the attributes (largest floor area wins)
        h = max((p["properties"] for p in parts), key=lambda p: p.get("i_kerrosala") or 0)
        # Addresses: Ryhti first (its first address is the main one), the Helsinki register address is kept too
        ryhti_addr = sorted(addr_by_key.get(rp.get("building_key"), []), key=lambda a: a.get("address_number") or 99)
        helsinki_address = f"{h['katunimi_suomi']} {h.get('osoitenumero') or ''}".strip() \
            if h.get("katunimi_suomi") else None
        addresses = list(dict.fromkeys(a for a in [*(a["address_fin"].strip() for a in ryhti_addr), helsinki_address] if a))
        address = addresses[0] if addresses else None
        postal = ryhti_addr[0]["postal_code"] if ryhti_addr else h.get("postinumero")
        ratu = str(h.get("ratu") or "")

        plans_here = []
        for (px0, py0, px1, py1), pl in plan_items:
            if px0 <= anchor[0] <= px1 and py0 <= anchor[1] <= py1 and point_in_geom(anchor[0], anchor[1], pl["geometry"]):
                p = pl["properties"]
                pid = p.get("kaavatunnus")
                if pid not in plans_used:
                    approved, approved_by = parse_plan_approval(p.get("hyvaksymispvm"))
                    plans_used[pid] = prune({
                        "id": pid, "status": english(p.get("luokka")),
                        "approved": approved, "approvedBy": english(approved_by),
                        "confirmed": d10(p.get("vahvistamispvm")),
                        "legallyValid": d10(p.get("lainvoimaisuuspvm")),
                        "inForce": d10(p.get("voimaantulopvm")),
                        "areaM2": round(p["pintaala"]) if p.get("pintaala") else None,
                        "updated": d10(p.get("muokkauspvm")),
                        "geometry": pl["geometry"],  # boundary as published, drawn when the plan is opened
                    })
                plans_here.append(pid)

        # Plot zoning: the plan unit whose id equals the building's property id
        property_id = property_label(ryhti_or(rp.get("property_identifier"), h.get("c_kiinteistotunnus")))
        plot = plot_by_id.get(plot_key(property_id))

        # Register values: Ryhti first, the Helsinki register fills what Ryhti lacks. Class, elevator, energy,
        # heating, material, facade and connections come from Helsinki: Ryhti gives those only as koodistot.suomi.fi
        # codes, whose labels are not licensed.
        props = {
            "id": vtj,
            "vtj": vtj,
            "footprintId": None,  # set per part below
            "address": address,
            "otherAddresses": addresses[1:5],
            "addressPointM": address_point_m(addresses[:5], parts),
            "postalCode": postal,
            "class": building_class(h.get("c_rakennusluokka"), h.get("tyyppi")),
            "completed": d10(rp.get("completion_date")) or d10(h.get("c_valmpvm")),
            "storeys": ryhti_or(rp.get("number_of_storeys"), h.get("i_kerrlkm")),
            "apartments": rp["apartment_count"] if rp.get("apartment_count") is not None
                          else h.get("i_asuinhuoneistojen_lkm") or 0,
            "floorArea": ryhti_or(rp.get("gross_floor_area"), h.get("i_kerrosala")),
            "totalArea": ryhti_or(rp.get("total_area"), h.get("i_kokala")),
            "volume": ryhti_or(rp.get("volume"), h.get("i_raktilav")),
            "elevator": h.get("c_hissi") == "x" if h.get("c_hissi") is not None else None,
            "propertyId": property_id,
            "energy": helsinki_code("RA_LAMMONLAHDE", h.get("c_poltaine")),
            "heating": helsinki_code("RA_LAMMITYSTAPA", h.get("c_lammtapa")),
            # Register flags are "x" when a connection is recorded; an empty flag means "not recorded", not "none"
            "connections": [name for name, key in (("Water", "c_vesilii"), ("Sewer", "c_viemlii"),
                                                   ("Electricity", "c_sahkolii")) if h.get(key) == "x"],
            "structure": helsinki_code("RA_KANTRAKAINE", h.get("c_rakeaine")),
            "facade": helsinki_code("RA_JULKISIVUMAT", h.get("c_julkisivu")),
            "protection": protected_by_ratu.get(ratu),
            "plot": plot_info(plot) if plot else None,
            "plans": sorted(plans_here, key=lambda i: plans_used[i].get("inForce") or "9999", reverse=True),
            "history": sorted(permits_by_vtj.get(vtj, []), key=lambda x: x["decision"] or x["start"] or "", reverse=True),
            "noise": noise_of(parts),
            "permitSite": permit_site_of(parts),
            "water": water_of(parts),
            "flood": flood_of(parts),
            "seaLevelPoint": sea_level_of(parts),
            "rescueStation": rescue_of(parts),
        }
        for part in parts:
            features.append({"type": "Feature", "geometry": part["geometry"],
                             "properties": prune({**props, "footprintId": part["properties"]["id"]})})

    # 3) Footprints that cannot be tied to any building record: drawn as non-clickable context
    context_feats = []
    for f in context:
        if in_bbox(*centroid(f["geometry"])):
            stats["context"] += 1
            context_feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {}})
    hazard_refs = {"floodMaps": {k: sorted(v) for k, v in flood_maps_used.items()},
                   "seaLevelPoints": sea_used, "rescueStations": stations_used}
    return features, context_feats, plans_used, sites_used, water_used, hazard_refs, stats


def main():
    # Finnish names in the log must not crash a console with a legacy code page (e.g. cp1252 on Windows)
    sys.stdout.reconfigure(errors="replace")
    started = time.time()
    print("BBOX", BBOX)
    steps = {
        "footprints": lambda: fetch_wfs("Rakennukset_alue_rekisteritiedot"),
        "protected": lambda: fetch_wfs("Asemakaavoissa_suojellut_rakennukset_alue"),
        "plans in force": lambda: fetch_wfs("Kaavahakemisto_alue_kaava_voimassa"),
        "plans pending": lambda: fetch_wfs("Kaavahakemisto_alue_kaava_vireilla"),
        "plan units": lambda: fetch_wfs("Kaavayksikot"),
        **{f"noise {k}": (lambda layer=layer: fetch_wfs(layer)) for k, layer in NOISE_LAYERS.items()},
        "permit sites": lambda: fetch_wfs("Ymparistolupakohteet", PERMIT_SITE_BBOX),
        "water disruptions": fetch_water_disruptions,
        "address points": lambda: fetch_wfs("Osoiteluettelo_piste_rekisteritiedot", ADDRESS_POINT_BBOX),
        "postal areas": fetch_postal_areas,
        "flood": fetch_flood,
        "sea level points": lambda: fetch_wfs("FMI_Turvalliset_rakentamiskorkeudet_piste_2024", SEA_LEVEL_BBOX),
        "rescue stations": fetch_rescue_stations,
        "ryhti buildings": lambda: fetch_ogc("ryhti_building/ogc/features/v1/collections/open_building"),
        "ryhti addresses": lambda: fetch_ogc("ryhti_building/ogc/features/v1/collections/open_address"),
        "ryhti permits": lambda: fetch_ogc("ryhti_permit/ogc/features/v1/collections/open_permit_building"),
        "events": fetch_events,
    }
    # All sources and code lists are independent: fetch them in parallel
    with ThreadPoolExecutor(max_workers=8) as pool:
        code_jobs = [pool.submit(load_building_classification)]
        futures = {name: pool.submit(fn) for name, fn in steps.items()}
        got = {}
        for name, fut in futures.items():
            try:
                got[name] = fut.result()
            except Exception as e:
                if name != "events":  # events are optional, everything else is required
                    raise
                print("  events failed:", e)
                got[name] = []
            print(f"  {name:16} {len(got[name])}")
        for job in code_jobs:
            job.result()

    noise = {k: got[f"noise {k}"] for k in NOISE_LAYERS}
    features, context, plans, permit_sites, water, hazard_refs, stats = build(
        got["footprints"], got["ryhti buildings"], got["ryhti addresses"], got["ryhti permits"], got["protected"],
        got["plans in force"] + got["plans pending"], got["plan units"], noise, got["permit sites"],
        got["water disruptions"], got["address points"],
        {"flood": got["flood"], "seaLevel": got["sea level points"], "rescue": got["rescue stations"]})
    print("  join:", stats, "-> footprints", len(features))

    # Every postal code area touching the BBOX, plus any postal code registered for a building in it
    postal_areas = got["postal areas"]
    postal = sorted(set(postal_areas["names"]) |
                    {f["properties"]["postalCode"] for f in features if f["properties"].get("postalCode")})
    print("  postal codes", postal)
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [pool.submit(fetch_prices, postal), pool.submit(fetch_paavo, postal), pool.submit(fetch_radon, postal)]
        prices, paavo, radon = (j.result() for j in jobs)

    data = {
        "generated": date.today().isoformat(),
        "bbox": BBOX,
        "buildings": {"type": "FeatureCollection", "features": features},
        "context": {"type": "FeatureCollection", "features": context},
        "plans": plans,
        "prices": prices,
        "paavo": paavo,
        "events": prune(got["events"]),
        "noiseSurvey": {"year": 2022, "metric": "Lden",
                        "updated": max((d10(z["properties"].get("paivitetty_tietopalveluun")) or ""
                                        for zs in noise.values() for z in zs), default=None) or None},
        "permitSites": permit_sites,
        "permitSiteRadius": PERMIT_SITE_RADIUS_M,
        "waterDisruptions": water,
        "postalAreas": {"year": postal_areas["year"], "codes": postal,
                        "inBbox": sorted(postal_areas["names"])},
        "radon": radon,
        "floodReturnPeriods": FLOOD_RETURN_PERIODS,
        **hazard_refs,
        "joinStats": stats,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("window.PASILA_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB) in {time.time() - started:.0f}s")

    # Cache-busting: point index.html at this exact dataset version
    html = INDEX.read_text(encoding="utf-8")
    INDEX.write_text(re.sub(r'data/pasila-data\.js(\?v=[^"]*)?"', f'data/pasila-data.js?v={int(started)}"', html),
                     encoding="utf-8")
    if UNTRANSLATED:
        print(f"No official English for {len(UNTRANSLATED)} values "
              f"({sum(map(len, UNTRANSLATED))} chars), shown in Finnish:")
        for s in sorted(UNTRANSLATED):
            print("   ", s)


if __name__ == "__main__":
    main()
