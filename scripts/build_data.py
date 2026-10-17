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
  - Classification of Buildings 2018          Statistics Finland classifications API (data.stat.fi)
  - Helsinki register code explanations       scripts/helsinki_building_codes.json (from the helsingin-rakennukset dataset)
  - Permit type labels (codes 01-05)          scripts/ryhti_permit_codes.json (from Syke's CC BY repo sykefi/rakennuskohteet)

Code-list labels from koodistot.suomi.fi are NOT used: the service publishes no licence for its content.

The app is English-only. Official English labels are used wherever the source publishes them;
values without an official translation stay in Finnish and are listed at the end of the build
(input for a later machine-translation step). Footprint geometries are never modified.
"""
import json
import re
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

def fetch_wfs(layer):
    minx, miny, maxx, maxy = BBOX
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeName": f"avoindata:{layer}", "outputFormat": "application/json", "srsName": "EPSG:4326",
        # WFS 2.0 with EPSG:4326 uses lat,lon axis order
        "bbox": f"{miny},{minx},{maxy},{maxx},urn:ogc:def:crs:EPSG::4326",
    }
    return get_json("https://kartta.hel.fi/ws/geoserver/avoindata/wfs?" + urllib.parse.urlencode(params))["features"]


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
    labels, rows, cats = pxweb("StatFin/ashi/13mu.px", [
        {"code": "postinumeroalue_4_20220101", "selection": {"filter": "item", "values": postal_codes}},
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


PAAVO_FIELDS = ["he_vakiy", "he_kika", "hr_mtu", "te_taly", "te_takk", "te_as_valj", "te_yks",
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


def build(footprints, ryhti, addresses, permits, protected, plans, plots):
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
        ryhti_addr = sorted(addr_by_key.get(rp.get("building_key"), []), key=lambda a: a.get("address_number") or 99)
        if h.get("katunimi_suomi"):
            address = f"{h['katunimi_suomi']} {h.get('osoitenumero') or ''}".strip()
            postal = h.get("postinumero")
        elif ryhti_addr:
            address, postal = ryhti_addr[0]["address_fin"], ryhti_addr[0]["postal_code"]
        else:
            address, postal = None, None
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
        property_id = h.get("c_kiinteistotunnus") or rp.get("property_identifier")
        plot = plot_by_id.get(plot_key(property_id))

        props = {
            "id": vtj,
            "vtj": vtj,
            "footprintId": None,  # set per part below
            "address": address,
            "otherAddresses": [a["address_fin"] for a in ryhti_addr if a["address_fin"] != address][:4],
            "postalCode": postal or (ryhti_addr[0]["postal_code"] if ryhti_addr else None),
            "class": building_class(h.get("c_rakennusluokka"), h.get("tyyppi")),
            "completed": d10(h.get("c_valmpvm")) or d10(rp.get("completion_date")),
            "storeys": h.get("i_kerrlkm") or rp.get("number_of_storeys"),
            "apartments": h.get("i_asuinhuoneistojen_lkm") or rp.get("apartment_count") or 0,
            "floorArea": h.get("i_kerrosala") or rp.get("gross_floor_area"),
            "totalArea": h.get("i_kokala") or rp.get("total_area"),
            "volume": h.get("i_raktilav") or rp.get("volume"),
            "elevator": h.get("c_hissi") == "x" if h.get("c_hissi") is not None else None,
            "propertyId": h.get("c_kiinteistotunnus") or rp.get("property_identifier"),
            "energy": helsinki_code("RA_LAMMONLAHDE", h.get("c_poltaine")),
            "structure": helsinki_code("RA_KANTRAKAINE", h.get("c_rakeaine")),
            "facade": helsinki_code("RA_JULKISIVUMAT", h.get("c_julkisivu")),
            "protection": protected_by_ratu.get(ratu),
            "plot": plot_info(plot) if plot else None,
            "plans": sorted(plans_here, key=lambda i: plans_used[i].get("inForce") or "9999", reverse=True),
            "history": sorted(permits_by_vtj.get(vtj, []), key=lambda x: x["decision"] or x["start"] or "", reverse=True),
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
    return features, context_feats, plans_used, stats


def main():
    started = time.time()
    print("BBOX", BBOX)
    steps = {
        "footprints": lambda: fetch_wfs("Rakennukset_alue_rekisteritiedot"),
        "protected": lambda: fetch_wfs("Asemakaavoissa_suojellut_rakennukset_alue"),
        "plans in force": lambda: fetch_wfs("Kaavahakemisto_alue_kaava_voimassa"),
        "plans pending": lambda: fetch_wfs("Kaavahakemisto_alue_kaava_vireilla"),
        "plan units": lambda: fetch_wfs("Kaavayksikot"),
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

    features, context, plans, stats = build(got["footprints"], got["ryhti buildings"], got["ryhti addresses"],
                                     got["ryhti permits"], got["protected"],
                                     got["plans in force"] + got["plans pending"], got["plan units"])
    print("  join:", stats, "-> footprints", len(features))

    postal = sorted({f["properties"]["postalCode"] for f in features if f["properties"].get("postalCode")})
    print("  postal codes", postal)
    with ThreadPoolExecutor(max_workers=2) as pool:
        prices_job, paavo_job = pool.submit(fetch_prices, postal), pool.submit(fetch_paavo, postal)
        prices, paavo = prices_job.result(), paavo_job.result()

    data = {
        "generated": date.today().isoformat(),
        "bbox": BBOX,
        "buildings": {"type": "FeatureCollection", "features": features},
        "context": {"type": "FeatureCollection", "features": context},
        "plans": plans,
        "prices": prices,
        "paavo": paavo,
        "events": prune(got["events"]),
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
