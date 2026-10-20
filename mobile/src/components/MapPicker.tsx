import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { REFERER_BASE_URL } from "../config/map";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme/ThemeProvider";
import { commandScript, parseMapMessage, type Center, type Coords, type MapCommand, type MapMarker } from "../utils/map";
import { Icon } from "./icons/Icon";
import { mapPageHtml } from "./map/mapPage";
import { Text } from "./ui";

/**
 * FR-LB-001 map (Leaflet in a WebView, OpenStreetMap tiles from config/map.ts): a draggable pin with a radius
 * circle and markers for saved places / search results. The map is never required: when the page or its tiles
 * don't load (offline), it shows a short note and `onFailed` lets the screen rely on search and current location.
 *
 * `center` recentres the map whenever its value changes; `pin`, `radiusM` and `markers` are kept in sync.
 * `onPinMoved` fires on a map tap or when a drag ENDS (never while dragging).
 */
export function MapPicker({
  center,
  pin,
  radiusM,
  markers = [],
  interactive = true,
  onPinMoved,
  onMarkerTapped,
  onFailed,
  style,
}: {
  center: Center;
  pin: Coords | null;
  radiusM: number;
  markers?: MapMarker[];
  interactive?: boolean;
  onPinMoved?: (c: Coords) => void;
  onMarkerTapped?: (id: string) => void;
  onFailed?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useLocale();
  const { colors, radii, spacing } = useTheme();
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Built once: a new page would reload the map. Later changes go through commands.
  const [html] = useState(() =>
    mapPageHtml({ center, interactive, colors: { accent: colors.accent, onAccent: colors.onAccent, marker: colors.textSecondary, canvas: colors.canvas } }),
  );

  const send = (cmd: MapCommand) => web.current?.injectJavaScript(commandScript(cmd));

  const fail = () => {
    if (failed) return;
    setFailed(true);
    onFailed?.();
  };

  const centerKey = `${center.latitude.toFixed(6)},${center.longitude.toFixed(6)},${center.zoom}`;
  useEffect(() => {
    if (ready) send({ type: "setCenter", ...center });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, centerKey]);

  const pinKey = pin ? `${pin.latitude},${pin.longitude}` : "";
  useEffect(() => {
    if (ready) send(pin ? { type: "setPin", ...pin } : { type: "clearPin" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pinKey]);

  useEffect(() => {
    if (ready) send({ type: "setRadius", meters: radiusM });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, radiusM]);

  const markersKey = useMemo(() => markers.map((m) => `${m.id}@${m.latitude},${m.longitude}`).join("|"), [markers]);
  useEffect(() => {
    if (ready) send({ type: "setMarkers", markers });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, markersKey]);

  const onMessage = (e: WebViewMessageEvent) => {
    const m = parseMapMessage(e.nativeEvent.data);
    if (!m) return; // malformed: ignored
    if (m.type === "ready") setReady(true);
    else if (m.type === "pinMoved") onPinMoved?.({ latitude: m.latitude, longitude: m.longitude });
    else if (m.type === "markerTapped") onMarkerTapped?.(m.id);
    else if (m.type === "tilesFailed") fail();
  };

  if (failed) {
    return (
      <View style={[styles.box, { borderRadius: radii.md, backgroundColor: colors.warning.bg, padding: spacing.md, gap: spacing.sm }, style, styles.failed]} accessibilityRole="text">
        <Icon name="info" color={colors.warning.fg} />
        <Text variant="callout" color="warning" style={styles.flex}>
          {t("map.unavailable")}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.box, { borderRadius: radii.md, borderColor: colors.hairline }, style]} accessibilityLabel={t(interactive ? "map.a11yPicker" : "map.a11yView")}>
      <WebView
        ref={web}
        source={{ html, baseUrl: REFERER_BASE_URL }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        onMessage={onMessage}
        onError={fail}
        onHttpError={fail}
        // The page itself is the only navigation allowed; links (the attribution) open in the browser.
        onShouldStartLoadWithRequest={(req) => {
          if (req.url === "about:blank" || req.url.startsWith(REFERER_BASE_URL)) return true;
          if (/^https?:/.test(req.url)) void Linking.openURL(req.url);
          return false;
        }}
        style={styles.flex}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  failed: { flexDirection: "row", alignItems: "center", borderWidth: 0 },
  flex: { flex: 1 },
});
