# Property Tracker Platform

An interactive map of the Pasila district in Helsinki. Click a building to see its details (including heating and recorded network connections), building-permit history, area price trends, postal-area statistics (including household income), detailed plans, nearby events, traffic noise, the nearest environmental permit facility, HSY water-supply disruptions, flood hazard zones (Syke), sea level estimates at the nearest shoreline point (FMI), fire and rescue facts with the nearest rescue station, electricity supply (operator, legal maximum outage, operator outage and cabling figures from Energiavirasto) and indoor radon by postal code (STUK). Postal-area statistics, prices and radon cover every postal code area that touches the map area. Each value is fetched from its publisher when the data is built (see REPORT.md); HSY, STUK and Energiavirasto's indicator workbook publish no licence and are used on request, everything else is CC BY 4.0.

## Project structure

```
.
├── index.html              # Page layout
├── app.js                  # Map, sidebar, search
├── config.js               # Addresses of the optional AI assistant
├── style.css               # Styles
├── scripts/
│   ├── build_data.py                # Fetches open data and builds data/pasila-data.js
│   ├── helsinki_building_codes.json # Code labels from Helsinki's building dataset (CC BY 4.0)
│   └── ryhti_permit_codes.json      # Permit type labels from Syke's data model (CC BY 4.0)
├── data/
│   └── pasila-data.js      # Generated dataset loaded by the page
├── README.md
├── REPORT.md               # Technical & data report
└── agent/                  # AI assistant (optional, runs separately; see below)
```

## Run locally

1. **Get the project**

   ```bash
   git clone <repository-url>
   cd junctionx
   ```

   Or download and unzip it, then open a terminal in the project folder.

2. **Build the dataset** (optional if `data/pasila-data.js` already exists)

   ```bash
   python scripts/build_data.py
   ```

   This takes about 30 seconds. It downloads building, permit, price, statistics and event data for the Pasila area and writes `data/pasila-data.js`. On macOS/Linux use `python3` if `python` points to Python 2.

3. **Start a local web server**

   ```bash
   python -m http.server 8000
   ```

4. **Open the app** at **http://localhost:8000**

## AI assistant (optional)

The **Assistant** button in the header opens a panel that shows the agent's own chat UI. The agent (Next.js frontend, Express backend, Ollama LLM and MCP servers for Ryhti, MML and Helsinki decisions) is in the [agent/](agent/) folder (taken from the `feature/helsinki-decisions` branch) and runs separately.

1. Create `agent/.env` from `agent/.env.example` (`.env` is git-ignored) and fill in the keys:

   | Variable | Needed for |
   |---|---|
   | `OLLAMA_API_KEY` | The LLM (required) |
   | `MML_API_KEY` | MML parcel and geocoding tools (optional; those tools fail without it) |
   | `SYKE_USER_ID`, `MML_BASE_URL`, `MML_GEOCODING_BASE_URL`, `HELSINKI_DECISIONS_API_URL` | Defaults from `.env.example` work |

2. Start the backend (API on `http://localhost:4000`):

   ```bash
   cd agent
   docker compose up --build -d
   ```

   `http://localhost:4000/health` should return `{"status":"ok","provider":"ollama"}` and `/tools` lists 13 tools.

3. Start the agent's frontend (on `http://localhost:3000`):

   ```bash
   cd agent/frontend
   npm install
   npm run dev
   ```

4. Open the app at `http://localhost:8000` and click **Assistant**.

If the backend or the frontend runs at another address, change `agentApi` or `agentUi` in `config.js`. The file is sent to the browser, so it holds addresses only, never keys.

### Map focus on the assistant's replies

When the agent's UI posts a reply to this page, the map focuses on the places it names. This is the one line added to the agent's code, in [agent/frontend/src/app/page.tsx](agent/frontend/src/app/page.tsx) (in `send()`, after the reply is added to the chat, marked `ADDED FOR PASILA INTELLIGENCE (map focus)`):

```ts
window.parent?.postMessage({ type: "assistant:reply", text: data.reply }, "http://localhost:8000");
```

The second argument is this app's address, so no other page can receive the replies. Open the app at exactly `http://localhost:8000` (not `127.0.0.1`), or change that address when the app is deployed.

Only messages from the assistant iframe's origin are accepted. The reply is matched against the official data only, in this order:

1. VTJ-PRT (permanent building identifier) and property ID (kiinteistötunnus)
2. Street address, e.g. `Palkkatilankatu 8` (all buildings at that address unless a VTJ-PRT narrows it down)
3. If no building is named: a street name, then a postal code area

One building opens its panel (on narrow screens it is highlighted instead, so the assistant stays open); several are highlighted in purple with a bar naming what was matched.

Matching is purely textual: a reply that says an address was *not* found still highlights it.

## Updating the data

The dataset is a snapshot. Re-run `python scripts/build_data.py` whenever you want fresh data. The snapshot date is shown in the app header.

To cover a different area, edit `BBOX` near the top of `scripts/build_data.py`:

```python
# [minLon, minLat, maxLon, maxLat]
BBOX = [24.915, 60.191, 24.950, 60.209]
```

Then rebuild. Building footprints come from the City of Helsinki, so the area must be inside Helsinki.

## Troubleshooting

| Problem | Fix |
|---|---|
| Blank base map | Open the app via `http://localhost:8000`, not by double-clicking `index.html` |
| Assistant panel shows a Next.js error mentioning `fonts.gstatic.com` | A Google Font download timed out on first start and Next.js cached the failure; stop `npm run dev` (and any leftover `node` process on port 3000) and start it again |
| `Another next dev server is already running` | An old dev server still holds port 3000; stop it (`taskkill /PID <pid> /F` on Windows, the PID is in the message) |
| `Port 8000 is already in use` | Use another port, e.g. `python -m http.server 8080` |
| `python` not found (Windows) | Install Python from python.org and tick *Add to PATH*, or use `py scripts/build_data.py` |
| Build script fails with a timeout or HTTP error | One of the open data services is temporarily unavailable; wait and run it again |
| Changes not visible after rebuilding | The build updates the data file version in `index.html` automatically; if the page still looks old, hard-refresh (`Ctrl+F5` / `Cmd+Shift+R`) |

## Data sources & licences

| Source | Data | Licence |
|---|---|---|
| City of Helsinki (kartta.hel.fi) | Building footprints, register data, protection, detailed plans, aerial photo, base map | CC BY 4.0 |
| Ryhti / Syke | Building attributes, addresses, building permits | CC BY 4.0 |
| Statistics Finland | Prices of old dwellings by postal code, Paavo area statistics | CC BY 4.0 |
| City of Helsinki (kartta.hel.fi) | Traffic noise zones (2022 survey, Lden), environmental permit facilities | CC BY 4.0 |
| Linked Events (City of Helsinki) | Events | CC BY 4.0 |
| OpenStreetMap | Base map tiles | ODbL |

Attribution: © Helsingin kaupunki · Lähde: Syke, Ryhti · © Tilastokeskus · © OpenStreetMap contributors.
