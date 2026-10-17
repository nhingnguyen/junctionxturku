/**
 * Pasila Urban & Real Estate Intelligence
 * Data: window.PASILA_DATA built by scripts/build_data.py, official open data only (CC BY 4.0):
 *   - Footprints, register, protection, zoning plans: City of Helsinki (kartta.hel.fi)
 *   - Buildings, addresses, permits:                  Ryhti / Syke
 *   - Prices, postal-area statistics (Paavo):         Statistics Finland
 *   - Events:                                         Linked Events, City of Helsinki
 * The UI is in English; data values are shown exactly as published (Finnish).
 * Base maps and footprint geometries are used unmodified: everything we add is an overlay.
 */

const DATA = window.PASILA_DATA;
const FEATURES = DATA.buildings.features;
const BUILDINGS = [...new Map(FEATURES.map(f => [f.properties.id, f.properties])).values()];

// Ryhti construction_action_type codes 02 Laajentaminen, 03 Uudelleen rakentamiseen verrattava muutostyö, 04 Muu muutostyö
const RENOVATION_CODES = ['02', '03', '04'];

// Paavo fields shown in the "Area" tab; labels come from the API (Finnish)
const PAAVO_FIELDS = ['he_vakiy', 'he_kika', 'hr_mtu', 'te_taly', 'te_takk', 'te_as_valj', 'te_yks',
                      'te_laps', 'te_omis_as', 'te_vuok_as', 'ra_asunn', 'ra_as_kpa', 'ra_kt_as', 'ra_raky'];

const STYLE = {
  res:     { color: '#0369a1', fillColor: '#38bdf8', fillOpacity: 0.4,  weight: 1.2 },
  other:   { color: '#475569', fillColor: '#94a3b8', fillOpacity: 0.3,  weight: 1 },
  context: { color: '#64748b', fillColor: '#64748b', fillOpacity: 0.12, weight: 0.5, dashArray: '2 2' },
  active:  { color: '#facc15', fillColor: '#facc15', fillOpacity: 0.7,  weight: 3 }
};

let map = null;
let buildingLayer = null;
let activeId = null;
let priceChart = null;
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  renderBuildings();
  setupEventListeners();
  updateFilterCounts();
  document.getElementById('dataDate').textContent = DATA.generated;
  document.getElementById('mapLoader').classList.add('hidden');
});

// ---------- Helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => iso ? iso.split('-').reverse().join('.') : '—';
const fmtNum = (n) => (n || n === 0) ? Number(n).toLocaleString('fi-FI') : '—';
const isResidential = (p) => p.apartments > 0;
const isRenovated = (p) => p.history.some(h => RENOVATION_CODES.includes(h.actionCode));
const completedYear = (p) => p.completed ? Number(p.completed.slice(0, 4)) : null;
const titleOf = (p) => p.address || p.type || 'Building without address';

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
      <div><span class="swatch bbox"></span> Data area (BBOX)</div>`;
    return div;
  };
  legend.addTo(map);
}

function filterFn(p) {
  if (currentFilter === 'residential') return isResidential(p);
  if (currentFilter === 'recent') return (completedYear(p) || 0) >= 2010;
  if (currentFilter === 'renovated') return isRenovated(p);
  if (currentFilter === 'protected') return !!p.protection;
  return true;
}

// Draw the surveyed footprints. Every polygon carries its own feature data,
// so a click always resolves to exactly the building under the cursor.
function renderBuildings() {
  if (buildingLayer) map.removeLayer(buildingLayer);
  activeId = null;

  buildingLayer = L.geoJSON(DATA.buildings, {
    filter: (f) => filterFn(f.properties),
    style: (f) => isResidential(f.properties) ? STYLE.res : STYLE.other,
    smoothFactor: 0, // keep every surveyed vertex; Leaflet simplifies outlines by default
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindTooltip(`
        <strong>${esc(titleOf(p))}</strong><br>
        <span>${completedYear(p) || '?'} • ${p.apartments ? p.apartments + ' apartments' : esc(p.type || '')}</span>
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
  return buildingLayer.getLayers().filter(l => l.feature.properties.id === id);
}

// ---------- Selection & sidebar ----------

function selectBuilding(id) {
  const layers = layersOf(id);
  if (!layers.length) return;
  const p = layers[0].feature.properties;

  if (activeId) layersOf(activeId).forEach(l => buildingLayer.resetStyle(l));
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
    (p.otherAddresses.length ? ` <span class="muted">• also ${esc(p.otherAddresses.join(', '))}</span>` : '');
  document.getElementById('heroPurpose').textContent = p.purpose || p.type || '—';
  document.getElementById('heroYear').textContent = `Completed ${completedYear(p) || '?'}`;
  document.getElementById('heroApts').textContent = `${p.apartments || 0} apartments`;
  document.getElementById('valVtjId').textContent = p.vtj || '—';
  document.getElementById('valPropertyId').textContent = p.propertyId || '—';

  renderSpecs(p);
  renderArea(p.postalCode);
  renderTimeline(p);
  renderPriceChart(p.postalCode);
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
    ['Building type', p.type || '—'],
    ['Heating method', p.heating || '—'],
    ['Heating energy source', p.energy || '—'],
    ['Load-bearing structure', p.structure || '—'],
    ['Facade material', p.facade || '—'],
    ['Elevator', p.elevator === null ? '—' : p.elevator ? 'Yes' : 'No'],
    ['Protected in zoning plan', p.protection ? `${p.protection.mark || ''} (asemakaava ${p.protection.plan})` : 'No']
  ];
  document.getElementById('specsGrid').innerHTML = rows.map(([k, v]) => `
    <div class="spec-card">
      <span class="spec-label">${esc(k)}</span>
      <span class="spec-value">${esc(v)}</span>
    </div>`).join('');

  const note = document.getElementById('matchNote');
  note.innerHTML = p.verified
    ? '<i class="fa-solid fa-circle-check"></i> Location verified: the Ryhti point of this building lies inside its footprint.'
    : '<i class="fa-solid fa-circle-exclamation"></i> Not verified: the Ryhti point of this building lies outside its footprint (registers may differ).';
  note.className = `match-note ${p.verified ? 'ok' : 'warn'}`;
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

function renderTimeline(p) {
  const container = document.getElementById('permitTimeline');
  const items = p.history.map(h => ({
    date: h.completed || h.start || h.decision,
    title: h.action || 'Rakentamislupa',
    desc: [
      h.status,
      h.decision && `Decision ${fmtDate(h.decision)}`,
      h.start && `Started ${fmtDate(h.start)}`,
      h.completed && `Completed ${fmtDate(h.completed)}`
    ].filter(Boolean).join(' • '),
    permit: h.permitId,
    renovation: RENOVATION_CODES.includes(h.actionCode)
  }));

  // Buildings older than the digital permit register still have a completion date
  if (p.completed && !p.history.some(h => h.actionCode === '01')) {
    items.push({ date: p.completed, title: 'Valmistunut', desc: 'Completion date from the Helsinki building register', permit: null });
  }

  container.innerHTML = items.length ? items.map(r => `
    <div class="timeline-item ${r.renovation ? 'is-renovation' : ''}">
      <div class="timeline-dot"></div>
      <div class="timeline-date">${fmtDate(r.date)}</div>
      <div class="timeline-title">${esc(r.title)}</div>
      <div class="timeline-desc">${esc(r.desc)}</div>
      ${r.permit ? `<div class="timeline-permit-id">Permit ID: ${esc(r.permit)}</div>` : ''}
    </div>`).join('')
    : `<p class="muted">No permits recorded in Ryhti for this building.</p>`;
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
    trend.className = `trend-badge ${change >= 0 ? 'positive' : 'negative'}`;
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
  const plansHtml = p.plans.length ? p.plans.map(pl => `
    <div class="news-item">
      <div class="news-date"><i class="fa-solid fa-map"></i> ${esc(pl.status)}${pl.inForce ? ` • voimaan ${fmtDate(pl.inForce)}` : ''}</div>
      <div class="news-title">Asemakaava ${esc(pl.id)}</div>
      ${pl.approved && pl.approved !== pl.status ? `<div class="news-summary">Hyväksytty ${esc(pl.approved)}</div>` : ''}
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
    <h4 class="sub-title">Zoning plans covering the building (Kaavahakemisto)</h4>${plansHtml}
    <h4 class="sub-title">Events nearby (Linked Events)</h4>${eventsHtml}`;
}

function closeSidebar() {
  document.getElementById('buildingSidebar').classList.remove('open');
  if (activeId) layersOf(activeId).forEach(l => buildingLayer.resetStyle(l));
  activeId = null;
}

// ---------- Filters & search ----------

function updateFilterCounts() {
  document.getElementById('countAll').textContent = BUILDINGS.length;
  document.getElementById('countResidential').textContent = BUILDINGS.filter(isResidential).length;
  document.getElementById('countRecent').textContent = BUILDINGS.filter(p => (completedYear(p) || 0) >= 2010).length;
  document.getElementById('countRenovated').textContent = BUILDINGS.filter(isRenovated).length;
  document.getElementById('countProtected').textContent = BUILDINGS.filter(p => p.protection).length;
}

function setupEventListeners() {
  document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');
    });
  });

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      closeSidebar();
      renderBuildings();
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

    const matches = BUILDINGS
      .filter(p => p.address && ([p.address, ...p.otherAddresses].some(a => a.toLowerCase().includes(val)) || (p.postalCode || '').includes(val)))
      .slice(0, 12);

    suggestions.innerHTML = matches.length ? matches.map(m => `
      <div class="suggestion-item" data-id="${esc(m.id)}">
        <div>
          <strong>${esc(m.address)}</strong>
          <span>${esc(m.postalCode || '')} • ${esc(m.purpose || m.type || '')}</span>
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
    if (!layersOf(id).length) {
      // The building is hidden by the active filter: reset to "all" first
      document.querySelector('.filter-pill[data-filter="all"]').click();
    }
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
