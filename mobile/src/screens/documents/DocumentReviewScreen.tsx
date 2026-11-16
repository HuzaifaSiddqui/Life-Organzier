import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { DocumentReview } from "../../components/documents/DocumentReview";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ErrorState, Skeleton, Snackbar } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getDocumentReview, type ProcessResult } from "../../services/documentsApi";
import { useTheme } from "../../theme/ThemeProvider";

type Props = NativeStackScreenProps<MainStackParamList, "DocumentReview">;

/** Review of one document's reading: opened from its card in chat, or from My documents. */
export function DocumentReviewScreen({ navigation, route }: Props) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      const r = await getDocumentReview(route.params.documentId);
      if (!r) throw new Error(t("docs.noReading"));
      setResult(r);
    } catch (e) {
      setFailed(e);
    }
  }, [route.params.documentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title={result?.document.fileName ?? t("docs.review")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled">
        {failed ? (
          <ErrorState error={failed} onRetry={() => void load()} />
        ) : result ? (
          <DocumentReview initial={result} onToast={setToast} onAddManually={() => navigation.navigate("AddTask")} />
        ) : (
          <>
            <Skeleton height={80} />
            <Skeleton height={120} />
            <Skeleton height={120} />
          </>
        )}
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}
