# Pasila Intelligence

An interactive map of the Pasila district in Helsinki. Click a building to see its details, building-permit history, area price trends, postal-area statistics, zoning plans and nearby events. The app uses only official open data (CC BY 4.0).

## Project structure

```
.
├── index.html              # Page layout
├── app.js                  # Map, sidebar, filters, search
├── style.css               # Styles
├── scripts/
│   └── build_data.py       # Fetches open data and builds data/pasila-data.js
├── data/
│   └── pasila-data.js      # Generated dataset loaded by the page
├── README.md
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

   This takes about 1–2 minutes. It downloads building, permit, price, statistics and event data for the Pasila area and writes `data/pasila-data.js`. On macOS/Linux use `python3` if `python` points to Python 2.

3. **Start a local web server**

   ```bash
   python -m http.server 8000
   ```

4. **Open the app** at **http://localhost:8000**

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
| `Port 8000 is already in use` | Use another port, e.g. `python -m http.server 8080` |
| `python` not found (Windows) | Install Python from python.org and tick *Add to PATH*, or use `py scripts/build_data.py` |
| Build script fails with a timeout or HTTP error | One of the open data services is temporarily unavailable; wait and run it again |
| Changes not visible after rebuilding | Hard-refresh the browser (`Ctrl+F5` / `Cmd+Shift+R`) |

## Data sources & licences

| Source | Data | Licence |
|---|---|---|
| City of Helsinki (kartta.hel.fi) | Building footprints, register data, protection, zoning plans, aerial photo, base map | CC BY 4.0 |
| Ryhti / Syke | Building attributes, addresses, building permits | CC BY 4.0 |
| Statistics Finland | Prices of old dwellings by postal code, Paavo area statistics | CC BY 4.0 |
| Linked Events (City of Helsinki) | Events | CC BY 4.0 |
| OpenStreetMap | Base map tiles | ODbL |

Attribution: © Helsingin kaupunki · Lähde: Syke, Ryhti · © Tilastokeskus · © OpenStreetMap contributors.
