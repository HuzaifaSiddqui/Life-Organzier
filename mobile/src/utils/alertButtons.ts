/** The button shape React Native's Alert.alert takes (services/dialog.ts keeps the same signature). */
export type AlertButton = { text?: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };

export type DialogButton = { label: string; kind: "primary" | "secondary" | "tonal" | "danger"; onPress?: () => void; cancel: boolean };

/**
 * Alert buttons → the in-app dialog's buttons (web / desktop, where Alert.alert does nothing). No buttons → one "OK".
 * Cancel goes first (start side), the rest keep their order; destructive is "danger", the last other one is the
 * single primary (design rule: one primary per view), earlier ones are tonal.
 */
export function dialogButtons(buttons: AlertButton[] | undefined, okLabel: string): DialogButton[] {
  const list = buttons?.length ? buttons : [{ text: okLabel }];
  const cancels = list.filter((b) => b.style === "cancel");
  const others = list.filter((b) => b.style !== "cancel");
  const lastPlain = [...others].reverse().find((b) => b.style !== "destructive");
  return [
    ...cancels.map((b): DialogButton => ({ label: b.text || okLabel, kind: "secondary", onPress: b.onPress, cancel: true })),
    ...others.map(
      (b): DialogButton => ({
        label: b.text || okLabel,
        kind: b.style === "destructive" ? "danger" : b === lastPlain ? "primary" : "tonal",
        onPress: b.onPress,
        cancel: false,
      }),
    ),
  ];
}

/**
 * What closing the dialog without a choice (scrim, Esc) does: the cancel button's action, else `onDismiss`
 * (Alert.alert's option), else nothing.
 */
export function dismissAction(buttons: AlertButton[] | undefined, onDismiss?: () => void): (() => void) | undefined {
  return buttons?.find((b) => b.style === "cancel")?.onPress ?? onDismiss;
}
