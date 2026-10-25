/**
 * Command replies in English and Urdu, picked by the user's language setting, the same way the rest of the
 * assistant does it (LOCATION_TEXT in dialogue.ts, RESPONSE_TEXT in checkins/templates.ts). Covers the shared
 * runtime replies (confirm, re-ask, expiry, undo), settings and bulk commands. Routine, task and insight
 * replies are still English (listed in docs/known-limitations.md).
 */

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const en = {
  yes: "Yes",
  no: "No",
  cancel: "Cancel",
  undo: "Undo",
  yesOrNo: "Please answer yes or no.",
  pickNumber: "Please reply with one of the numbers above.",
  answerAbove: "Please answer the question above, or say cancel.",
  cancelled: "Okay, I left everything as it was.",
  neverMind: "Okay, never mind.",
  expired: "That preview is more than 10 minutes old, so I didn't do it. Want to see it again?",
  showAgain: "Show it again",
  undone: (label: string) => `↩ Undone: ${label}.`,
  invalid: "I didn't quite get the details. Could you say it another way?",
  unknown: "Sorry, I can't do that from chat yet.",
  // settings
  quietRead: (start: string, end: string, criticalOff: boolean) => `Your quiet hours are ${start} to ${end}. No reminders then, except critical ones${criticalOff ? " (off for you)" : ""}.`,
  quietChange: "Change them",
  quietSame: "Quiet hours need different start and end times.",
  quietSet: (start: string, end: string) => `Quiet hours are now ${start} to ${end}.`,
  dndOnUntil: (when: string) => `Do Not Disturb is on until ${when}.`,
  dndOff: "Do Not Disturb is off.",
  dndAlreadyOff: "Do Not Disturb is already off.",
  dndTurnedOff: "Do Not Disturb is off. Reminders are back on.",
  dndOn: (when: string, duration: string, hint: boolean, critical: boolean) =>
    `Do Not Disturb is on until ${when} (${duration}).${hint ? ' Say "DND for 2 hours" for longer.' : ""}${critical ? " Critical reminders still come through." : ""}`,
  turnOff: "Turn off",
  devices: { ALL: "your phone and WhatsApp", PHONE: "your phone only", WHATSAPP: "WhatsApp only", DESKTOP: "desktop only" } as Record<string, string>,
  devicesRead: (where: string) => `Reminders go to ${where}.`,
  devicesPro: "WhatsApp reminders are part of Pro. Your reminders stay on your phone.",
  devicesUnlinked: "Link WhatsApp first: open Settings → WhatsApp and send me the LINK code shown there.",
  openSettings: "Open settings",
  devicesAlready: (where: string) => `Reminders already go to ${where}.`,
  devicesSet: (where: string, whatsapp: boolean) => `Reminders now go to ${where}.${whatsapp ? " WhatsApp can only message you within 24 hours of your last message there." : ""}`,
  languageNames: { en: "English", ur: "اردو (Urdu)" } as Record<string, string>,
  languageRead: (current: string, other: string) => `I'm replying in ${current}. Say "switch to ${other}" to change it.`,
  settingsTitle: "Your settings:",
  settingsLines: { language: "Language", quiet: "Quiet hours", devices: "Reminders go to", checkins: "Check-ins", capacity: "Daily capacity", work: "work hours", plan: "Plan", on: "on", off: "off" },
  to: "to",
  // bulk
  bulkNothingToday: "Nothing is due or planned today, so there's nothing to move.",
  bulkMovePreview: (count: number, day: string) => `Move ${n(count, "task", "tasks")} from today to ${day}?`,
  bulkMoved: (count: number, day: string) => `Moved ${n(count, "task", "tasks")} to ${day}.`,
  bulkNoTag: (tag: string) => `No open tasks are tagged #${tag}.`,
  bulkTagPreview: (count: number, tag: string) => `Mark ${n(count, "task", "tasks")} tagged #${tag} as done?`,
  bulkTagDone: (count: number, tag: string) => `Done: ${n(count, "task", "tasks")} tagged #${tag}. Nice work!`,
  bulkNoCompleted: "You have no completed tasks to delete.",
  bulkNoOpen: "You have no open tasks to delete.",
  bulkDeletePreview: (count: number, open?: boolean) => `Delete ${n(count, open ? "open task" : "completed task", open ? "open tasks" : "completed tasks")}? You can undo this for 24 hours.`,
  bulkDeleted: (count: number, open?: boolean) => `Deleted ${n(count, open ? "open task" : "completed task", open ? "open tasks" : "completed tasks")}. You can undo this for 24 hours.`,
  bulkNoNonUrgent: "There's nothing non-urgent due by tomorrow. You're all clear.",
  bulkPostponePreview: (count: number) => `Move ${n(count, "non-urgent task", "non-urgent tasks")} one day later?`,
  bulkPostponed: (count: number) => `Moved ${n(count, "task", "tasks")} one day later. Take care of yourself first.`,
  bulkMore: (extra: number) => `…and ${extra} more`,
  bulkCapped: (cap: number, total: number) => `That's the first ${cap} of ${total}; ask again for the rest.`,
  cardWillChange: "Will change",
  cardMoved: "Moved",
  cardCompleted: "Completed",
  cardPostponed: "Postponed",
};

type Copy = typeof en;

const ur: Copy = {
  yes: "ہاں",
  no: "نہیں",
  cancel: "منسوخ",
  undo: "واپس کریں",
  yesOrNo: "براہِ کرم ہاں یا نہیں میں جواب دیں۔",
  pickNumber: "براہِ کرم اوپر دیے گئے نمبروں میں سے ایک بھیجیں۔",
  answerAbove: "براہِ کرم اوپر والے سوال کا جواب دیں، یا منسوخ لکھیں۔",
  cancelled: "ٹھیک ہے، میں نے کچھ نہیں بدلا۔",
  neverMind: "ٹھیک ہے، رہنے دیں۔",
  expired: "یہ پیش منظر 10 منٹ سے پرانا ہے، اس لیے میں نے کچھ نہیں کیا۔ دوبارہ دکھاؤں؟",
  showAgain: "دوبارہ دکھائیں",
  undone: () => "↩ آخری تبدیلی واپس کر دی گئی۔",
  invalid: "مجھے تفصیل پوری سمجھ نہیں آئی۔ کسی اور طرح سے کہہ سکتے ہیں؟",
  unknown: "معذرت، یہ کام ابھی چیٹ سے نہیں ہو سکتا۔",
  quietRead: (start, end, criticalOff) => `آپ کے خاموش اوقات ${start} سے ${end} تک ہیں۔ اس دوران صرف ضروری یاددہانیاں آتی ہیں${criticalOff ? " (آپ کے لیے وہ بھی بند ہیں)" : ""}۔`,
  quietChange: "تبدیل کریں",
  quietSame: "خاموش اوقات کا آغاز اور اختتام مختلف ہونا چاہیے۔",
  quietSet: (start, end) => `خاموش اوقات اب ${start} سے ${end} تک ہیں۔`,
  dndOnUntil: (when) => `ڈو ناٹ ڈسٹرب ${when} تک آن ہے۔`,
  dndOff: "ڈو ناٹ ڈسٹرب بند ہے۔",
  dndAlreadyOff: "ڈو ناٹ ڈسٹرب پہلے ہی بند ہے۔",
  dndTurnedOff: "ڈو ناٹ ڈسٹرب بند کر دیا۔ یاددہانیاں دوبارہ آئیں گی۔",
  dndOn: (when, duration, hint, critical) =>
    `ڈو ناٹ ڈسٹرب ${when} تک آن ہے (${duration})۔${hint ? " زیادہ دیر کے لیے \"DND for 2 hours\" کہیں۔" : ""}${critical ? " ضروری یاددہانیاں پھر بھی آئیں گی۔" : ""}`,
  turnOff: "بند کریں",
  devices: { ALL: "آپ کے فون اور واٹس ایپ", PHONE: "صرف آپ کے فون", WHATSAPP: "صرف واٹس ایپ", DESKTOP: "صرف ڈیسک ٹاپ" },
  devicesRead: (where) => `یاددہانیاں ${where} پر آتی ہیں۔`,
  devicesPro: "واٹس ایپ یاددہانیاں Pro کا حصہ ہیں۔ آپ کی یاددہانیاں فون پر ہی رہیں گی۔",
  devicesUnlinked: "پہلے واٹس ایپ جوڑیں: Settings ← WhatsApp کھولیں اور وہاں دکھایا گیا LINK کوڈ مجھے بھیجیں۔",
  openSettings: "سیٹنگز کھولیں",
  devicesAlready: (where) => `یاددہانیاں پہلے ہی ${where} پر آتی ہیں۔`,
  devicesSet: (where, whatsapp) => `یاددہانیاں اب ${where} پر آئیں گی۔${whatsapp ? " واٹس ایپ آپ کے آخری پیغام کے 24 گھنٹے کے اندر ہی پیغام بھیج سکتا ہے۔" : ""}`,
  languageNames: { en: "English (انگریزی)", ur: "اردو" },
  languageRead: (current, other) => `میں ${current} میں جواب دے رہا ہوں۔ بدلنے کے لیے "switch to ${other}" کہیں۔`,
  settingsTitle: "آپ کی سیٹنگز:",
  settingsLines: { language: "زبان", quiet: "خاموش اوقات", devices: "یاددہانیاں", checkins: "چیک اِن", capacity: "روزانہ گنجائش", work: "کام کے اوقات", plan: "پلان", on: "آن", off: "بند" },
  to: "سے",
  bulkNothingToday: "آج کچھ طے یا واجب نہیں، اس لیے منتقل کرنے کو کچھ نہیں۔",
  bulkMovePreview: (count, day) => `آج کے ${count} کام ${day} پر منتقل کر دوں؟`,
  bulkMoved: (count, day) => `${count} کام ${day} پر منتقل کر دیے۔`,
  bulkNoTag: (tag) => `#${tag} والا کوئی کھلا کام نہیں۔`,
  bulkTagPreview: (count, tag) => `#${tag} والے ${count} کام مکمل کر دوں؟`,
  bulkTagDone: (count, tag) => `#${tag} والے ${count} کام مکمل ہو گئے۔ شاباش!`,
  bulkNoCompleted: "حذف کرنے کے لیے کوئی مکمل کام نہیں۔",
  bulkNoOpen: "حذف کرنے کے لیے کوئی کھلا کام نہیں۔",
  bulkDeletePreview: (count, open) => `${count} ${open ? "کھلے" : "مکمل"} کام حذف کر دوں؟ 24 گھنٹے تک واپس لا سکتے ہیں۔`,
  bulkDeleted: (count, open) => `${count} ${open ? "کھلے" : "مکمل"} کام حذف کر دیے۔ 24 گھنٹے تک واپس لا سکتے ہیں۔`,
  bulkNoNonUrgent: "کل تک کوئی غیر ضروری کام واجب نہیں۔ سب ٹھیک ہے۔",
  bulkPostponePreview: (count) => `${count} غیر ضروری کام ایک دن آگے کر دوں؟`,
  bulkPostponed: (count) => `${count} کام ایک دن آگے کر دیے۔ پہلے اپنا خیال رکھیں۔`,
  bulkMore: (extra) => `…اور ${extra} مزید`,
  bulkCapped: (cap, total) => `یہ ${total} میں سے پہلے ${cap} ہیں؛ باقی کے لیے دوبارہ کہیں۔`,
  cardWillChange: "تبدیل ہوں گے",
  cardMoved: "منتقل",
  cardCompleted: "مکمل",
  cardPostponed: "آگے کیے گئے",
};

export function commandText(language: string | null | undefined): Copy {
  return language === "ur" ? ur : en;
}

/** "today" / "tomorrow" / a weekday in the reply language (relativeDayLabel is English). */
export function dayLabelFor(language: string | null | undefined, englishLabel: string): string {
  if (language !== "ur") return englishLabel;
  const map: Record<string, string> = { today: "آج", tomorrow: "کل", yesterday: "گزشتہ کل" };
  return map[englishLabel.toLowerCase()] ?? englishLabel;
}
