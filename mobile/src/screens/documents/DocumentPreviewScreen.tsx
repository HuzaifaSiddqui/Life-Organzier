import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Image, ScrollView, StyleSheet, View, type ViewToken } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ImageViewer } from "../../components/documents/ImageViewer";
import { Icon } from "../../components/icons/Icon";
import { Button, Card, EmptyState, IconButton, PressableScale, Skeleton, Snackbar, Text } from "../../components/primitives";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { documentFile, documentKind, documentPage, documentText, listDocuments, type DocumentSummary } from "../../services/documentsApi";
import { shareFile } from "../../services/share";
import { useTheme } from "../../theme/ThemeProvider";
import { layout } from "../../theme/tokens";

type Props = NativeStackScreenProps<MainStackParamList, "DocumentPreview">;

/** A page as tall as an A4 page is for its width, until the real image says otherwise. */
const A4 = 1.414;

function Page({ documentId, page, width, onOpen }: { documentId: string; page: number; width: number; onOpen: (uri: string) => void }) {
  const { colors, radii } = useTheme();
  const { t } = useLocale();
  const [uri, setUri] = useState<string | null>(null);
  const [ratio, setRatio] = useState(A4);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    documentPage(documentId, page).then(
      (u) => {
        setUri(u);
        Image.getSize(u, (w, h) => w > 0 && setRatio(h / w), () => undefined);
      },
      () => setFailed(true),
    );
  }, [documentId, page]);
  useEffect(load, [load]);
  const height = Math.round(width * ratio);
  if (failed) {
    return (
      <PressableScale onPress={load} style={[styles.pageBox, { width, height, borderRadius: radii.md, backgroundColor: colors.surface, borderColor: colors.hairline }]} accessibilityRole="button" accessibilityLabel={t("common.retry")}>
        <Icon name="undo" size={22} color={colors.textTertiary} />
        <Text variant="caption" color="secondary">
          {t("preview.pageFailed")}
        </Text>
      </PressableScale>
    );
  }
  if (!uri) return <Skeleton width={width} height={height} radius={radii.md} />;
  return (
    <PressableScale onPress={() => onOpen(uri)} accessibilityRole="imagebutton" accessibilityLabel={t("preview.pageLabel", { n: String(page) })}>
      <Image source={{ uri }} style={{ width, height, borderRadius: radii.md, backgroundColor: colors.onBrand }} resizeMode="contain" accessibilityIgnoresInvertColors />
    </PressableScale>
  );
}

/**
 * A document's preview (My documents → tile): PDF pages one under another (loaded as they scroll into view; tap a
 * page to zoom), a photo (tap to zoom), or the text that was read (Word files, pasted text, older uploads). The bar
 * at the bottom opens what was found (the review) and the original in another app (or downloads it on a computer).
 */
export function DocumentPreviewScreen({ navigation, route }: Props) {
  const { documentId } = route.params;
  const insets = useSafeAreaInsets();
  const { colors, spacing } = useTheme();
  const { t } = useLocale();
  const [doc, setDoc] = useState<DocumentSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [visiblePage, setVisiblePage] = useState(1);
  const [sharing, setSharing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    listDocuments()
      .then((r) => {
        const d = r.documents.find((x) => x.id === documentId) ?? null;
        setDoc(d);
        setMissing(!d);
      })
      .catch(() => setMissing(true));
  }, [documentId]);

  const kind = doc ? documentKind(doc.mimeType, doc.fileName) : null;
  const pictures = Boolean(doc?.fileStored && (kind === "pdf" || kind === "image") && (kind === "image" || (doc.pageCount ?? 0) > 0));
  useEffect(() => {
    if (doc && !pictures) void documentText(doc.id).then(setText, () => setText(""));
  }, [doc, pictures]);

  const pages = useMemo(() => (pictures ? Array.from({ length: kind === "image" ? 1 : Math.min(doc?.pageCount ?? 1, 50) }, (_, i) => i + 1) : []), [pictures, kind, doc?.pageCount]);
  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0]?.item;
    if (typeof first === "number") setVisiblePage(first);
  }, []);

  const openElsewhere = async () => {
    if (!doc) return;
    setSharing(true);
    try {
      const f = await documentFile(doc.id);
      await shareFile(f.filename, f.mime, f.data);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    } finally {
      setSharing(false);
    }
  };

  const pageWidth = Math.max(0, Math.min(width, layout.contentMax) - spacing.lg * 2);

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas, paddingTop: insets.top + 4 }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={[styles.top, { paddingHorizontal: spacing.sm }]}>
        <IconButton icon={<Icon name="back" size={22} color={colors.text} />} onPress={() => navigation.goBack()} accessibilityLabel={t("common.back")} />
        <View style={styles.flex}>
          <Text variant="headline" numberOfLines={1} accessibilityRole="header">
            {doc?.fileName ?? t("docs.review")}
          </Text>
          {pages.length > 1 ? (
            <Text variant="caption" color="secondary" tabular>
              {t("preview.pageOf", { n: String(visiblePage), total: String(pages.length) })}
            </Text>
          ) : null}
        </View>
      </View>

      {missing ? (
        <View style={styles.center}>
          <EmptyState icon={<Icon name="doc" size={32} color={colors.textTertiary} />} title={t("preview.missing")} />
        </View>
      ) : !doc || pageWidth <= 0 ? (
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          <Skeleton height={420} radius={12} />
        </View>
      ) : pictures ? (
        <FlatList
          data={pages}
          keyExtractor={(p) => String(p)}
          renderItem={({ item }) => <Page documentId={doc.id} page={item} width={pageWidth} onOpen={setZoom} />}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, alignItems: "center", paddingBottom: 110 + insets.bottom }}
          initialNumToRender={2}
          windowSize={5}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 40 }}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 110 + insets.bottom, width: "100%", maxWidth: layout.contentMax, alignSelf: "center" }}>
          {doc.fileStored ? null : (
            <Text variant="caption" color="secondary">
              {t("preview.textOnly")}
            </Text>
          )}
          <Card>
            {text === null ? <Skeleton height={200} /> : <Text variant="body" selectable>{text.trim() || t("preview.noText")}</Text>}
          </Card>
        </ScrollView>
      )}

      {doc ? (
        <View style={[styles.bar, { backgroundColor: colors.surface, borderColor: colors.hairline, padding: spacing.md, paddingBottom: Math.max(insets.bottom, spacing.md), gap: spacing.sm }]}>
          {doc.extracted ? (
            <Button title={t("docs.found")} kind="tonal" icon={<Icon name="sparkle" size={16} color={colors.accentStrong} />} onPress={() => navigation.navigate("DocumentReview", { documentId: doc.id })} style={styles.flex} />
          ) : null}
          {doc.fileStored ? <Button title={t("docs.openElsewhere")} kind="secondary" loading={sharing} disabled={sharing} icon={<Icon name="upload" size={16} color={colors.accent} />} onPress={() => void openElsewhere()} style={styles.flex} /> : null}
        </View>
      ) : null}
      <ImageViewer uri={zoom} title={doc?.fileName} onClose={() => setZoom(null)} />
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center", padding: 24 },
  top: { flexDirection: "row", alignItems: "center", gap: 4, paddingBottom: 8 },
  pageBox: { alignItems: "center", justifyContent: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
});
