/**
 * Android: no system scrim behind the navigation bar (UI v3 dark mode).
 *
 * The app draws edge to edge with a transparent navigation bar. On phones using 3-button navigation, Android 10+
 * still paints a translucent "contrast" scrim there, light in a light system theme, so the bar stayed light in the
 * app's dark mode. With the scrim off, the bar shows the app's own canvas; its button colour follows the theme
 * (ThemeProvider → <NavigationBar style>).
 */
const { withAndroidStyles } = require("expo/config-plugins");

module.exports = function withNavBarContrast(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults.resources.style ?? [];
    const app = styles.find((s) => s.$?.name === "AppTheme");
    if (app) {
      app.item = (app.item ?? []).filter((i) => i.$?.name !== "android:enforceNavigationBarContrast");
      app.item.push({ $: { name: "android:enforceNavigationBarContrast", "tools:targetApi": "29" }, _: "false" });
    }
    return cfg;
  });
};
