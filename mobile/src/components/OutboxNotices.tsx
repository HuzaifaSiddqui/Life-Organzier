import { useEffect, useState } from "react";
import { Snackbar } from "./ui";
import { useLocale } from "../i18n/LocaleProvider";
import { onOutboxRejected } from "../services/outbox";

/**
 * App-wide notice for a change made offline that the server refused once it was sent (services/outbox.ts). The
 * screen that made it has already been left; its next refresh shows the server's copy again.
 */
export function OutboxNotices() {
  const { t } = useLocale();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => onOutboxRejected(({ op }) => setText(t("offline.rejected", { label: op.label ?? "" }))), [t]);
  return <Snackbar text={text} tone="warning" onHide={() => setText(null)} />;
}
