import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Icon } from "../../components/icons/Icon";
import { Button, Card, EmptyState, IconButton, Snackbar, Text } from "../../components/ui";
import { useCacheLoader } from "../../hooks/useCachedQuery";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import { showAlert } from "../../services/dialog";
import { deleteDocument, listDocuments, type DocumentSummary } from "../../services/documentsApi";
import { useTheme } from "../../theme/ThemeProvider";

type Props = NativeStackScreenProps<MainStackParamList, "Documents">;

/**
 * My documents (under Me): what has been uploaded, the space it uses, and delete. Documents are sent in the
 * assistant chat ("+" in the message box); tapping one here opens its review.
 */
export function DocumentsScreen({ navigation }: Props) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [usedBytes, setUsedBytes] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

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

  const upload = () => navigation.navigate("Assistant", { attach: true, nonce: Date.now() });

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader title={t("docs.title")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl }}>
        <Card style={{ gap: spacing.sm }}>
          <Text variant="body">{t("docs.intro")}</Text>
          <Text variant="caption" color="secondary">
            {t("docs.space", { used: (usedBytes / 1024 / 1024).toFixed(1) })}
          </Text>
          <Button title={t("docs.sendInChat")} kind="tonal" icon={<Icon name="assistant" size={18} color={colors.accent} />} onPress={upload} />
        </Card>
        {docs && !docs.length ? (
          <EmptyState icon={<Icon name="doc" size={32} color={colors.textTertiary} />} title={t("docs.emptyTitle")} text={t("docs.emptyText")} />
        ) : null}
        {(docs ?? []).map((d) => {
          const deadlines = d.extracted?.deadlines.length ?? 0;
          const classes = d.extracted?.schedules.length ?? 0;
          return (
            <Card key={d.id} onPress={() => navigation.navigate("DocumentReview", { documentId: d.id })} accessibilityLabel={t("docs.open", { name: d.fileName })}>
              <View style={[styles.row, { gap: spacing.md }]}>
                <Icon name="doc" size={22} color={colors.textSecondary} />
                <View style={styles.flex}>
                  <Text variant="body" numberOfLines={1}>
                    {d.fileName}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {t("docs.meta", { date: new Date(d.createdAt).toLocaleDateString(), deadlines: String(deadlines), classes: String(classes) })}
                  </Text>
                </View>
                <IconButton icon={<Icon name="trash" size={18} color={colors.danger.fg} />} accessibilityLabel={t("docs.deleteNamed", { name: d.fileName })} onPress={() => remove(d)} />
              </View>
            </Card>
          );
        })}
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
});
