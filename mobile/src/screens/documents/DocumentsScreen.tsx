import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { DocumentTile } from "../../components/documents/DocumentTile";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Icon, type IconName } from "../../components/icons/Icon";
import { Button, EmptyState, ListItem, Sheet, Snackbar, Text } from "../../components/primitives";
import { useCacheLoader } from "../../hooks/useCachedQuery";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { showAlert } from "../../services/dialog";
import { deleteDocument, documentFile, listDocuments, type DocumentSummary } from "../../services/documentsApi";
import { shareFile } from "../../services/share";
import { useTheme } from "../../theme/ThemeProvider";
import { layout } from "../../theme/tokens";

type Props = NativeStackScreenProps<MainStackParamList, "Documents">;

/** Tile columns for the space available: 2 on a phone, up to 4 on a wide window. */
export function tileColumns(width: number): number {
  return width >= 900 ? 4 : width >= 560 ? 3 : 2;
}

/**
 * My documents (under Me, UI v3): every file sent in chat as a tile with its preview (the photo, a PDF's first page,
 * or the file type). Tap opens the preview; ⋯ has Preview, What was found, Open in another app and Delete.
 * Documents are sent in the assistant chat ("+" in the message box).
 */
export function DocumentsScreen({ navigation }: Props) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const reduce = useReducedMotion();
  const [gridWidth, setGridWidth] = useState(0);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [usedBytes, setUsedBytes] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<DocumentSummary | null>(null);

  const cached = useCacheLoader();
  const load = useCallback(async () => {
    try {
      await cached("documents", listDocuments, (r) => {
        setDocs(r.documents);
        setUsedBytes(r.usedBytes);
      });
    } catch {
      setDocs((d) => d ?? []); // offline with nothing saved yet
    }
  }, [cached]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const remove = (d: DocumentSummary) =>
    showAlert(t("docs.deleteTitle"), t("docs.deleteBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("docs.delete"),
        style: "destructive",
        onPress: async () => {
          const before = docs;
          setDocs((list) => (list ?? []).filter((x) => x.id !== d.id));
          try {
            await deleteDocument(d.id);
            void load();
          } catch (e) {
            setDocs(before);
            setToast(getApiErrorMessage(e));
          }
        },
      },
    ]);

  const openElsewhere = async (d: DocumentSummary) => {
    try {
      const f = await documentFile(d.id);
      await shareFile(f.filename, f.mime, f.data);
    } catch (e) {
      setToast(getApiErrorMessage(e));
    }
  };

  const upload = () => navigation.navigate("Assistant", { attach: true, nonce: Date.now() });

  const cols = tileColumns(gridWidth);
  const gap = spacing.md;
  const tileWidth = Math.floor((gridWidth - gap * (cols - 1)) / cols);

  const actions: Array<{ icon: IconName; label: string; run: (d: DocumentSummary) => void; danger?: boolean; when?: (d: DocumentSummary) => boolean }> = [
    { icon: "doc", label: t("docs.preview"), run: (d) => navigation.navigate("DocumentPreview", { documentId: d.id }) },
    { icon: "sparkle", label: t("docs.found"), run: (d) => navigation.navigate("DocumentReview", { documentId: d.id }), when: (d) => Boolean(d.extracted) },
    { icon: "upload", label: t("docs.openElsewhere"), run: (d) => void openElsewhere(d), when: (d) => Boolean(d.fileStored) },
    { icon: "trash", label: t("docs.delete"), run: remove, danger: true },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader title={t("docs.title")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl, width: "100%", maxWidth: layout.contentMax, alignSelf: "center" }}>
        <View style={[styles.row, { gap: spacing.md }]}>
          <View style={styles.flex}>
            <Text variant="caption" color="secondary">
              {t("docs.intro")}
            </Text>
            <Text variant="caption" color="tertiary" style={{ marginTop: 2 }}>
              {t("docs.space", { used: (usedBytes / 1024 / 1024).toFixed(1) })}
            </Text>
          </View>
          <Button title={t("docs.send")} kind="tonal" size="sm" icon={<Icon name="plus" size={16} color={colors.accentStrong} />} onPress={upload} />
        </View>
        {docs && !docs.length ? (
          <EmptyState
            icon={<Icon name="doc" size={32} color={colors.textTertiary} />}
            title={t("docs.emptyTitle")}
            text={t("docs.emptyText")}
            action={<Button title={t("docs.sendInChat")} kind="tonal" icon={<Icon name="assistant" size={18} color={colors.accent} />} onPress={upload} />}
          />
        ) : null}
        <View style={[styles.grid, { gap }]} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
          {gridWidth > 0 && (docs ?? []).map((d, i) => (
            <Animated.View key={d.id} entering={reduce ? undefined : FadeInDown.delay(Math.min(i, 8) * 40).duration(220)} layout={reduce ? undefined : LinearTransition.duration(200)}>
              <DocumentTile doc={d} width={tileWidth} onOpen={() => navigation.navigate("DocumentPreview", { documentId: d.id })} onMore={() => setMenu(d)} />
            </Animated.View>
          ))}
        </View>
      </ScrollView>
      <Sheet visible={Boolean(menu)} onClose={() => setMenu(null)} title={menu?.fileName}>
        {menu
          ? actions
              .filter((a) => !a.when || a.when(menu))
              .map((a) => (
                <ListItem
                  key={a.label}
                  title={a.label}
                  leading={<Icon name={a.icon} size={20} color={a.danger ? colors.danger.fg : colors.accent} />}
                  onPress={() => {
                    const d = menu;
                    setMenu(null);
                    a.run(d);
                  }}
                />
              ))
          : null}
      </Sheet>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
});
