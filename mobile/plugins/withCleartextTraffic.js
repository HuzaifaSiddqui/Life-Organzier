/**
 * Allows plain-HTTP API calls in release builds (android:usesCleartextTraffic="true").
 *
 * Why: the demo release APK talks to the backend on the laptop over a hotspot / LAN at http://<laptop-ip>:5050
 * (no TLS on a local network). Android blocks cleartext HTTP in release builds by default; debug builds already
 * allow it. Android's network security config can't express "private IP ranges", so this is app-wide.
 * Decision recorded in docs/known-limitations.md and docs/frd-deviations.md (12 Nov 2026). No new dependency:
 * uses Expo's own config-plugins.
 */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};
