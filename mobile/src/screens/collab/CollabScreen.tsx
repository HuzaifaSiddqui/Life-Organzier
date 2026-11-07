import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { StateChip } from "../../components/collab/StateChip";
import { Icon } from "../../components/icons/Icon";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, EmptyState, ErrorState, IconButton, ListItem, SectionTitle, Skeleton, Snackbar, Text } from "../../components/ui";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { apiErrorCode, isNetworkError } from "../../services/api";
import {
  acceptSharedTask,
  answerConnection,
  cancelSharedTask,
  leaveSharedTask,
  removeSharedMember,
  declineSharedTask,
  getCollabSummary,
  getConnections,
  getNotices,
  getSharedTasks,
  markNoticesRead,
  removeConnection,
  requestConnection,
  resendSharedTask,
  saveUsername,
  searchPeople,
  type Connections,
  type Notice,
  type SearchResult,
  type SharedTask,
  type Summary,
} from "../../services/collabApi";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../theme/ThemeProvider";
import type { Task } from "../../types/models";
import { cleanUsername, collabErrorKey, doneCount, personLabel, searchable } from "../../utils/collab";
import { formatDue, formatDuration, relativeTime } from "../../utils/format";

type Props = NativeStackScreenProps<MainStackParamList, "Collab">;
type Tab = "requests" | "people" | "shared";
type Data = { summary: Summary; connections: Connections; cards: SharedTask[]; shared: SharedTask[]; notices: Notice[] };

const SEARCH_DEBOUNCE_MS = 250;

/** "Due Fri 3 PM" for a card's or a proposal's date and time. */
const dueLabel = (dueDate: string | null, dueTime: string | null) => formatDue({ dueDate, dueTime, status: "PENDING" } as Task);

/**
 * Task collaboration (COLLAB_TASKS): requests (people and task cards), people (live search, connections) and the
 * shared tasks with everyone's progress. Nothing reaches the user's plan until they accept a card.
 */
export function CollabScreen({ navigation, route }: Props) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const [tab, setTab] = useState<Tab>(route.params?.tab ?? "requests");
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "neutral" | "success" | "warning" } | null>(null);

  useEffect(() => {
    if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.tab]);

  const load = useCallback(async () => {
    try {
      const summary = await getCollabSummary();
      if (!summary) {
        navigation.goBack(); // the server has collaboration off
        return;
      }
      const [connections, tasks, notices] = await Promise.all([getConnections(), getSharedTasks(), getNotices()]);
      setData({ summary, connections, cards: tasks.cards, shared: tasks.shared, notices });
      setFailed(null);
      if (summary.unread) void markNoticesRead().catch(() => undefined);
    } catch (e) {
      setFailed(e);
    }
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const fail = (e: unknown) => setToast({ text: t(collabErrorKey(apiErrorCode(e), isNetworkError(e)) as StringKey), tone: "warning" });
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await work();
      if (done) setToast({ text: done, tone: "success" });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const waiting = data ? data.connections.incoming.length + data.cards.length : 0;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "requests", label: waiting ? `${t("collab.tab.requests")} (${waiting})` : t("collab.tab.requests") },
    { key: "people", label: t("collab.tab.people") },
    { key: "shared", label: t("collab.tab.shared") },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenHeader title={t("collab.title")} onBack={() => navigation.goBack()} />
      <View style={[styles.row, { paddingHorizontal: spacing.lg, gap: spacing.xs, paddingBottom: spacing.sm }]} accessibilityRole="tablist">
        {tabs.map((x) => (
          <Chip key={x.key} label={x.label} selected={tab === x.key} onPress={() => setTab(x.key)} />
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled">
        {failed && !data ? (
          <ErrorState error={failed} onRetry={() => void load()} />
        ) : !data ? (
          [0, 1, 2].map((i) => <Skeleton key={i} height={72} />)
        ) : (
          <>
            {!data.summary.username ? <UsernameCard onSaved={() => void load()} /> : null}
            {tab === "requests" ? (
              <RequestsTab data={data} busy={busy} run={run} onOtherTime={(id) => navigation.navigate("SharedTaskEdit", { id, mode: "accept" })} />
            ) : tab === "people" ? (
              <PeopleTab data={data} busy={busy} run={run} onRefresh={() => void load()} />
            ) : (
              <SharedTab
                data={data}
                busy={busy}
                run={run}
                onEdit={(id) => navigation.navigate("SharedTaskEdit", { id, mode: "edit" })}
                onOpenTask={(taskId) => navigation.navigate("TaskDetail", { taskId })}
              />
            )}
          </>
        )}
      </ScrollView>
      <Snackbar text={toast?.text ?? null} tone={toast?.tone} onHide={() => setToast(null)} />
    </View>
  );
}

type Run = (key: string, work: () => Promise<unknown>, done?: string) => Promise<void>;

/* ------------------------------------------------------------------ username */

function UsernameCard({ onSaved, initial = "" }: { onSaved: () => void; initial?: string }) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const name = cleanUsername(value);
    if (!name) return setError(t("collab.err.INVALID_USERNAME"));
    setSaving(true);
    try {
      await saveUsername(name);
      setError(null);
      onSaved();
    } catch (e) {
      setError(t(collabErrorKey(apiErrorCode(e), isNetworkError(e)) as StringKey));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card tone="accent" style={{ gap: spacing.sm }}>
      <Text variant="headline">{t("collab.username.title")}</Text>
      <Text variant="callout" color="secondary">
        {t("collab.username.body")}
      </Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={t("collab.username.placeholder")}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={21}
        accessibilityLabel={t("collab.username.label")}
        style={[styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md, backgroundColor: colors.surface }]}
      />
      <Text variant="caption" color={error ? "danger" : "tertiary"}>
        {error ?? t("collab.username.hint")}
      </Text>
      <Button title={t("collab.username.save")} onPress={() => void save()} loading={saving} />
    </Card>
  );
}

/* ------------------------------------------------------------------ requests */

function RequestsTab({ data, busy, run, onOtherTime }: { data: Data; busy: string | null; run: Run; onOtherTime: (id: string) => void }) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const { incoming } = data.connections;
  if (!incoming.length && !data.cards.length && !data.notices.length) {
    return <EmptyState icon={<Icon name="people" size={28} color={colors.textTertiary} />} title={t("collab.requests.empty.title")} text={t("collab.requests.empty.text")} />;
  }
  return (
    <>
      {incoming.length ? (
        <View style={{ gap: spacing.xs }}>
          <SectionTitle title={t("collab.requests.people")} />
          {incoming.map((c) => (
            <ListItem
              key={c.connectionId}
              title={personLabel(c.user)}
              subtitle={c.user.username && c.user.displayName ? c.user.displayName : undefined}
              leading={<Icon name="user" color={colors.textSecondary} />}
              trailing={
                <View style={[styles.row, { gap: spacing.xs }]}>
                  <Button title={t("collab.action.accept")} kind="tonal" size="sm" loading={busy === `acc-${c.connectionId}`} onPress={() => void run(`acc-${c.connectionId}`, () => answerConnection(c.connectionId, true))} />
                  <Button title={t("collab.action.decline")} kind="ghost" size="sm" onPress={() => void run(`dec-${c.connectionId}`, () => answerConnection(c.connectionId, false))} />
                </View>
              }
            />
          ))}
        </View>
      ) : null}
      {data.cards.length ? (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle title={t("collab.requests.cards")} />
          {data.cards.map((s) => (
            <TaskCardRequest key={s.id} s={s} busy={busy} run={run} onOtherTime={onOtherTime} />
          ))}
        </View>
      ) : null}
      {data.notices.length ? (
        <View style={{ gap: spacing.xs }}>
          <SectionTitle title={t("collab.requests.activity")} />
          {data.notices.slice(0, 20).map((n) => (
            <NoticeRow key={n.id} n={n} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function TaskCardRequest({ s, busy, run, onOtherTime }: { s: SharedTask; busy: string | null; run: Run; onOtherTime: (id: string) => void }) {
  const { t } = useLocale();
  const { spacing } = useTheme();
  const owner = personLabel(s.owner);
  const lead = s.reapproval ? t("collab.card.changed", { name: owner }) : t(s.kind === "COLLAB" ? "collab.card.together" : "collab.card.assigned", { name: owner });
  const others = s.participants.filter((p) => p.role === "member" && p.user.id !== s.owner.id).map((p) => p.user);
  const meta = [dueLabel(s.dueDate, s.dueTime), formatDuration(s.durationMinutes)].filter(Boolean).join(" · ");
  return (
    <Card tone={s.reapproval ? "warning" : undefined} style={{ gap: spacing.sm }}>
      <Text variant="callout" color="secondary">
        {lead}
      </Text>
      <Text variant="headline">{s.title}</Text>
      {s.description ? (
        <Text variant="callout" numberOfLines={3}>
          {s.description}
        </Text>
      ) : null}
      <Text variant="caption" color="secondary" tabular>
        {meta}
      </Text>
      {s.kind === "COLLAB" && others.length > 1 ? (
        <Text variant="caption" color="tertiary">
          {t("collab.card.with", { names: others.map(personLabel).join(", ") })}
        </Text>
      ) : null}
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        <Button title={t("collab.card.accept")} kind="tonal" size="sm" loading={busy === `card-${s.id}`} onPress={() => void run(`card-${s.id}`, () => acceptSharedTask(s.id))} />
        <Button title={t("collab.card.otherTime")} kind="secondary" size="sm" onPress={() => onOtherTime(s.id)} />
        <Button title={t("collab.card.decline")} kind="ghost" size="sm" loading={busy === `no-${s.id}`} onPress={() => void run(`no-${s.id}`, () => declineSharedTask(s.id))} />
      </View>
    </Card>
  );
}

const NoticeRow = memo(function NoticeRow({ n }: { n: Notice }) {
  const { t } = useLocale();
  const { colors } = useTheme();
  const when = n.payload?.proposed ? dueLabel(n.payload.proposed.dueDate, n.payload.proposed.dueTime) : "";
  const key = `collab.notice.${n.kind}` as StringKey;
  return (
    <ListItem
      title={t(key, { name: personLabel(n.actor), title: n.payload?.title ?? "", when })}
      subtitle={relativeTime(n.createdAt)}
      leading={<Icon name={n.read ? "bell" : "info"} color={n.read ? colors.textTertiary : colors.accent} />}
    />
  );
});

/* ------------------------------------------------------------------ people */

function PeopleTab({ data, busy, run, onRefresh }: { data: Data; busy: string | null; run: Run; onRefresh: () => void }) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [editingName, setEditingName] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Search a username prefix (3+) or a whole email, debounced; an older request is aborted when the text changes.
  const search = useCallback((text: string) => {
    abort.current?.abort();
    if (!searchable(text)) return setResults(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    searchPeople(text, ctrl.signal).then(
      (r) => !ctrl.signal.aborted && setResults(r),
      () => undefined,
    );
  }, []);
  useEffect(() => {
    const id = setTimeout(() => search(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q, search]);

  const refreshSearch = () => {
    search(q);
    onRefresh();
  };

  const remove = (connectionId: string, name: string) =>
    Alert.alert(t("collab.remove.title", { name }), t("collab.remove.body"), [
      { text: t("collab.remove.keep"), style: "cancel" },
      {
        text: t("collab.remove.confirm"),
        style: "destructive",
        onPress: () =>
          void run(`rm-${connectionId}`, async () => {
            const r = await removeConnection(connectionId);
            if (!r.removed) Alert.alert(t("collab.err.OPEN_SHARED_TASKS"), `${t("collab.remove.blocked", { name })}\n\n${r.openTasks.map((o) => `• ${o.title}`).join("\n")}`);
          }),
      },
    ]);

  const action = (u: SearchResult) => {
    const key = `req-${u.id}`;
    if (u.state === "connected") return <Chip small label={t("collab.action.connected")} leading={<Icon name="check" size={14} color={colors.success.fg} />} />;
    if (u.state === "requested") return <Chip small label={t("collab.action.requested")} leading={<Icon name="clock" size={14} color={colors.textSecondary} />} />;
    if (u.state === "incoming" && u.connectionId) {
      const id = u.connectionId;
      return <Button title={t("collab.action.accept")} kind="tonal" size="sm" loading={busy === key} onPress={() => void run(key, () => answerConnection(id, true)).then(refreshSearch)} />;
    }
    return <Button title={t("collab.action.add")} kind="tonal" size="sm" loading={busy === key} icon={<Icon name="plus" size={16} color={colors.accent} />} onPress={() => void run(key, () => requestConnection(u.id)).then(refreshSearch)} />;
  };

  const { connected, outgoing } = data.connections;
  return (
    <>
      {data.summary.username ? (
        editingName ? (
          <UsernameCard
            initial={data.summary.username}
            onSaved={() => {
              setEditingName(false);
              onRefresh();
            }}
          />
        ) : (
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Text variant="callout" color="secondary" style={styles.flex}>
              {t("collab.username.yours", { name: data.summary.username })}
            </Text>
            <Button title={t("collab.username.change")} kind="ghost" size="sm" onPress={() => setEditingName(true)} />
          </View>
        )
      ) : null}
      <View style={{ gap: spacing.xs }}>
        <Text variant="label">{t("collab.search.label")}</Text>
        <View style={[styles.row, styles.input, { borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md, gap: spacing.sm, backgroundColor: colors.surface }]}>
          <Icon name="search" size={18} color={colors.textTertiary} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t("collab.search.placeholder")}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={80}
            accessibilityLabel={t("collab.search.label")}
            style={[styles.flex, type.body, { color: colors.text, minHeight: 46 }]}
          />
          {q ? <IconButton icon={<Icon name="close" size={16} color={colors.textSecondary} />} accessibilityLabel={t("common.close")} onPress={() => setQ("")} /> : null}
        </View>
      </View>
      {q.trim() && !searchable(q) ? (
        <Text variant="caption" color="secondary">
          {t("collab.search.hint")}
        </Text>
      ) : null}
      {results ? (
        results.length ? (
          <View>
            {results.map((u) => (
              <ListItem
                key={u.id}
                title={personLabel(u)}
                subtitle={[u.username ? u.displayName : null, u.email].filter(Boolean).join(" · ")}
                leading={<Icon name="user" color={colors.textSecondary} />}
                trailing={action(u)}
              />
            ))}
          </View>
        ) : (
          <Text variant="callout" color="secondary">
            {t("collab.search.none", { q: q.trim() })}
          </Text>
        )
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <SectionTitle title={t("collab.people.yours")} />
        {connected.length ? (
          connected.map((c) => (
            <ListItem
              key={c.connectionId}
              title={personLabel(c.user)}
              subtitle={c.user.username && c.user.displayName ? c.user.displayName : undefined}
              leading={<Icon name="user" color={colors.accent} />}
              trailing={
                <IconButton
                  icon={<Icon name="trash" color={colors.danger.fg} />}
                  accessibilityLabel={t("collab.action.remove", { name: personLabel(c.user) })}
                  disabled={busy === `rm-${c.connectionId}`}
                  onPress={() => remove(c.connectionId, personLabel(c.user))}
                />
              }
            />
          ))
        ) : (
          <EmptyState icon={<Icon name="people" size={28} color={colors.textTertiary} />} title={t("collab.people.empty.title")} text={t("collab.people.empty.text")} />
        )}
      </View>
      {outgoing.length ? (
        <View style={{ gap: spacing.xs }}>
          <SectionTitle title={t("collab.people.sent")} />
          {outgoing.map((c) => (
            <ListItem
              key={c.connectionId}
              title={personLabel(c.user)}
              subtitle={relativeTime(c.at)}
              leading={<Icon name="clock" color={colors.textSecondary} />}
              trailing={<Button title={t("collab.action.cancelRequest")} kind="ghost" size="sm" loading={busy === `out-${c.connectionId}`} onPress={() => void run(`out-${c.connectionId}`, () => removeConnection(c.connectionId))} />}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ shared */

function SharedTab({ data, busy, run, onEdit, onOpenTask }: { data: Data; busy: string | null; run: Run; onEdit: (id: string) => void; onOpenTask: (taskId: string) => void }) {
  const { t } = useLocale();
  const { colors } = useTheme();
  const myId = useAuth().dbUser?.id ?? null;
  if (!data.shared.length) {
    return <EmptyState icon={<Icon name="people" size={28} color={colors.textTertiary} />} title={t("collab.shared.empty.title")} text={t("collab.shared.empty.text")} />;
  }
  return (
    <>
      {data.shared.map((s) => (
        <SharedCard key={s.id} s={s} me={myId} busy={busy} run={run} onEdit={onEdit} onOpenTask={onOpenTask} />
      ))}
    </>
  );
}

const SharedCard = memo(function SharedCard({
  s,
  me,
  busy,
  run,
  onEdit,
  onOpenTask,
}: {
  s: SharedTask;
  me: string | null;
  busy: string | null;
  run: Run;
  onEdit: (id: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const { done, total } = doneCount(s.participants.map((p) => p.state));
  const meta = [
    t(s.kind === "COLLAB" ? "collab.shared.together" : "collab.shared.assigned"),
    s.isOwner && s.kind === "ASSIGN" ? t("collab.shared.notOnTimeline") : null,
    s.isOwner ? null : t("collab.shared.from", { name: personLabel(s.owner) }),
  ]
    .filter(Boolean)
    .join(" · ");
  const confirmRemove = (userId: string, name: string) =>
    Alert.alert(t("collab.shared.removeConfirm", { name, title: s.title }), t("collab.shared.removeBody"), [
      { text: t("collab.shared.cancelNo"), style: "cancel" },
      { text: t("collab.shared.removeYes"), style: "destructive", onPress: () => void run(`remove-${s.id}-${userId}`, () => removeSharedMember(s.id, userId)) },
    ]);
  const confirmLeave = () =>
    Alert.alert(t("collab.shared.leaveConfirm", { title: s.title }), t("collab.shared.leaveBody"), [
      { text: t("collab.shared.cancelNo"), style: "cancel" },
      { text: t("collab.shared.leaveYes"), style: "destructive", onPress: () => void run(`leave-${s.id}`, () => leaveSharedTask(s.id)) },
    ]);
  const confirmCancel = () =>
    Alert.alert(t("collab.shared.cancelConfirm", { title: s.title }), t("collab.shared.cancelBody"), [
      { text: t("collab.shared.cancelNo"), style: "cancel" },
      { text: t("collab.shared.cancelYes"), style: "destructive", onPress: () => void run(`cancel-${s.id}`, () => cancelSharedTask(s.id)) },
    ]);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Text variant="headline" style={styles.flex}>
          {s.title}
        </Text>
        {s.cancelled ? <Chip small label={t("collab.shared.cancelled")} leading={<Icon name="close" size={14} color={colors.textSecondary} />} /> : null}
      </View>
      <Text variant="caption" color="secondary">
        {meta}
      </Text>
      <Text variant="caption" color="secondary" tabular>
        {[dueLabel(s.dueDate, s.dueTime), formatDuration(s.durationMinutes), t("collab.shared.progress", { done, total })].filter(Boolean).join(" · ")}
      </Text>
      <View style={{ gap: spacing.xs }}>
        {s.participants.map((p) => {
          const isMe = p.user.id === me;
          return (
            <View key={p.user.id} style={{ gap: spacing.xs }}>
              <View style={[styles.row, { gap: spacing.sm }]}>
                <Icon name="user" size={18} color={colors.textSecondary} />
                <Text variant="callout" style={styles.flex} numberOfLines={1}>
                  {personLabel(p.user)}
                  {isMe ? ` (${t("collab.you")})` : ""}
                </Text>
                <StateChip state={p.state} />
                {s.isOwner && !s.cancelled && p.role === "member" && !isMe ? (
                  <Button
                    title={t("collab.shared.removeMember")}
                    kind="ghost"
                    size="sm"
                    loading={busy === `remove-${s.id}-${p.user.id}`}
                    accessibilityLabel={t("collab.shared.removeConfirm", { name: personLabel(p.user), title: s.title })}
                    onPress={() => confirmRemove(p.user.id, personLabel(p.user))}
                  />
                ) : null}
              </View>
              {p.proposedChange ? (
                <Text variant="caption" color="warning" style={{ paddingStart: spacing.xl + spacing.xs }}>
                  {t("collab.shared.proposed", { when: dueLabel(p.proposedChange.dueDate, p.proposedChange.dueTime) })}
                </Text>
              ) : null}
              {s.isOwner && !s.cancelled && p.state === "declined" ? (
                <Button
                  title={t("collab.shared.resend")}
                  kind="ghost"
                  size="sm"
                  loading={busy === `resend-${s.id}-${p.user.id}`}
                  style={{ alignSelf: "flex-start", marginStart: spacing.xl }}
                  onPress={() => void run(`resend-${s.id}-${p.user.id}`, () => resendSharedTask(s.id, p.user.id))}
                />
              ) : null}
            </View>
          );
        })}
      </View>
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        {s.myTaskId ? <Button title={t("collab.shared.openMine")} kind="secondary" size="sm" onPress={() => onOpenTask(s.myTaskId!)} /> : null}
        {s.isOwner && !s.cancelled ? (
          <>
            <Button title={t("collab.shared.edit")} kind="secondary" size="sm" icon={<Icon name="edit" size={16} color={colors.accent} />} onPress={() => onEdit(s.id)} />
            <Button title={t("collab.shared.cancel")} kind="ghost" size="sm" loading={busy === `cancel-${s.id}`} onPress={confirmCancel} />
          </>
        ) : null}
        {!s.isOwner && !s.cancelled ? <Button title={t("collab.shared.leave")} kind="ghost" size="sm" loading={busy === `leave-${s.id}`} onPress={confirmLeave} /> : null}
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  flex: { flex: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, minHeight: 48 },
});
