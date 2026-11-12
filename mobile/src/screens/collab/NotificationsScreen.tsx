import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Icon } from "../../components/icons/Icon";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, EmptyState, ErrorState, IconButton, ListItem, Skeleton } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getNotices, markNoticeRead, markNoticesRead, type Notice } from "../../services/collabApi";
import { useTheme } from "../../theme/ThemeProvider";
import { noticeTarget } from "../../utils/collab";
import { relativeTime } from "../../utils/format";
import { noticeLine } from "./CollabScreen";

type Props = NativeStackScreenProps<MainStackParamList, "Notifications">;

/**
 * Task collaboration (COLLAB_TASKS): every in-app notice (shared-task invitations, accepted / declined with reasons,
 * progress updates, removals). A tap marks it read and opens its task (or the card to answer); each can be marked
 * read on its own, or all at once.
 */
export function NotificationsScreen({ navigation }: Props) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotices(await getNotices());
      setFailed(null);
    } catch (e) {
      setFailed(e);
    } finally {
      setRefreshing(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const markRead = (id: string) => {
    setNotices((list) => list?.map((n) => (n.id === id ? { ...n, read: true } : n)) ?? null);
    void markNoticeRead(id).catch(() => undefined);
  };

  const open = (n: Notice) => {
    if (!n.read) markRead(n.id);
    const target = noticeTarget(n);
    (navigation.navigate as (screen: string, params?: object) => void)(target.screen, target.params);
  };

  const markAll = () => {
    setNotices((list) => list?.map((n) => ({ ...n, read: true })) ?? null);
    void markNoticesRead().catch(() => undefined);
  };

  const unread = notices?.filter((n) => !n.read).length ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader
        title={t("collab.notices.title")}
        onBack={() => navigation.goBack()}
        right={unread ? <Button title={t("collab.notices.markAll")} kind="ghost" size="sm" onPress={markAll} /> : undefined}
      />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textTertiary} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        {failed ? (
          <ErrorState error={failed} onRetry={() => void load()} />
        ) : !notices ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} />)
        ) : !notices.length ? (
          <EmptyState icon={<Icon name="bell" size={32} color={colors.textTertiary} />} title={t("collab.notices.title")} text={t("collab.notices.empty")} />
        ) : (
          <Card style={{ paddingVertical: spacing.xs }}>
            {notices.map((n) => (
              <ListItem
                key={n.id}
                title={noticeLine(n, t)}
                subtitle={relativeTime(n.createdAt)}
                leading={<Icon name={n.read ? "bell" : "info"} color={n.read ? colors.textTertiary : colors.accent} />}
                trailing={
                  n.read ? undefined : (
                    <IconButton icon={<Icon name="check" size={18} color={colors.textSecondary} />} accessibilityLabel={t("collab.notices.markOne")} onPress={() => markRead(n.id)} />
                  )
                }
                onPress={() => open(n)}
                accessibilityLabel={`${n.read ? "" : "Unread. "}${noticeLine(n, t)}`}
              />
            ))}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}
