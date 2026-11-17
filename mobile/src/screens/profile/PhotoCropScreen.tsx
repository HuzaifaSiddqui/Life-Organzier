import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Image, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { Icon } from "../../components/icons/Icon";
import { Button, IconButton, Text } from "../../components/primitives";
import { useAuth } from "../../context/AuthContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { hapticDone } from "../../services/haptics";
import { uploadCroppedPhoto } from "../../services/profilePhoto";
import { palettes, withAlpha } from "../../theme/tokens";
import { clampOffset, clampZoom, coverScale, cropRect } from "../../utils/photoCrop";

type Props = NativeStackScreenProps<MainStackParamList, "PhotoCrop">;

/** The page is always dark (a photo editor), whatever the theme. */
const DARK = palettes.dark;

/**
 * Profile photo crop (Me → photo → Choose / Take a photo): the photo behind a circle frame; drag to move, pinch (or
 * the − / + buttons on a computer) to zoom. The photo always covers the circle. "Use photo" crops the square under the
 * circle (utils/photoCrop.ts), shrinks it to 512 px and uploads it.
 */
export function PhotoCropScreen({ navigation, route }: Props) {
  const { uri, width, height } = route.params;
  const insets = useSafeAreaInsets();
  const { t } = useLocale();
  const { patchDbUser } = useAuth();
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frame = area ? Math.round(Math.min(area.w - 48, area.h - 48, 380)) : 0;
  const base = coverScale(width, height, frame);

  const zoom = useSharedValue(1);
  const offX = useSharedValue(0);
  const offY = useSharedValue(0);
  const start = useSharedValue({ x: 0, y: 0, zoom: 1 });

  const pan = Gesture.Pan()
    .onStart(() => {
      start.value = { x: offX.value, y: offY.value, zoom: zoom.value };
    })
    .onUpdate((e) => {
      const o = clampOffset({ x: start.value.x + e.translationX, y: start.value.y + e.translationY }, width, height, frame, zoom.value);
      offX.value = o.x;
      offY.value = o.y;
    });
  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.value = { x: offX.value, y: offY.value, zoom: zoom.value };
    })
    .onUpdate((e) => {
      const z = clampZoom(start.value.zoom * e.scale);
      zoom.value = z;
      const o = clampOffset({ x: offX.value, y: offY.value }, width, height, frame, z);
      offX.value = o.x;
      offY.value = o.y;
    });
  const gestures = Gesture.Simultaneous(pan, pinch);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offX.value }, { translateY: offY.value }, { scale: zoom.value }],
  }));

  const zoomBy = (step: number) => {
    const z = clampZoom(zoom.value + step);
    const o = clampOffset({ x: offX.value, y: offY.value }, width, height, frame, z);
    zoom.value = withTiming(z, { duration: 180 });
    offX.value = withTiming(o.x, { duration: 180 });
    offY.value = withTiming(o.y, { duration: 180 });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const user = await uploadCroppedPhoto(uri, cropRect(width, height, frame, zoom.value, { x: offX.value, y: offY.value }));
      patchDbUser({ photoUrl: user.photoUrl });
      hapticDone();
      navigation.goBack();
    } catch (e) {
      setError(getApiErrorMessage(e));
      setSaving(false);
    }
  };

  const onLayout = (e: LayoutChangeEvent) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const r = frame / 2;
  const cx = (area?.w ?? 0) / 2;
  const cy = (area?.h ?? 0) / 2;

  return (
    <View style={[styles.root, { backgroundColor: DARK.canvas, paddingTop: insets.top + 4, paddingBottom: Math.max(insets.bottom, 16) }]}>
      <View style={styles.top}>
        <IconButton icon={<Icon name="close" size={22} color={DARK.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.cancel")} />
        <Text variant="headline" style={[styles.flex, { color: DARK.text }]} accessibilityRole="header">
          {t("photo.cropTitle")}
        </Text>
      </View>

      <View style={styles.flex} onLayout={onLayout}>
        {area && frame > 0 ? (
          <GestureDetector gesture={gestures}>
            <View style={StyleSheet.absoluteFill} accessibilityLabel={t("photo.cropHint")}>
              <Animated.View
                style={[
                  styles.photo,
                  { width: width * base, height: height * base, left: cx - (width * base) / 2, top: cy - (height * base) / 2 },
                  imageStyle,
                ]}
              >
                <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
              </Animated.View>
              <Svg width={area.w} height={area.h} style={StyleSheet.absoluteFill} pointerEvents="none">
                <Path
                  d={`M0 0H${area.w}V${area.h}H0Z M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0Z`}
                  fill={withAlpha(DARK.canvas, 0.78)}
                  fillRule="evenodd"
                />
                <Circle cx={cx} cy={cy} r={r} stroke={DARK.onBrand} strokeWidth={2} fill="none" />
              </Svg>
            </View>
          </GestureDetector>
        ) : null}
      </View>

      <Text variant="caption" center style={{ color: DARK.textSecondary, marginTop: 8 }}>
        {t("photo.cropHint")}
      </Text>
      {error ? (
        <Text variant="caption" center style={{ color: DARK.danger.fg, marginTop: 4 }}>
          {error}
        </Text>
      ) : null}
      <View style={styles.bar}>
        <IconButton icon={<Icon name="zoomOut" size={22} color={DARK.text} />} onPress={() => zoomBy(-0.5)} accessibilityLabel={t("photo.zoomOut")} />
        <IconButton icon={<Icon name="zoomIn" size={22} color={DARK.text} />} onPress={() => zoomBy(0.5)} accessibilityLabel={t("photo.zoomIn")} />
        <View style={styles.flex} />
        <Button title={t("photo.use")} loading={saving} disabled={saving || !frame} onPress={() => void save()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingBottom: 8 },
  photo: { position: "absolute", overflow: "hidden" },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12 },
});
