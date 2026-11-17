import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useAuth } from "../../context/AuthContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { showAlert } from "../../services/dialog";
import { pickPhoto, removeProfilePhoto } from "../../services/profilePhoto";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon, type IconName } from "../icons/Icon";
import { ListItem, PressableScale, Sheet } from "../primitives";
import { Avatar } from "./Avatar";

/**
 * Me → the profile photo in its gradient ring with a small camera badge. A tap opens: Choose from gallery, Take a
 * photo (phone only), Remove photo. A picked photo goes to the crop screen (PhotoCropScreen).
 */
export function ProfilePhoto({ size = 72 }: { size?: number }) {
  const { colors } = useTheme();
  const { t } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { dbUser, patchDbUser } = useAuth();
  const [open, setOpen] = useState(false);
  const ring = size + 8;

  const pick = async (from: "library" | "camera") => {
    setOpen(false);
    try {
      const photo = await pickPhoto(from);
      if (photo === "denied") return showAlert(t("photo.cameraDenied"));
      if (photo) navigation.navigate("PhotoCrop", photo);
    } catch (e) {
      showAlert(t("photo.failed"), getApiErrorMessage(e));
    }
  };
  const remove = () => {
    setOpen(false);
    showAlert(t("photo.removeTitle"), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("photo.remove"),
        style: "destructive",
        onPress: () =>
          void removeProfilePhoto()
            .then((u) => patchDbUser({ photoUrl: u.photoUrl }))
            .catch((e) => showAlert(t("photo.failed"), getApiErrorMessage(e))),
      },
    ]);
  };

  const options: Array<{ icon: IconName; label: string; run: () => void }> = [
    { icon: "image", label: t("photo.choose"), run: () => void pick("library") },
    ...(Platform.OS === "web" ? [] : [{ icon: "camera" as IconName, label: t("photo.take"), run: () => void pick("camera") }]),
    ...(dbUser?.photoUrl ? [{ icon: "trash" as IconName, label: t("photo.remove"), run: remove }] : []),
  ];

  return (
    <>
      <PressableScale onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t("photo.change")} style={{ width: ring, height: ring }}>
        <View style={[styles.center, { width: ring, height: ring }]}>
          <LinearGradient colors={[colors.brand, colors.accentStrong]} style={[StyleSheet.absoluteFill, { borderRadius: ring / 2 }]} />
          <Avatar photoUrl={dbUser?.photoUrl} displayName={dbUser?.displayName} email={dbUser?.email} size={size} />
        </View>
        <View style={[styles.badge, { backgroundColor: colors.accentStrong, borderColor: colors.canvas }]}>
          <Icon name="camera" size={14} color={colors.onAccent} />
        </View>
      </PressableScale>
      <Sheet visible={open} onClose={() => setOpen(false)} title={t("photo.title")}>
        {options.map((o) => (
          <ListItem key={o.label} title={o.label} leading={<Icon name={o.icon} size={20} color={o.icon === "trash" ? colors.danger.fg : colors.accent} />} onPress={o.run} />
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", right: -2, bottom: -2, width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
