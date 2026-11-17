import { useEffect } from "react";
import { Image, Modal, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../../i18n/LocaleProvider";
import { palettes } from "../../theme/tokens";
import { Icon } from "../icons/Icon";
import { IconButton, Text } from "../primitives";

const DARK = palettes.dark;
const MAX = 5;

/**
 * Full-screen picture (document previews): pinch or double-tap to zoom, drag to look around, close with ✕ or the
 * back button. Always dark, like a photo viewer. `uri` may be a data URI.
 */
export function ImageViewer({ uri, title, onClose }: { uri: string | null; title?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { t } = useLocale();
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ scale: 1, x: 0, y: 0 });

  useEffect(() => {
    scale.value = 1;
    x.value = 0;
    y.value = 0;
  }, [uri, scale, x, y]);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.value = { scale: scale.value, x: x.value, y: y.value };
    })
    .onUpdate((e) => {
      scale.value = Math.min(MAX, Math.max(1, start.value.scale * e.scale));
    })
    .onEnd(() => {
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
      }
    });
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      start.value = { scale: scale.value, x: x.value, y: y.value };
    })
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      x.value = start.value.x + e.translationX;
      y.value = start.value.y + e.translationY;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const zoomed = scale.value > 1;
      scale.value = withTiming(zoomed ? 1 : 2.5);
      x.value = withTiming(0);
      y.value = withTiming(0);
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));

  return (
    <Modal visible={Boolean(uri)} onRequestClose={onClose} animationType="fade" statusBarTranslucent transparent>
      <GestureHandlerRootView style={[styles.root, { backgroundColor: DARK.canvas }]}>
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
          <Animated.View style={[styles.fill, style]}>
            {uri ? <Image source={{ uri }} style={styles.fill} resizeMode="contain" accessibilityIgnoresInvertColors accessibilityLabel={title} /> : null}
          </Animated.View>
        </GestureDetector>
        <View style={[styles.top, { paddingTop: insets.top + 4 }]}>
          <IconButton icon={<Icon name="close" size={22} color={DARK.text} />} onPress={onClose} accessibilityLabel={t("common.close")} />
          {title ? (
            <Text variant="bodyStrong" numberOfLines={1} style={[styles.flex, { color: DARK.text }]}>
              {title}
            </Text>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  flex: { flex: 1 },
  top: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8 },
});
