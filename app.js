/**
 * Pasila Urban & Real Estate Intelligence
 * Data: window.PASILA_DATA built by scripts/build_data.py, official open data only (CC BY 4.0):
 *   - Footprints, register, protection, detailed plans: City of Helsinki (kartta.hel.fi)
 *   - Buildings, addresses, permits:                  Ryhti / Syke
 *   - Prices, postal-area statistics (Paavo):         Statistics Finland
 *   - Events:                                         Linked Events, City of Helsinki
 * English only: official English labels come from the sources (Statistics Finland,
 * Linked Events); values without an official translation are shown as published (Finnish).
 * Base maps and footprint geometries are used unmodified: everything we add is an overlay.
 */

const DATA = window.PASILA_DATA;
const FEATURES = DATA.buildings.features;
const BUILDINGS = [...new Map(FEATURES.map(f => [f.properties.id, f.properties])).values()];

// Buildings grouped by property (kiinteistötunnus)
const PARCELS = BUILDINGS.reduce((map, p) => {
  if (p.propertyId) (map[p.propertyId] ||= []).push(p);
  return map;
}, {});

// Paavo fields shown in the "Area" tab; labels come from the English PxWeb API
const PAAVO_FIELDS = ['he_vakiy', 'he_kika', 'hr_mtu', 'te_taly', 'te_takk', 'te_as_valj', 'te_yks',
                      'te_laps', 'te_omis_as', 'te_vuok_as', 'ra_asunn', 'ra_as_kpa', 'ra_kt_as', 'ra_raky'];

const STYLE = {
  res:     { color: '#0369a1', fillColor: '#38bdf8', fillOpacity: 0.4,  weight: 1.2 },
  other:   { color: '#475569', fillColor: '#94a3b8', fillOpacity: 0.3,  weight: 1 },
  context: { color: '#64748b', fillColor: '#64748b', fillOpacity: 0.12, weight: 0.5, dashArray: '2 2' },
  planHalo:{ color: '#ffffff', weight: 7, opacity: 0.9, fill: false },
  plan:    { color: '#ff1f8f', fillColor: '#ff1f8f', fillOpacity: 0.12, weight: 3.5 },
  active:  { color: '#facc15', fillColor: '#facc15', fillOpacity: 0.7,  weight: 3 }
};

let map = null;
let buildingLayer = null;
let activeId = null;
let priceChart = null;
let layerIndex = new Map();   // building id -> its footprint layers
let selectedPostal = null;
let chartPostal;              // postal code the price chart was last drawn for
let planLayer = null;         // outline of the detailed plan opened in the Plans tab

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  renderBuildings();
  setupEventListeners();
  document.getElementById('dataDate').textContent = DATA.generated;
  document.getElementById('mapLoader').classList.add('hidden');
});

// ---------- Helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => iso ? iso.split('-').reverse().join('.') : '—';
const fmtNum = (n) => (n || n === 0) ? Number(n).toLocaleString('fi-FI') : '—';
const isResidential = (p) => p.apartments > 0;
const completedYear = (p) => p.completed ? Number(p.completed.slice(0, 4)) : null;
const titleOf = (p) => p.address || p.class || 'Building without address';
const fmtArea = (m2) => m2 >= 10000 ? `${fmtNum(Math.round(m2 / 100) / 100)} ha` : `${fmtNum(m2)} m²`;

// Key/value grid for an expanded item; empty values are skipped
function detailGrid(rows) {
  return `<div class="detail-grid">${rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<span>${esc(k)}</span><strong>${esc(v)}</strong>`).join('')}</div>`;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Address resolver ----------
// Free text such as "Fredikanterassi 3 B 14, 00520 Helsinki" -> building id.

const normAddr = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function buildAddressIndex() {
  const index = new Map();
  const add = (key, id) => { if (!index.has(key)) index.set(key, id); };
  BUILDINGS.forEach(p => {
    [p.address, ...(p.otherAddresses || [])].filter(Boolean).forEach(a => {
      const n = normAddr(a);
      add(n, p.id);
      // Ranges such as "Porvoonkatu 20-22" cover each number on that side of the street
      const m = n.match(/^(.*?) (\d+)\s*-\s*(\d+)$/);
      if (m) {
        const [, street, from, to] = m;
        const step = (to - from) % 2 === 0 ? 2 : 1;
        for (let k = Number(from); k <= Number(to); k += step) add(`${street} ${k}`, p.id);
      }
    });
  });
  return index;
}
const ADDRESS_INDEX = buildAddressIndex();

// A letter after the number is either part of the address ("19a", "19 a") or a staircase ("19 B 2").
// Finnish listings write staircases in capitals after a space, so that case tries the plain number first.
function resolveAddress(text) {
  const m = text.split(',')[0].trim().match(/^(\D+?)\s*(\d+)(?:(\s*)([A-Za-zÅÄÖåäö])(?![A-Za-zÅÄÖåäö]))?/);
  if (!m) return null;
  const [, street, num, gap, letter] = m;
  const base = `${normAddr(street)} ${num}`;
  const withLetter = letter ? `${base}${letter.toLowerCase()}` : null;
  const staircase = letter && gap && letter === letter.toUpperCase();
  const order = staircase ? [base, withLetter] : [withLetter, base];
  for (const key of order) if (key && ADDRESS_INDEX.has(key)) return ADDRESS_INDEX.get(key);
  return null;
}

// ---------- Map ----------

function initMap() {
  const [minLon, minLat, maxLon, maxLat] = DATA.bbox;
  const bounds = L.latLngBounds([minLat, minLon], [maxLat, maxLon]);

  map = L.map('map', {
    zoomControl: false,
    minZoom: 14,
    maxZoom: 21,
    maxBounds: bounds.pad(0.25),
    maxBoundsViscosity: 0.8
  }).fitBounds(bounds);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(
    'Data: <a href="https://hri.fi/data/fi/dataset/helsingin-rakennukset" target="_blank">© Helsingin kaupunki</a>, ' +
    '<a href="https://ryhti.syke.fi" target="_blank">Lähde: Syke, Ryhti</a>, ' +
    '<a href="https://stat.fi" target="_blank">© Tilastokeskus</a> (CC BY 4.0)'
  );

  // Base maps are used as-is; our data is only drawn on top of them.
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 21, maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
  });
  // Helsinki's own maps come from the same city survey as the footprints, so they line up exactly
  const helWms = (layers, format) => L.tileLayer.wms('https://kartta.hel.fi/ws/geoserver/avoindata/wms', {
    layers, format, transparent: false, maxZoom: 21,
    attribution: '<a href="https://hri.fi/data/fi/dataset/helsingin-ortoilmakuvat" target="_blank">© Helsingin kaupunki</a> (CC BY 4.0)'
  });
  const helOrtho = helWms('avoindata:Ortoilmakuva_2025_5cm', 'image/jpeg');
  const helBase = helWms('avoindata:Kantakartta', 'image/png');

  osm.addTo(map);
  L.control.layers({
    'OpenStreetMap': osm,
    'Helsinki aerial photo 2025': helOrtho,
    'Helsinki base map (Kantakartta)': helBase
  }, null, { position: 'topleft' }).addTo(map);

  // Dim everything outside the BBOX and outline the BBOX itself
  map.createPane('bboxPane').style.zIndex = 390;
  const world = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
  const hole = [[minLat, minLon], [minLat, maxLon], [maxLat, maxLon], [maxLat, minLon]];
  L.polygon([world, hole], {
    pane: 'bboxPane', interactive: false, stroke: false, fillColor: '#0f172a', fillOpacity: 0.35
  }).addTo(map);
  L.rectangle(bounds, {
    pane: 'bboxPane', interactive: false, fill: false, color: '#0ea5e9', weight: 2, dashArray: '6 6'
  }).addTo(map);

  // Small structures with no building record (sheds, transformers...): shown, not clickable
  L.geoJSON(DATA.context, { interactive: false, style: STYLE.context, smoothFactor: 0 }).addTo(map);

  addLegend();

  window.addEventListener('resize', () => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 250);
}

function addLegend() {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div><span class="swatch" style="background:${STYLE.res.fillColor}"></span> Residential</div>
      <div><span class="swatch" style="background:${STYLE.other.fillColor}"></span> Other building</div>
      <div><span class="swatch context"></span> Minor structure (no record)</div>
      <div><span class="swatch bbox"></span> Data area</div>`;
    return div;
  };
  legend.addTo(map);
}

// Draw the surveyed footprints. Every polygon carries its own feature data,
// so a click always resolves to exactly the building under the cursor.
function renderBuildings() {
  if (buildingLayer) map.removeLayer(buildingLayer);
  activeId = null;
  layerIndex = new Map();

  buildingLayer = L.geoJSON(DATA.buildings, {
    style: (f) => isResidential(f.properties) ? STYLE.res : STYLE.other,
    smoothFactor: 0, // keep every surveyed vertex; Leaflet simplifies outlines by default
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      if (!layerIndex.has(p.id)) layerIndex.set(p.id, []);
      layerIndex.get(p.id).push(layer);
      layer.bindTooltip(`
        <strong>${esc(titleOf(p))}</strong><br>
        <span>${completedYear(p) || '?'} • ${p.apartments ? p.apartments + ' apartments' : esc(p.class || '')}</span>
      `, { sticky: true, className: 'building-tooltip' });

      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectBuilding(p.id);
      });
      layer.on('mouseover', () => { if (p.id !== activeId) layer.setStyle({ weight: 2.5, fillOpacity: 0.7 }); });
      layer.on('mouseout', () => { if (p.id !== activeId) buildingLayer.resetStyle(layer); });
    }
  }).addTo(map);
}

// A building can consist of several footprints; all of them share the same id
function layersOf(id) {
  return layerIndex.get(id) || [];
}

// ---------- Selection & sidebar ----------

function selectBuilding(id) {
  const layers = layersOf(id);
  if (!layers.length) return;
  const p = layers[0].feature.properties;

  if (activeId) layersOf(activeId).forEach(l => buildingLayer.resetStyle(l));
  clearPlan();
  activeId = id;
  layers.forEach(l => { l.setStyle(STYLE.active); l.bringToFront(); });

  const bounds = L.featureGroup(layers).getBounds();
  const sidebarWidth = document.getElementById('buildingSidebar').offsetWidth || 0;
  map.flyToBounds(bounds, {
    paddingTopLeft: [40, 40],
    paddingBottomRight: [sidebarWidth + 40, 40],
    maxZoom: 18,
    duration: 0.6
  });

  document.getElementById('buildingTitle').textContent = titleOf(p);
  document.getElementById('buildingPostal').innerHTML =
    `<i class="fa-solid fa-map-pin"></i> ${esc(p.postalCode || '—')} Helsinki` +
    (p.otherAddresses ? ` <span class="muted">• also ${esc(p.otherAddresses.join(', '))}</span>` : '');
  document.getElementById('heroPurpose').textContent = p.class || '—';
  document.getElementById('heroYear').textContent = `Completed ${completedYear(p) || '?'}`;
  document.getElementById('heroApts').textContent = `${p.apartments || 0} apartments`;
  document.getElementById('valVtjId').textContent = p.vtj || '—';
  document.getElementById('valPropertyId').textContent = p.propertyId || '—';

  renderSpecs(p);
  renderArea(p.postalCode);
  renderTimeline(p);
  selectedPostal = p.postalCode;
  chartPostal = undefined;
  refreshPriceChart();
  updatePriceCheck();
  renderPlansAndEvents(p, bounds.getCenter());

  document.getElementById('buildingSidebar').classList.add('open');
}

function renderSpecs(p) {
  const rows = [
    ['Completion date', fmtDate(p.completed)],
    ['Storeys', p.storeys ?? '—'],
    ['Apartments', p.apartments || '—'],
    ['Floor area (kerrosala)', p.floorArea ? `${fmtNum(p.floorArea)} m²` : '—'],
    ['Total area', p.totalArea ? `${fmtNum(p.totalArea)} m²` : '—'],
    ['Volume', p.volume ? `${fmtNum(p.volume)} m³` : '—'],
    ['Building class', p.class || '—'],
    ['Heating energy source', p.energy || '—'],
    ['Load-bearing material', p.structure || '—'],
    ['Facade material', p.facade || '—'],
    ['Elevator', p.elevator == null ? '—' : p.elevator ? 'Yes' : 'No'],
    ['Protected in detailed plan', p.protection ? `${p.protection.mark || ''} (plan ${p.protection.plan})` : 'No']
  ];
  document.getElementById('specsGrid').innerHTML = rows.map(([k, v]) => `
    <div class="spec-card">
      <span class="spec-label">${esc(k)}</span>
      <span class="spec-value">${esc(v)}</span>
    </div>`).join('');

}

function renderArea(postalCode) {
  const container = document.getElementById('areaContainer');
  const area = DATA.paavo.byPostal[postalCode];
  if (!area) {
    container.innerHTML = `<p class="muted">No Paavo statistics for postal code ${esc(postalCode || '—')}.</p>`;
    return;
  }
  const v = area.values;
  const owned = v.te_omis_as, rented = v.te_vuok_as;
  const tenure = owned && rented ? `
    <div class="tenure-bar"><span style="width:${(owned / (owned + rented) * 100).toFixed(0)}%"></span></div>
    <p class="muted">Owner-occupied ${(owned / (owned + rented) * 100).toFixed(0)}% • Rented ${(rented / (owned + rented) * 100).toFixed(0)}%</p>` : '';

  container.innerHTML = `
    <p class="area-name">${esc(postalCode)} ${esc(area.name)} <span class="muted">• ${esc(DATA.paavo.year)}</span></p>
    ${tenure}
    <div class="specs-grid">
      ${PAAVO_FIELDS.filter(k => v[k] !== null && v[k] !== undefined).map(k => `
        <div class="spec-card">
          <span class="spec-label">${esc(DATA.paavo.labels[k])}</span>
          <span class="spec-value">${fmtNum(v[k])}</span>
        </div>`).join('')}
    </div>
    <p class="chart-footnote">Source: Statistics Finland, Paavo – open data by postal code area (CC BY 4.0).</p>`;
}

// Value recorded in the permit, with today's register value when it differs
function withNow(permitValue, nowValue, fmt = (v) => v) {
  if (permitValue == null) return null;
  const changed = nowValue != null && String(nowValue) !== String(permitValue);
  return `${fmt(permitValue)}${changed ? `  →  now ${fmt(nowValue)}` : ''}`;
}

// Permit type label (Syke data model, CC BY 4.0); codes without a licensed label are shown as codes
const permitType = (h) => h.type || (h.typeCode ? `Construction action, code ${h.typeCode}` : 'Building permit');

function permitDetails(h, p) {
  const m2 = (v) => `${fmtNum(v)} m²`;
  return `
    <h5 class="detail-heading">Permit</h5>
    ${detailGrid([
      ['Type of work', permitType(h)],
      ['Decision', h.decision && fmtDate(h.decision)],
      ['Construction started', h.start && fmtDate(h.start)],
      ['Completed', h.completed && fmtDate(h.completed)],
      ['Permit expires', h.expires && fmtDate(h.expires)],
      ['Extension decision', h.extensionDecision],
      ['Permit ID', h.permitId],
      ['DVV permit ID', h.dvvId]
    ])}
    <h5 class="detail-heading">Building data recorded with the permit</h5>
    ${detailGrid([
      ['Storeys', withNow(h.storeys, p.storeys)],
      ['Apartments', withNow(h.apartments, p.apartments || null)],
      ['Gross floor area', withNow(h.grossFloorArea, p.floorArea, m2)],
      ['Total area', withNow(h.totalArea, p.totalArea, m2)],
      ['Volume', withNow(h.volume, p.volume, (v) => `${fmtNum(v)} m³`)]
    ])}
    <p class="muted">Open data has the permit's type, dates and the building data stated in it. The description
    of the work, drawings and conditions are only in Ryhti's licensed (paid) interface.</p>`;
}

function renderTimeline(p) {
  const container = document.getElementById('permitTimeline');
  const history = p.history || [];
  const items = history.map(h => ({
    date: h.completed || h.start || h.decision,
    title: permitType(h),
    desc: [
      h.decision && `Decision ${fmtDate(h.decision)}`,
      h.start && `Started ${fmtDate(h.start)}`,
      h.completed && `Completed ${fmtDate(h.completed)}`
    ].filter(Boolean).join(' • '),
    details: permitDetails(h, p)
  }));

  // Buildings older than the digital permit register still have a completion date
  if (p.completed && !history.some(h => h.completed === p.completed)) {
    items.push({ date: p.completed, title: 'Completed', desc: 'Completion date from the Helsinki building register', permit: null });
  }

  container.innerHTML = items.length ? items.map(r => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      ${r.details ? '<button class="item-toggle" aria-expanded="false">' : '<div>'}
        <div class="timeline-date">${fmtDate(r.date)}</div>
        <div class="timeline-title">${esc(r.title)}${r.details ? '<i class="fa-solid fa-chevron-down chevron"></i>' : ''}</div>
        <div class="timeline-desc">${esc(r.desc)}</div>
      ${r.details ? '</button>' : '</div>'}
      ${r.details ? `<div class="item-details" hidden>${r.details}</div>` : ''}
    </div>`).join('')
    : `<p class="muted">No permits recorded in Ryhti for this building.</p>`;
}

// Compare an asking price the user enters with the StatFin average for the selected postal code
function updatePriceCheck() {
  const out = document.getElementById('pcResult');
  const price = Number(document.getElementById('pcPrice').value);
  const size = Number(document.getElementById('pcSize').value);
  const type = document.getElementById('pcRooms').value;
  if (!price || !size) { out.innerHTML = ''; return; }

  const perM2 = price / size;
  const { years, types, byPostal } = DATA.prices;
  const series = byPostal[selectedPostal]?.[type];
  const year = [...years].reverse().find(y => series?.price?.[y]);
  if (!year) {
    out.innerHTML = `<strong>${fmtNum(Math.round(perM2))} €/m²</strong><span class="muted"> – no StatFin average for this flat type in ${esc(selectedPostal || '—')}.</span>`;
    return;
  }
  const avg = series.price[year];
  const diff = (perM2 - avg) / avg * 100;
  out.innerHTML = `
    <strong>${fmtNum(Math.round(perM2))} €/m²</strong>
    <span class="trend-badge">${diff > 0 ? '+' : ''}${diff.toFixed(1)}%</span>
    <p class="muted">${Math.abs(diff).toFixed(1)}% ${diff > 0 ? 'above' : 'below'} the ${esc(year)} average of
    ${fmtNum(avg)} €/m² for ${esc(types[type].toLowerCase())} in ${esc(selectedPostal)}${series.count?.[year] ? ` (${series.count[year]} sales)` : ''}.
    Area average for old dwellings, not a valuation of this flat.</p>`;
}

// The chart is only drawn while the Prices tab is visible (and redrawn only when the postal code changes)
function refreshPriceChart() {
  if (!document.getElementById('tabPrice').classList.contains('active') || chartPostal === selectedPostal) return;
  chartPostal = selectedPostal;
  renderPriceChart(selectedPostal);
}

function renderPriceChart(postalCode) {
  const { years, types, byPostal } = DATA.prices;
  const series = byPostal[postalCode];
  const sub = document.getElementById('priceSub');
  const highlight = document.getElementById('priceHighlight');
  const trend = document.getElementById('priceTrend');

  if (priceChart) { priceChart.destroy(); priceChart = null; }

  if (!series) {
    sub.textContent = `No price statistics for postal code ${postalCode || '—'}`;
    highlight.textContent = '—';
    trend.style.display = 'none';
    return;
  }

  // Headline: latest value for two-room apartments (kaksiot), change over 5 years
  const two = series['2']?.price || {};
  const known = years.filter(y => two[y]);
  const lastYear = known[known.length - 1];
  const baseYear = known.find(y => Number(y) >= Number(lastYear) - 5);
  sub.textContent = lastYear ? `${types['2']}, ${postalCode} (${lastYear})` : `Old dwellings, ${postalCode}`;
  highlight.textContent = lastYear ? `${fmtNum(two[lastYear])} € / m²` : '—';
  if (lastYear && baseYear && baseYear !== lastYear) {
    const change = ((two[lastYear] - two[baseYear]) / two[baseYear]) * 100;
    trend.style.display = '';
    trend.className = 'trend-badge';
    trend.innerHTML = `<i class="fa-solid fa-arrow-trend-${change >= 0 ? 'up' : 'down'}"></i> ${change >= 0 ? '+' : ''}${change.toFixed(1)}% (${baseYear}–${lastYear})`;
  } else {
    trend.style.display = 'none';
  }

  const colors = { '1': '#a78bfa', '2': '#00b4d8', '3': '#f59e0b' };
  const ctx = document.getElementById('priceHistoryChart').getContext('2d');
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: years,
      datasets: Object.keys(types).map(t => ({
        label: types[t],
        data: years.map(y => series[t]?.price?.[y] ?? null),
        borderColor: colors[t],
        backgroundColor: colors[t],
        borderWidth: 2.5,
        tension: 0.3,
        spanGaps: true,
        pointRadius: 2.5
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#cbd5e1', boxWidth: 12, font: { family: 'Plus Jakarta Sans', size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const n = series[Object.keys(types)[c.datasetIndex]]?.count?.[c.label];
              return `${c.dataset.label}: ${fmtNum(c.parsed.y)} €/m²${n ? ` (${n} sales)` : ''}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', callback: (v) => `${fmtNum(v)} €` } }
      }
    }
  });
}

function renderPlansAndEvents(p, center) {
  const plot = p.plot;
  const parcel = PARCELS[p.propertyId] || [p];
  const parcelArea = parcel.reduce((sum, b) => sum + (b.floorArea || 0), 0);
  const plotHtml = plot ? `
    <div class="plot-card">
      <div class="plot-use"><span class="plot-code">${esc(plot.useCode || '')}</span> ${esc(plot.use || '')}</div>
      ${detailGrid([
        ['Plot (plan unit)', plot.id],
        ['Permitted use', [plot.useCode, plot.use].filter(Boolean).join(' – ')],
        ['Building rights', plot.buildingRights && `${fmtNum(plot.buildingRights)} m² floor area`],
        ['Built floor area on the property', parcelArea && `${fmtNum(parcelArea)} m² (${parcel.length} building${parcel.length > 1 ? 's' : ''})`],
        ['Plot area', plot.areaM2 && fmtArea(plot.areaM2)],
        ['Set by detailed plan', plot.plan]
      ])}
      ${parcel.length > 1 ? `<div class="parcel-buildings"><span class="muted">Buildings on this property:</span>
        ${parcel.map(b => `<button class="chip${b.id === p.id ? ' current' : ''}" data-select="${esc(b.id)}" title="VTJ-PRT ${esc(b.vtj)}">${esc(b.address || b.vtj)}${b.class ? ` · ${esc(b.class)}` : ''}</button>`).join('')}
      </div>` : ''}
    </div>` : `<p class="muted">No plot zoning found for this building.</p>`;

  const plans = (p.plans || []).map(id => DATA.plans[id]).filter(Boolean);
  const plansHtml = plans.length ? plans.map(pl => `
    <div class="news-item">
      <button class="item-toggle" aria-expanded="false" data-plan="${esc(pl.id)}">
        <div class="news-date"><i class="fa-solid fa-map"></i> ${esc(pl.status)}${pl.inForce ? ` • in force since ${fmtDate(pl.inForce)}` : ''}</div>
        <div class="news-title">Detailed plan ${esc(pl.id)}${plot && plot.plan === pl.id ? ' <span class="tag-small">sets this plot</span>' : ''}<i class="fa-solid fa-chevron-down chevron"></i></div>
      </button>
      <div class="item-details" hidden>
        ${detailGrid([
          ['Plan number', pl.id],
          ['Status', pl.status],
          ['Approved', pl.approved && fmtDate(pl.approved) + (pl.approvedBy ? ` (${pl.approvedBy})` : '')],
          ['Confirmed', pl.confirmed && fmtDate(pl.confirmed)],
          ['Legally valid', pl.legallyValid && fmtDate(pl.legallyValid)],
          ['In force since', pl.inForce && fmtDate(pl.inForce)],
          ['Plan area', pl.areaM2 && fmtArea(pl.areaM2)],
          ['Record updated', pl.updated && fmtDate(pl.updated)]
        ])}
        <p class="muted"><i class="fa-solid fa-draw-polygon"></i> Plan boundary is outlined on the map.</p>
      </div>
    </div>`).join('') : `<p class="muted">No detailed plan covers this building.</p>`;

  const nearby = DATA.events
    .map(e => ({ ...e, dist: distanceMeters(center.lat, center.lng, e.lat, e.lon) }))
    .filter(e => e.dist <= 800)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);
  const eventsHtml = nearby.length ? nearby.map(e => `
    <a class="news-item" href="${esc(e.url)}" target="_blank" rel="noopener">
      <div class="news-date"><i class="fa-regular fa-calendar"></i> ${fmtDate((e.start || '').slice(0, 10))} • ${Math.round(e.dist)} m • ${esc(e.place || '')}</div>
      <div class="news-title">${esc(e.name)}</div>
    </a>`).join('') : `<p class="muted">No events within 800 m.</p>`;

  document.getElementById('newsList').innerHTML = `
    <h4 class="sub-title">Plot zoning (Kaavayksiköt)</h4>${plotHtml}
    <h4 class="sub-title">Detailed plans (asemakaava) covering the building</h4>${plansHtml}
    <h4 class="sub-title">Events nearby (Linked Events)</h4>${eventsHtml}`;
}

// Outline a detailed plan area on the map (geometry as published by the City of Helsinki)
function showPlan(id) {
  clearPlan();
  const plan = DATA.plans[id];
  if (!plan?.geometry) return;
  planLayer = L.featureGroup([
    L.geoJSON(plan.geometry, { interactive: false, style: STYLE.planHalo, smoothFactor: 0 }),
    L.geoJSON(plan.geometry, { interactive: false, style: STYLE.plan, smoothFactor: 0 })
  ]).addTo(map);
  const sidebarWidth = document.getElementById('buildingSidebar').offsetWidth || 0;
  map.flyToBounds(planLayer.getBounds(), { paddingTopLeft: [40, 40], paddingBottomRight: [sidebarWidth + 40, 40], duration: 0.6 });
}

function clearPlan() {
  if (planLayer) map.removeLayer(planLayer);
  planLayer = null;
}

// Expand / collapse a permit or plan item
function toggleItem(btn) {
  const open = btn.getAttribute('aria-expanded') !== 'true';
  if (btn.dataset.plan) {
    // only one plan outline at a time
    document.querySelectorAll('.item-toggle[data-plan][aria-expanded="true"]').forEach(other => {
      if (other !== btn) { other.setAttribute('aria-expanded', 'false'); other.nextElementSibling.hidden = true; }
    });
    if (open) showPlan(btn.dataset.plan); else clearPlan();
  }
  btn.setAttribute('aria-expanded', String(open));
  btn.nextElementSibling.hidden = !open;
}

function closeSidebar() {
  clearPlan();
  document.getElementById('buildingSidebar').classList.remove('open');
  if (activeId) layersOf(activeId).forEach(l => buildingLayer.resetStyle(l));
  activeId = null;
}

// ---------- Search ----------

function setupEventListeners() {
  document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);
  ['pcPrice', 'pcSize', 'pcRooms'].forEach(id => document.getElementById(id).addEventListener('input', updatePriceCheck));
  document.getElementById('buildingSidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('.item-toggle');
    if (btn) toggleItem(btn);
    const chip = e.target.closest('[data-select]');
    if (chip && chip.dataset.select !== activeId) selectBuilding(chip.dataset.select);
  });

  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');
      refreshPriceChart();
    });
  });

  // Search addresses inside the BBOX (incl. secondary addresses from Ryhti)
  const searchInput = document.getElementById('searchInput');
  const suggestions = document.getElementById('searchSuggestions');
  const clearBtn = document.getElementById('clearSearchBtn');

  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim().toLowerCase();
    clearBtn.style.display = val ? 'block' : 'none';
    if (!val) { suggestions.style.display = 'none'; return; }

    // A full address ("Fredikanterassi 3 B 14, 00520") resolves to its building; otherwise substring search
    const exactId = /\d/.test(val) ? resolveAddress(val) : null;
    const matches = [
      ...(exactId ? [BUILDINGS.find(b => b.id === exactId)] : []),
      ...BUILDINGS.filter(p => p.id !== exactId && p.address &&
        ([p.address, ...(p.otherAddresses || [])].some(a => a.toLowerCase().includes(val)) || (p.postalCode || '').includes(val)))
    ].slice(0, 12);

    suggestions.innerHTML = matches.length ? matches.map(m => `
      <div class="suggestion-item" data-id="${esc(m.id)}">
        <div>
          <strong>${esc(m.address)}</strong>
          <span>${esc(m.postalCode || '')} • ${esc(m.class || '')}</span>
        </div>
        <span>${completedYear(m) || '?'}${m.apartments ? ` • ${m.apartments} apt.` : ''}</span>
      </div>`).join('')
      : `<div class="suggestion-empty">No matching address in the data area</div>`;
    suggestions.style.display = 'block';
  });

  suggestions.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    const id = item.dataset.id;
    suggestions.style.display = 'none';
    selectBuilding(id);
    searchInput.value = BUILDINGS.find(b => b.id === id)?.address || '';
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    suggestions.style.display = 'none';
    searchInput.focus();
  });

  const legalModal = document.getElementById('legalModal');
  document.getElementById('legalBtn').addEventListener('click', () => legalModal.classList.add('open'));
  document.getElementById('closeLegalModalBtn').addEventListener('click', () => legalModal.classList.remove('open'));
  document.getElementById('confirmLegalBtn').addEventListener('click', () => legalModal.classList.remove('open'));
}
