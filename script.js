/* ==========================================================
   Public Transport of Islamabad – Web GIS
   Data: OpenStreetMap via the Overpass API (no API key needed)
   Boundary: islamabad.geojson (your file) or Nominatim fallback
   ========================================================== */

// ---------- Configuration ----------
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter" // fallback mirror
];

// Bounding box (south, west, north, east) used to limit the API queries
const BBOX = [33.45, 72.80, 33.90, 73.40];

const VIEWS = {
  centre: { center: [33.6844, 73.0479], zoom: 12 },
  all:    { center: [33.725, 73.075],   zoom: 11 }
};

const TYPES = {
  stop:    { label: "Bus stops",        color: "#1f6fb2", shape: "dot" },
  station: { label: "Bus stations",     color: "#6b4fa0", shape: "dot" },
  metro:   { label: "Metro Bus route",  color: "#c8372d", shape: "line" },
  route:   { label: "Other bus routes", color: "#d18a12", shape: "line" }
};

const MAX_LIST_ITEMS = 300;

// ---------- State ----------
let features = [];
let activeTypes = new Set(Object.keys(TYPES));
let searchText = "";
let userLatLng = null;
let userMarker = null;
let boundary = null;        // { polys: [ [ring, ring...], ... ], bounds: L.LatLngBounds }
let boundaryLayer = null;
let boundarySource = "";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const statusBox = $("status");
const statusText = $("status-text");
const retryBtn = $("retry");
const resultsEl = $("results");

// ---------- Map ----------
const map = L.map("map").setView(VIEWS.all.center, VIEWS.all.zoom);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

map.createPane("boundaryPane");
map.getPane("boundaryPane").style.zIndex = 350;

const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);

// ---------- Helpers ----------
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function setStatus(kind, message, showRetry = false) {
  statusBox.className = "status " + kind;
  statusText.textContent = message;
  retryBtn.hidden = !showRetry;
}

function formatDistance(metres) {
  return metres < 1000 ? Math.round(metres) + " m" : (metres / 1000).toFixed(1) + " km";
}

// ---------- Boundary ----------
function extractPolygons(geojson) {
  const polys = [];
  const geoms = [];
  const collect = (g) => {
    if (!g) return;
    if (g.type === "FeatureCollection") g.features.forEach((f) => collect(f.geometry));
    else if (g.type === "Feature") collect(g.geometry);
    else if (g.type === "GeometryCollection") g.geometries.forEach(collect);
    else geoms.push(g);
  };
  collect(geojson);
  geoms.forEach((g) => {
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => polys.push(p));
  });
  return polys;
}

function setBoundary(geojson, source) {
  const polys = extractPolygons(geojson);
  if (!polys.length) return false;

  const layer = L.geoJSON(geojson, {
    pane: "boundaryPane",
    style: { color: "#17302e", weight: 2.5, dashArray: "8 6", fillColor: "#0f6b66", fillOpacity: 0.04 },
    interactive: false,
    filter: (f) => /Polygon/.test(f.geometry.type)
  });
  if (boundaryLayer) boundaryLayer.remove();
  boundaryLayer = layer.addTo(map);

  boundary = { polys, bounds: layer.getBounds() };
  boundarySource = source;
  return true;
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insideBoundary(lat, lon) {
  if (!boundary) return true; // no boundary available: keep everything
  if (!boundary.bounds.contains([lat, lon])) return false;
  for (const poly of boundary.polys) {
    if (ringContains(poly[0], lon, lat)) {
      let inHole = false;
      for (let k = 1; k < poly.length; k++) {
        if (ringContains(poly[k], lon, lat)) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// Keep only the parts of a line that run inside the boundary
function clipLines(lines) {
  if (!boundary) return lines;
  const out = [];
  lines.forEach((line) => {
    let run = [];
    line.forEach((p) => {
      if (insideBoundary(p[0], p[1])) run.push(p);
      else { if (run.length > 1) out.push(run); run = []; }
    });
    if (run.length > 1) out.push(run);
  });
  return out;
}

// ---------- Cache (makes repeat visits load instantly) ----------
const CACHE_TTL = 24 * 3600 * 1000;                       // 24 hours
const NO_CACHE = location.search.includes("refresh");     // open index.html?refresh to force a reload

function cacheGet(key) {
  if (NO_CACHE) return null;
  try {
    const r = JSON.parse(localStorage.getItem("pt_" + key));
    if (r && Date.now() - r.t < CACHE_TTL) return r.d;
  } catch (e) { /* ignore */ }
  return null;
}

function cacheSet(key, data) {
  try { localStorage.setItem("pt_" + key, JSON.stringify({ t: Date.now(), d: data })); }
  catch (e) { /* storage full or blocked: ignore */ }
}

async function fetchJSON(url, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("status " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadBoundary() {
  if (boundary) return;

  // 1) Your own file (converted from the shapefile): fails fast if missing
  try {
    const data = await fetchJSON("islamabad.geojson", 4000);
    if (setBoundary(data, "islamabad.geojson (own shapefile)")) return;
  } catch (e) { /* not there */ }

  // 2) Saved copy from an earlier visit
  const cached = cacheGet("boundary");
  if (cached && setBoundary(cached, "OpenStreetMap Nominatim (saved copy)")) return;

  // 3) OpenStreetMap Nominatim
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1" +
      "&polygon_threshold=0.002&limit=1&countrycodes=pk&q=" +
      encodeURIComponent("Islamabad Capital Territory");
    const data = await fetchJSON(url, 12000);
    if (setBoundary(data, "OpenStreetMap Nominatim")) cacheSet("boundary", data);
  } catch (e) {
    console.warn("Boundary could not be loaded:", e);
  }
}

// ---------- Fetch data from the API ----------
const bb = () => `(${BBOX.join(",")})`;

function stopsQuery() {
  return `[out:json][timeout:60];
(
  node["highway"="bus_stop"]${bb()};
  nwr["amenity"="bus_station"]${bb()};
  nwr["public_transport"="station"]["bus"="yes"]${bb()};
);
out center tags;`;
}

// Routes: only geometry inside the box is returned, which keeps the response small
function routesQuery() {
  return `[out:json][timeout:90];
rel["route"~"^(bus|minibus|trolleybus)$"]${bb()};
out geom;`;
}

async function postOverpass(url, query, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Server responded with status ${response.status}`);
    const json = await response.json();
    const els = json.elements || [];
    if (json.remark && /error|timed out|out of memory/i.test(json.remark) && !els.length) {
      throw new Error(json.remark);
    }
    return els;
  } finally {
    clearTimeout(timer);
  }
}

// Asks the main server; if it has not answered after 5 s, also asks the mirror.
// Whichever answers first wins. Results are cached.
async function overpass(query, cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let done = false;
  const attempt = (url, delay) => new Promise((resolve, reject) => {
    setTimeout(() => {
      if (done) return reject(new Error("skipped"));
      postOverpass(url, query, 60000)
        .catch(async (err) => {
          if (/429|504|503/.test(err.message)) {          // server busy: wait, try once more
            await new Promise((r) => setTimeout(r, 4000));
            return postOverpass(url, query, 60000);
          }
          throw err;
        })
        .then(resolve, reject);
    }, delay);
  });

  const els = await Promise.any([
    attempt(OVERPASS_ENDPOINTS[0], 0),
    attempt(OVERPASS_ENDPOINTS[1], 5000)
  ]);
  done = true;
  cacheSet(cacheKey, els);
  return els;
}

function reasonOf(res) {
  const e = res.reason;
  if (e && e.errors) return e.errors.map((x) => x.message).filter((m) => m !== "skipped").join(" / ") || "no answer";
  return e ? (e.name === "AbortError" ? "timed out" : e.message) : "unknown";
}

async function loadData() {
  setStatus("loading", "Loading boundary and bus stops…");
  features = [];

  // Boundary uses a different server, so it can load alongside the stops.
  // Stops and routes go one after the other so the free server is not overloaded.
  const [, stopsRes] = await Promise.allSettled([loadBoundary(), overpass(stopsQuery(), "stops")]);
  const stopsOK = stopsRes.status === "fulfilled";
  const stopEls = stopsOK ? stopsRes.value : [];

  if (stopsOK) {
    features = parseElements(stopEls);
    buildLayers();
    render(true);                         // stops are on the map already
  }

  setStatus("loading", `Showing ${features.length} stops. Loading bus routes…`);
  const routesRes = (await Promise.allSettled([overpass(routesQuery(), "routes")]))[0];
  const routesOK = routesRes.status === "fulfilled";

  features = parseElements(stopEls.concat(routesOK ? routesRes.value : []));
  buildLayers();
  render(!stopsOK);

  const nRoutes = features.filter((f) => f.lines).length;
  const problems = [];
  if (!stopsOK) problems.push("stops failed: " + reasonOf(stopsRes));
  if (!routesOK) problems.push("routes failed: " + reasonOf(routesRes));
  if (routesOK && nRoutes === 0) problems.push("no bus route relations found inside Islamabad in OpenStreetMap");
  if (!boundary) problems.push("boundary could not be loaded");

  if (!stopsOK && !routesOK) {
    setStatus("error", `Could not load data (${problems.join("; ")}).`, true);
  } else if (problems.length) {
    setStatus("error", `Showing ${features.length} features. Note: ${problems.join("; ")}.`, !stopsOK || !routesOK);
  }
}

// ---------- Parse the JSON ----------
function parseElements(elements) {
  const out = [];

  for (const el of elements) {
    const tags = el.tags || {};

    if (el.type === "relation") {
      const rtags = Object.assign({}, tags);
      if (!rtags.ref && rtags.route_ref) rtags.ref = rtags.route_ref;

      // 1) Drawn route: member ways
      let lines = (el.members || [])
        .filter((m) => m.type === "way" && Array.isArray(m.geometry))
        .map((m) => m.geometry.filter((p) => p && p.lat != null).map((p) => [p.lat, p.lon]))
        .filter((l) => l.length > 1);
      let approx = false;

      // 2) No drawn line: join the route's stops in order (approximate)
      if (!lines.length) {
        const pts = (el.members || [])
          .filter((m) => m.type === "node" && m.lat != null && /stop|platform/.test(m.role || ""))
          .map((m) => [m.lat, m.lon]);
        if (pts.length > 1) { lines = [pts]; approx = true; }
      }

      lines = clipLines(lines);
      if (!lines.length) continue;

      const text = `${rtags.name || ""} ${rtags["name:en"] || ""} ${rtags.network || ""} ${rtags.operator || ""} ${rtags.ref || ""}`;
      const kind = /metro|brt|(red|orange|blue|green) line/i.test(text) ? "metro" : "route";
      out.push({
        id: `relation/${el.id}`,
        osmUrl: `https://www.openstreetmap.org/relation/${el.id}`,
        kind,
        lines,
        approx,
        name: rtags["name:en"] || rtags.name || (rtags.ref ? `Bus route ${rtags.ref}` : "Unnamed bus route"),
        tags: rtags
      });
      continue;
    }

    const lat = el.lat ?? (el.center && el.center.lat);
    const lon = el.lon ?? (el.center && el.center.lon);
    if (lat == null || lon == null) continue;
    if (!insideBoundary(lat, lon)) continue;

    const isStation = tags.amenity === "bus_station" || tags.public_transport === "station";
    const kind = isStation ? "station" : "stop";
    out.push({
      id: `${el.type}/${el.id}`,
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      kind, lat, lon,
      name: tags.name || tags["name:en"] || (isStation ? "Unnamed bus station" : "Unnamed bus stop"),
      tags
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Popups ----------
function yesNo(v) {
  return v === "yes" ? "Yes" : v === "no" ? "No" : v;
}

function popupRows(rows) {
  const filled = rows.filter(([, v]) => v);
  if (!filled.length) return "<p style='margin:0;font-size:.82rem'>No further details are recorded in OpenStreetMap.</p>";
  return "<dl>" + filled.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHTML(v)}</dd>`).join("") + "</dl>";
}

function buildPopup(f) {
  const t = f.tags;
  let rows;

  if (f.kind === "stop" || f.kind === "station") {
    rows = [
      ["Routes", t.route_ref],
      ["Operator", t.operator],
      ["Network", t.network],
      ["Shelter", yesNo(t.shelter)],
      ["Bench", yesNo(t.bench)],
      ["Lit", yesNo(t.lit)],
      ["Wheelchair", yesNo(t.wheelchair)]
    ];
  } else {
    rows = [
      ["Route no.", t.ref],
      ["From", t.from],
      ["To", t.to],
      ["Operator", t.operator],
      ["Network", t.network],
      ["Mode", t.route]
    ];
  }

  return `<div class="pop" style="--c:${TYPES[f.kind].color}">
    <h3>${escapeHTML(f.name)}</h3>
    <p class="type">${TYPES[f.kind].label}</p>
    ${popupRows(rows)}
    <p style="margin:8px 0 0;font-size:.75rem"><a href="${f.osmUrl}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>
  </div>`;
}

// ---------- Build Leaflet layers ----------
function buildLayers() {
  features.forEach((f) => {
    const style = TYPES[f.kind];
    if (f.lines) {
      f.layer = L.polyline(f.lines, {
        color: style.color,
        weight: f.kind === "metro" ? 5 : 4,
        opacity: 0.85,
        dashArray: f.approx ? "8 6" : null
      }).bindPopup(() => buildPopup(f), { maxWidth: 300 });
      f.bounds = f.layer.getBounds();
    } else {
      f.layer = L.circleMarker([f.lat, f.lon], {
        radius: f.kind === "station" ? 8 : 5,
        color: "#ffffff",
        weight: 1.5,
        fillColor: style.color,
        fillOpacity: 0.95
      }).bindPopup(() => buildPopup(f), { maxWidth: 300 });
    }
  });
}

// ---------- Filtering ----------
function matches(f) {
  if (!activeTypes.has(f.kind)) return false;
  if (!searchText) return true;
  const hay = `${f.name} ${f.tags.ref || ""} ${f.tags.route_ref || ""} ${f.tags.from || ""} ${f.tags.to || ""}`.toLowerCase();
  return hay.includes(searchText);
}

function distanceTo(f) {
  if (!userLatLng) return null;
  if (!f.lines) return userLatLng.distanceTo([f.lat, f.lon]);
  let best = Infinity;
  for (const line of f.lines) {
    for (const p of line) {
      const d = userLatLng.distanceTo(p);
      if (d < best) best = d;
    }
  }
  return best;
}

function render(fitToData = false) {
  routeLayer.clearLayers();
  stopLayer.clearLayers();

  const visible = features.filter(matches);
  visible.forEach((f) => {
    f.distance = distanceTo(f);
    (f.lines ? routeLayer : stopLayer).addLayer(f.layer);
  });

  if (userLatLng) visible.sort((a, b) => a.distance - b.distance);

  renderList(visible);
  setStatus("ok", `Showing ${visible.length} of ${features.length} stops and routes inside Islamabad.`);

  if (fitToData) {
    if (boundary) {
      map.fitBounds(boundary.bounds, { padding: [20, 20] });
    } else if (visible.length) {
      const pts = [];
      visible.forEach((f) => {
        if (f.lines) pts.push(f.bounds.getSouthWest(), f.bounds.getNorthEast());
        else pts.push([f.lat, f.lon]);
      });
      map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
    }
  }
}

function renderList(visible) {
  resultsEl.innerHTML = "";
  if (!visible.length) {
    resultsEl.innerHTML = '<li class="empty">Nothing matches. Clear the search or switch on more layers.</li>';
    return;
  }

  const frag = document.createDocumentFragment();
  visible.slice(0, MAX_LIST_ITEMS).forEach((f) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.setProperty("--c", TYPES[f.kind].color);

    const sub = f.lines
      ? [f.tags.ref ? "No. " + f.tags.ref : "", f.tags.from && f.tags.to ? `${f.tags.from} to ${f.tags.to}` : ""].filter(Boolean).join(" – ")
      : (f.tags.route_ref ? "Routes: " + f.tags.route_ref : "");

    btn.innerHTML = `
      <span class="dot"></span>
      <span><span class="name">${escapeHTML(f.name)}</span>
        <span class="meta">${TYPES[f.kind].label}${sub ? " · " + escapeHTML(sub) : ""}</span></span>
      <span class="dist">${f.distance != null ? formatDistance(f.distance) : ""}</span>`;

    btn.addEventListener("click", () => {
      if (f.lines) {
        map.fitBounds(f.bounds, { padding: [40, 40] });
        f.layer.openPopup(f.bounds.getCenter());
      } else {
        map.setView([f.lat, f.lon], Math.max(map.getZoom(), 16));
        f.layer.openPopup();
      }
    });
    li.appendChild(btn);
    frag.appendChild(li);
  });

  if (visible.length > MAX_LIST_ITEMS) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `List limited to the first ${MAX_LIST_ITEMS}. Use search or filters to narrow down.`;
    frag.appendChild(li);
  }
  resultsEl.appendChild(frag);
}

// ---------- UI: filter chips + legend ----------
function buildControls() {
  const chips = $("type-filters");
  const legend = $("legend");

  Object.entries(TYPES).forEach(([key, t]) => {
    const label = document.createElement("label");
    label.className = "chip";
    label.style.setProperty("--c", t.color);
    label.innerHTML = `<input type="checkbox" value="${key}" checked><span class="dot"></span>${t.label}`;
    label.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? activeTypes.add(key) : activeTypes.delete(key);
      render();
    });
    chips.appendChild(label);

    const row = document.createElement("div");
    row.style.setProperty("--c", t.color);
    row.innerHTML = `<i class="${t.shape}"></i>${t.label}`;
    legend.appendChild(row);
  });

  $("search").addEventListener("input", (e) => {
    searchText = e.target.value.trim().toLowerCase();
    render();
  });

  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.view === "all" && boundary) {
        map.fitBounds(boundary.bounds, { padding: [20, 20] });
        return;
      }
      const v = VIEWS[btn.dataset.view];
      map.setView(v.center, v.zoom);
    });
  });

  $("locate").addEventListener("click", locateUser);
  $("clear-locate").addEventListener("click", clearLocation);
  retryBtn.addEventListener("click", loadData);
}

// ---------- Location filter ----------
function locateUser() {
  if (!navigator.geolocation) {
    setStatus("error", "Your browser does not support geolocation.");
    return;
  }
  setStatus("loading", "Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (userMarker) userMarker.remove();
      userMarker = L.marker(userLatLng).addTo(map).bindPopup("You are here");
      $("clear-locate").hidden = false;
      render();
      map.setView(userLatLng, 15);
    },
    (err) => setStatus("error", "Could not get your location: " + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function clearLocation() {
  userLatLng = null;
  if (userMarker) { userMarker.remove(); userMarker = null; }
  $("clear-locate").hidden = true;
  render();
}

// ---------- Start ----------
buildControls();
loadData();