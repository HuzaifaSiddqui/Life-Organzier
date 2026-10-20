/**
 * Map tiles for the place picker (FR-LB-001). Everything about the tile provider lives in this file.
 *
 * Default: the public OpenStreetMap tile server. It is for LIGHT USE ONLY (a student project, a few users):
 * its usage policy (https://operations.osmfoundation.org/policies/tiles/) requires
 *   - the attribution "© OpenStreetMap contributors" visible on the map at all times (the map shows ATTRIBUTION),
 *   - a valid User-Agent and Referer: the WebView sends its own browser User-Agent, and the map page is loaded
 *     with REFERER_BASE_URL as its base URL so every tile request carries that Referer,
 *   - no bulk downloading or offline caching of tiles (the app doesn't).
 *
 * To switch to a keyed provider (MapTiler, Stadia, Thunderforest, …) for a real release, change the three values
 * below, e.g. TILE_URL = "https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=YOUR_KEY" and that provider's
 * attribution. Nothing else in the app needs to change. Don't commit a secret key: read it from app config.
 */

/** Leaflet tile URL template ({z}/{x}/{y}; {s} is not used by the OSM server). */
export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Shown on the map at all times (HTML allowed: Leaflet renders it in its attribution control). */
export const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Highest zoom the tile server provides. */
export const MAX_ZOOM = 19;

/** Base URL of the map page: tile requests send it as the Referer, which the OSM policy asks for. */
export const REFERER_BASE_URL = "https://life-organizer.app/";
