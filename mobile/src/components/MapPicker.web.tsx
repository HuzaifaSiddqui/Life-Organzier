import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { Center, Coords, MapMarker } from "../utils/map";

/**
 * Web / desktop build of MapPicker. The map runs in a native WebView, which the web build doesn't have, and location
 * reminders are phone-only (constants/platformFeatures), so nothing on desktop should reach this. If something does,
 * it reports failure at once so the caller shows its "map unavailable" state instead of an empty box.
 */
export function MapPicker({
  onFailed,
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
  useEffect(() => {
    onFailed?.();
  }, [onFailed]);
  return <></>;
}
