import { StyleSheet, View } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import type { DocumentChatCard } from "../../types/models";
import { Icon } from "../icons/Icon";
import { Button, Card, Text } from "../ui";

/**
 * A document sent in chat (documents/chatUpload.ts on the server): what was found and what was added. Review opens
 * the usual review screen for that document.
 */
export function DocumentCard({ card, onOpen }: { card: DocumentChatCard; onOpen?: (documentId: string) => void }) {
  const { t } = useLocale();
  const { colors, spacing } = useTheme();
  const found = card.deadlines + card.schedules;
  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <Icon name="doc" size={20} color={colors.textSecondary} />
        <Text variant="bodyStrong" numberOfLines={1} style={styles.flex}>
          {card.fileName}
        </Text>
      </View>
      {found ? (
        <Text variant="caption" color="secondary">
          {t("docs.card.counts", { deadlines: String(card.deadlines), classes: String(card.schedules), added: String(card.added) })}
        </Text>
      ) : null}
      {card.warning ? (
        <Text variant="caption" color="warning">
          {card.warning}
        </Text>
      ) : null}
      {onOpen && found ? (
        <Button
          title={card.toReview ? t("docs.card.review", { count: String(card.toReview) }) : t("docs.card.open")}
          size="sm"
          kind={card.toReview ? "primary" : "secondary"}
          onPress={() => onOpen(card.documentId)}
          style={styles.start}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  start: { alignSelf: "flex-start" },
});
