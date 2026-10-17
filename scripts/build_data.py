"""
Build the static dataset for the Pasila app.

Fetches open data once for a fixed BBOX, joins it per building and writes
data/pasila-data.js (one global object), so the frontend needs no backend:
    python scripts/build_data.py

Only official open data is used, every source is CC BY 4.0:
  - Helsinki building footprints + register   kartta.hel.fi WFS  Rakennukset_alue_rekisteritiedot   (hri.fi: helsingin-rakennukset)
  - Helsinki protected buildings / plans      kartta.hel.fi WFS  Asemakaavoissa_suojellut..., Kaavahakemisto_*
  - Ryhti buildings, addresses, permits       paikkatiedot.ymparisto.fi OGC API Features  (Syke open data)
  - Prices of old dwellings by postal code    Statistics Finland PxWeb  StatFin/ashi/13mu
  - Postal code area statistics (Paavo)       Statistics Finland PxWeb  Postinumeroalueittainen_avoin_tieto/12f7
  - Events                                    Linked Events API (api.hel.fi)                    (hri.fi: linked-events-tapahtumarajapinta)
  - Code list labels                          koodistot.suomi.fi
"""
import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

# [minLon, minLat, maxLon, maxLat] - Länsi-, Keski- and Itä-Pasila
BBOX = [24.915, 60.191, 24.950, 60.209]

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "pasila-data.js"

RYHTI = "https://paikkatiedot.ymparisto.fi/geoserver"


def get_json(url, data=None):
    req = urllib.request.Request(url, headers={"User-Agent": "pasila-app/1.0"})
    if data is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(data).encode()
    with urllib.request.urlopen(req, data=data, timeout=120) as r:
        return json.load(r)


# ---------- Geometry helpers (lon/lat, small area so planar math is fine) ----------

def polygons_of(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []  # lines/points carry no area


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


_codelists = {}


def code_label(uri):
    """Resolve http://uri.suomi.fi/codelist/<registry>/<scheme>/code/<value> to its Finnish label."""
    if not uri or "/code/" not in uri:
        return None
    head, value = uri.split("/code/")
    registry, scheme = head.split("/codelist/")[1].split("/")
    key = (registry, scheme)
    if key not in _codelists:
        try:
            api = (f"https://koodistot.suomi.fi/codelist-api/api/v1/coderegistries/{registry}"
                   f"/codeschemes/{scheme}/codes/?format=json&pageSize=1000")
            _codelists[key] = {c["codeValue"]: c["prefLabel"].get("fi") for c in get_json(api)["results"]}
        except Exception as e:  # labels are optional
            print("  codelist failed", key, e)
            _codelists[key] = {}
    return _codelists[key].get(value, value)


def pxweb(path, query):
    """POST a PxWeb query and return (dims, list of (record, value))."""
    js = get_json(f"https://pxdata.stat.fi/PxWeb/api/v1/fi/{path}",
                  {"query": query, "response": {"format": "json-stat2"}})
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
    meta = get_json(f"https://pxdata.stat.fi/PxWeb/api/v1/fi/{path}")
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
    names = dict(zip(var[pc_code]["values"], var[pc_code]["valueTexts"]))
    by_postal = {}
    for rec, v in rows:
        pc = rec[pc_code]
        by_postal.setdefault(pc, {"name": names[pc].split("  ", 1)[-1], "values": {}})["values"][rec["contentscode"]] = v
    return {"year": year, "labels": {k: labels[k] for k in PAAVO_FIELDS}, "byPostal": by_postal}


def fetch_events():
    url = "https://api.hel.fi/linkedevents/v1/event/?" + urllib.parse.urlencode({
        "bbox": ",".join(map(str, BBOX)), "start": "today", "page_size": 100, "include": "location", "sort": "start_time"})
    events = []
    for e in get_json(url)["data"]:
        loc = e.get("location") or {}
        pos = loc.get("position")
        if not pos:
            continue
        name = e.get("name") or {}
        events.append({
            "name": name.get("fi") or name.get("en") or "",
            "start": e.get("start_time"),
            "place": (loc.get("name") or {}).get("fi"),
            "lon": pos["coordinates"][0], "lat": pos["coordinates"][1],
            "url": f"https://tapahtumat.hel.fi/fi/events/{e['id']}",
        })
    return events


# ---------- Join ----------

def d10(s):
    return s[:10] if s else None


def build(footprints, ryhti, addresses, permits, protected, plans):
    ryhti_by_vtj = {f["properties"]["permanent_building_identifier"]: f for f in ryhti}
    addr_by_key = {}
    for a in addresses:
        p = a["properties"]
        addr_by_key.setdefault(p["building_key"], []).append(p)

    permits_by_vtj = {}
    for f in permits:
        p = f["properties"]
        permits_by_vtj.setdefault(p["permanent_building_identifier"], []).append({
            "action": code_label(p["construction_action_type"]),
            "actionCode": (p["construction_action_type"] or "").split("/")[-1],
            "status": code_label(p["status_of_construction_action"]),
            "decision": d10(p["decision_date"]), "start": d10(p["start_date"]),
            "completed": d10(p["completion_date"]), "permitId": p["permanent_permit_identifier"],
        })

    protected_by_ratu = {}
    for f in protected:
        p = f["properties"]
        if p.get("pys_raknro"):
            protected_by_ratu[str(p["pys_raknro"])] = {"plan": p.get("kaava"), "mark": p.get("s_merk"),
                                                       "since": d10(p.get("voimaantulo_pvm"))}

    stats = {"register": 0, "spatial": 0, "verified": 0, "mismatch": 0, "context": 0}

    # 1) Decide which building (VTJ-PRT) each footprint belongs to
    groups, context, verified = {}, [], set()
    for f in footprints:
        h = f["properties"]
        geom = f["geometry"]
        vtj = h.get("vtj_prt") or h.get("c_vtj_prt")
        inside = [k for k, r in ryhti_by_vtj.items() if point_in_geom(*r["geometry"]["coordinates"], geom)]
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
                       if r and point_in_geom(*r["geometry"]["coordinates"], p["geometry"])), None)             or centroid(parts[0]["geometry"])
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
        plan_hits = [pl["properties"] for pl in plans if point_in_geom(anchor[0], anchor[1], pl["geometry"])]

        props = {
            "id": vtj,
            "vtj": vtj,
            "address": address,
            "otherAddresses": [a["address_fin"] for a in ryhti_addr if a["address_fin"] != address][:4],
            "postalCode": postal or (ryhti_addr[0]["postal_code"] if ryhti_addr else None),
            "type": h.get("tyyppi"),
            "purpose": code_label(rp.get("main_purpose")),
            "completed": d10(h.get("c_valmpvm")) or d10(rp.get("completion_date")),
            "storeys": h.get("i_kerrlkm") or rp.get("number_of_storeys"),
            "apartments": h.get("i_asuinhuoneistojen_lkm") or rp.get("apartment_count") or 0,
            "floorArea": h.get("i_kerrosala") or rp.get("gross_floor_area"),
            "totalArea": h.get("i_kokala") or rp.get("total_area"),
            "volume": h.get("i_raktilav") or rp.get("volume"),
            "elevator": h.get("c_hissi") == "x" if h.get("c_hissi") is not None else None,
            "propertyId": h.get("c_kiinteistotunnus") or rp.get("property_identifier"),
            "heating": code_label(rp.get("heating_method")),
            "energy": code_label(rp.get("heating_energy_source")),
            "structure": code_label(rp.get("material_of_load_bearing_structures")),
            "facade": code_label(rp.get("facade_material")),
            "protection": protected_by_ratu.get(ratu),
            "plans": sorted(({"id": p.get("kaavatunnus"), "status": p.get("luokka"),
                              "approved": p.get("hyvaksymispvm"), "inForce": d10(p.get("voimaantulopvm"))}
                             for p in plan_hits), key=lambda x: x["inForce"] or "9999", reverse=True),
            "history": sorted(permits_by_vtj.get(vtj, []), key=lambda x: x["decision"] or x["start"] or "", reverse=True),
            "parts": len(parts),
            "verified": vtj in verified,
            "match": "register" if (h.get("vtj_prt") or h.get("c_vtj_prt")) else "spatial",
        }
        for part in parts:
            features.append({"type": "Feature", "geometry": part["geometry"],
                             "properties": {**props, "footprintId": part["properties"]["id"]}})

    # 3) Footprints that cannot be tied to any building record: drawn as non-clickable context
    context_feats = []
    for f in context:
        if in_bbox(*centroid(f["geometry"])):
            stats["context"] += 1
            context_feats.append({"type": "Feature", "geometry": f["geometry"],
                                  "properties": {"type": f["properties"].get("tyyppi")}})
    return features, context_feats, stats


def main():
    print("BBOX", BBOX)
    steps = [
        ("footprints", lambda: fetch_wfs("Rakennukset_alue_rekisteritiedot")),
        ("protected", lambda: fetch_wfs("Asemakaavoissa_suojellut_rakennukset_alue")),
        ("plans in force", lambda: fetch_wfs("Kaavahakemisto_alue_kaava_voimassa")),
        ("plans pending", lambda: fetch_wfs("Kaavahakemisto_alue_kaava_vireilla")),
        ("ryhti buildings", lambda: fetch_ogc("ryhti_building/ogc/features/v1/collections/open_building")),
        ("ryhti addresses", lambda: fetch_ogc("ryhti_building/ogc/features/v1/collections/open_address")),
        ("ryhti permits", lambda: fetch_ogc("ryhti_permit/ogc/features/v1/collections/open_permit_building")),
    ]
    got = {}
    for name, fn in steps:
        got[name] = fn()
        print(f"  {name:16} {len(got[name])}")

    features, context, stats = build(got["footprints"], got["ryhti buildings"], got["ryhti addresses"],
                                     got["ryhti permits"], got["protected"],
                                     got["plans in force"] + got["plans pending"])
    print("  join:", stats, "-> buildings", len(features))

    postal = sorted({f["properties"]["postalCode"] for f in features if f["properties"]["postalCode"]})
    print("  postal codes", postal)
    prices = fetch_prices(postal)
    paavo = fetch_paavo(postal)
    try:
        events = fetch_events()
    except Exception as e:
        print("  events failed:", e)
        events = []
    print("  events", len(events))

    data = {
        "generated": date.today().isoformat(),
        "bbox": BBOX,
        "buildings": {"type": "FeatureCollection", "features": features},
        "context": {"type": "FeatureCollection", "features": context},
        "prices": prices,
        "paavo": paavo,
        "events": events,
        "joinStats": stats,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("window.PASILA_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
