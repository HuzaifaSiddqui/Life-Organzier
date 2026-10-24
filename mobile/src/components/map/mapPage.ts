import { ATTRIBUTION, MAX_ZOOM, TILE_URL } from "../../config/map";
import type { Center } from "../../utils/map";
import { LEAFLET_CSS, LEAFLET_JS } from "./leaflet.generated";

export type MapPageColors = { accent: string; onAccent: string; marker: string; canvas: string };

/**
 * The HTML page inside the WebView: Leaflet (inlined, no CDN), the tile layer from config/map.ts with its
 * attribution always visible, a draggable pin with a radius circle, and markers. Protocol:
 *   app → page: window.__lo({type: "setCenter" | "setPin" | "clearPin" | "setRadius" | "setMarkers", …})
 *   page → app: {type: "ready" | "pinMoved" | "markerTapped" | "tilesLoaded" | "tilesFailed"} via postMessage.
 * Every incoming command is checked here too; the app validates every outgoing event (utils/map.ts).
 * `pinMoved` is sent only when a drag ends or the map is tapped, never while dragging.
 */
export function mapPageHtml(opts: { center: Center; interactive: boolean; colors: MapPageColors }): string {
  const cfg = { ...opts.center, interactive: opts.interactive, tileUrl: TILE_URL, attribution: ATTRIBUTION, maxZoom: MAX_ZOOM, colors: opts.colors };
  const c = opts.colors;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${LEAFLET_CSS}</style>
<style>
html, body, #map { margin: 0; padding: 0; height: 100%; background: ${c.canvas}; }
.leaflet-control-attribution { font-size: 11px; }
.lo-pin { width: 26px; height: 26px; border-radius: 50% 50% 50% 0; background: ${c.accent}; border: 3px solid ${c.onAccent};
  transform: rotate(-45deg); box-shadow: 0 1px 4px rgba(0,0,0,0.35); }
</style></head><body><div id="map"></div>
<script>${LEAFLET_JS}</script>
<script>
(function () {
  var cfg = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};
  function post(m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  function num(v) { return typeof v === "number" && isFinite(v); }
  function okLL(a, b) { return num(a) && num(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180; }

  // Read-only maps sit in scrolling screens: no one-finger panning (it would fight the scroll); pinch still zooms.
  var map = L.map("map", { zoomControl: false, attributionControl: true, dragging: cfg.interactive }).setView([cfg.latitude, cfg.longitude], cfg.zoom);
  map.attributionControl.setPrefix(false);
  var tiles = L.tileLayer(cfg.tileUrl, { maxZoom: cfg.maxZoom, attribution: cfg.attribution });
  var loaded = 0, failed = 0, reported = false;
  function fail() { if (!reported && !loaded) { reported = true; post({ type: "tilesFailed" }); } }
  tiles.on("tileload", function () { loaded += 1; if (loaded === 1) post({ type: "tilesLoaded" }); });
  tiles.on("tileerror", function () { failed += 1; if (failed >= 3) fail(); });
  tiles.addTo(map);
  setTimeout(fail, 10000); // offline: no tile at all after 10 s

  var icon = L.divIcon({ className: "", html: '<div class="lo-pin"></div>', iconSize: [26, 26], iconAnchor: [13, 30] });
  var pin = null, circle = null, radius = 350;
  var markers = L.layerGroup().addTo(map);

  function placePin(lat, lng) {
    if (!pin) {
      pin = L.marker([lat, lng], { icon: icon, draggable: cfg.interactive, keyboard: false, autoPan: true }).addTo(map);
      circle = L.circle([lat, lng], { radius: radius, color: cfg.colors.accent, weight: 2, fillColor: cfg.colors.accent, fillOpacity: 0.12, interactive: false }).addTo(map);
      pin.on("drag", function (e) { circle.setLatLng(e.target.getLatLng()); }); // the circle follows live; no message
      pin.on("dragend", function (e) { var p = e.target.getLatLng(); post({ type: "pinMoved", latitude: p.lat, longitude: p.lng }); });
    } else {
      pin.setLatLng([lat, lng]);
      circle.setLatLng([lat, lng]);
    }
  }

  if (cfg.interactive) {
    map.on("click", function (e) { placePin(e.latlng.lat, e.latlng.lng); post({ type: "pinMoved", latitude: e.latlng.lat, longitude: e.latlng.lng }); });
  }

  window.__lo = function (m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "setCenter" && okLL(m.latitude, m.longitude)) {
      map.setView([m.latitude, m.longitude], num(m.zoom) ? Math.max(2, Math.min(cfg.maxZoom, m.zoom)) : map.getZoom());
    } else if (m.type === "setPin" && okLL(m.latitude, m.longitude)) {
      placePin(m.latitude, m.longitude);
    } else if (m.type === "clearPin") {
      if (pin) { map.removeLayer(pin); map.removeLayer(circle); pin = null; circle = null; }
    } else if (m.type === "setRadius" && num(m.meters) && m.meters > 0 && m.meters <= 5000) {
      radius = m.meters;
      if (circle) circle.setRadius(radius);
    } else if (m.type === "setMarkers" && Array.isArray(m.markers)) {
      markers.clearLayers();
      m.markers.slice(0, 50).forEach(function (k) {
        if (!k || !okLL(k.latitude, k.longitude) || typeof k.id !== "string") return;
        var result = k.kind === "result";
        var mk = L.circleMarker([k.latitude, k.longitude], {
          radius: result ? 8 : 6, weight: 2, color: cfg.colors.onAccent, bubblingMouseEvents: false, // a marker tap isn't a map tap
          fillColor: result ? cfg.colors.accent : cfg.colors.marker, fillOpacity: 0.95,
        }).addTo(markers);
        var label = document.createElement("span");
        label.textContent = String(k.label || "").slice(0, 80); // text, never HTML: names come from users and the geocoder
        mk.bindTooltip(label, { direction: "top" });
        mk.on("click", function () { post({ type: "markerTapped", id: k.id }); });
      });
    }
  };
  post({ type: "ready" });
})();
</script></body></html>`;
}
