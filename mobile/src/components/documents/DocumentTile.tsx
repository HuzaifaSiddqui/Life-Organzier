import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import { documentKind, documentThumbnail, type DocKindLabel, type DocumentSummary } from "../../services/documentsApi";
import { useTheme } from "../../theme/ThemeProvider";
import { Icon } from "../icons/Icon";
import { IconButton, PressableScale, Text } from "../primitives";

/** The file type in a few letters for the tile badge ("PDF", "DOCX", "JPG"). */
export function typeLabel(fileName: string, kind: DocKindLabel): string {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toUpperCase();
  if (ext) return ext === "JPEG" ? "JPG" : ext;
  return kind === "image" ? "IMG" : kind === "pdf" ? "PDF" : kind === "word" ? "DOC" : kind === "text" ? "TXT" : "FILE";
}

/**
 * One document in My documents (UI v3): a preview (the photo or the PDF's first page; otherwise the file type on a
 * tinted card), the name, the date and what was found. Tap opens the preview; ⋯ opens the actions.
 */
export function DocumentTile({ doc, width, onOpen, onMore }: { doc: DocumentSummary; width: number; onOpen: () => void; onMore: () => void }) {
  const { colors, radii, spacing } = useTheme();
  const { t } = useLocale();
  const kind = documentKind(doc.mimeType, doc.fileName);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (doc.hasThumbnail) void documentThumbnail(doc.id).then((uri) => live && setThumb(uri));
    return () => {
      live = false;
    };
  }, [doc.id, doc.hasThumbnail]);

  const tone = kind === "pdf" ? colors.danger : kind === "word" ? colors.info : kind === "image" ? colors.success : colors.warning;
  const deadlines = doc.extracted?.deadlines.length ?? 0;
  const classes = doc.extracted?.schedules.length ?? 0;
  const found = [deadlines ? t("docs.tile.deadlines", { count: String(deadlines) }) : null, classes ? t("docs.tile.classes", { count: String(classes) }) : null].filter(Boolean).join(" · ");
  const date = new Date(doc.createdAt).toLocaleDateString([], { day: "numeric", month: "short" });

  return (
    <PressableScale
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={t("docs.open", { name: doc.fileName })}
      style={[styles.tile, { width, backgroundColor: colors.surface, borderColor: colors.hairline, borderRadius: radii.lg }]}
    >
      <View style={[styles.preview, { height: Math.round(width * 0.78), backgroundColor: tone.bg, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg }]}>
        {thumb ? (
          <Animated.View entering={FadeIn.duration(200)} style={StyleSheet.absoluteFill}>
            <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
          </Animated.View>
        ) : (
          <View style={styles.center}>
            <Icon name={kind === "image" ? "image" : "doc"} size={32} color={tone.fg} />
          </View>
        )}
        <View style={[styles.badge, { backgroundColor: colors.surface, borderRadius: radii.sm }]}>
          <Text variant="label" style={{ color: tone.fg, fontSize: 10 }}>
            {typeLabel(doc.fileName, kind)}
          </Text>
        </View>
        {doc.pageCount && doc.pageCount > 1 ? (
          <View style={[styles.pages, { backgroundColor: colors.surface, borderRadius: radii.sm }]}>
            <Text variant="label" color="secondary" style={{ fontSize: 10 }}>
              {t("docs.tile.pages", { count: String(doc.pageCount) })}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.info, { padding: spacing.sm, paddingRight: 0 }]}>
        <View style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {doc.fileName}
          </Text>
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {found ? `${date} · ${found}` : date}
          </Text>
        </View>
        <IconButton icon={<Icon name="more" size={18} color={colors.textSecondary} />} onPress={onMore} accessibilityLabel={t("docs.actions", { name: doc.fileName })} />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  preview: { overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", left: 8, top: 8, paddingHorizontal: 6, paddingVertical: 2 },
  pages: { position: "absolute", right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2 },
  info: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
});
