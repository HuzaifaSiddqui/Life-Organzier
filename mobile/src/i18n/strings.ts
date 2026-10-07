/**
 * UI copy. English is the source of truth; Urdu must define every key (enforced by the type).
 * Screens add their keys here as they migrate. Interpolate with {name}.
 */
const en = {
  "common.retry": "Try again",
  "common.close": "Close",
  "common.back": "Go back",
  "common.cancel": "Cancel",
  "common.help": "Help: {title}",
  "common.example": "Example",
  "common.gotIt": "Got it",
  "common.dontShowAgain": "Don't show again",

  "sync.offline": "Offline",
  "sync.offlinePending.one": "Offline · 1 change saved on this phone",
  "sync.offlinePending.other": "Offline · {count} changes saved on this phone",
  "sync.syncing": "Syncing…",
  "sync.failed": "Sync failed",
  "sync.pending.one": "1 change waiting to sync",
  "sync.pending.other": "{count} changes waiting to sync",

  "conflict.title": "This changed in two places",
  "conflict.body": "You edited this on your phone while it also changed in the cloud. Which version should we keep?",
  "conflict.mine": "On this phone",
  "conflict.cloud": "In the cloud",
  "conflict.keepMine": "Keep mine",
  "conflict.useCloud": "Use cloud version",

  "error.offline.title": "You're offline",
  "error.offline.body": "Check your connection. Anything you change is saved on this phone.",
  "error.timeout.title": "That took too long",
  "error.timeout.body": "The server is slow right now. Please try again in a moment.",
  "error.server.title": "Something went wrong on our side",
  "error.server.body": "It's not you. Please try again shortly.",
  "error.generic.title": "Couldn't load this",
  "error.generic.body": "Please try again.",
  "error.assistant.title": "Assistant unavailable",
  "error.assistant.body": "Your tasks still work. Try the assistant again later.",

  "restart.title": "Restart to switch layout",
  "restart.body": "The app needs to restart to change reading direction.",
} as const;

export type StringKey = keyof typeof en;

const ur: Record<StringKey, string> = {
  "common.retry": "دوبارہ کوشش کریں",
  "common.close": "بند کریں",
  "common.back": "واپس جائیں",
  "common.cancel": "منسوخ کریں",
  "common.help": "مدد: {title}",
  "common.example": "مثال",
  "common.gotIt": "سمجھ گیا",
  "common.dontShowAgain": "دوبارہ نہ دکھائیں",

  "sync.offline": "آف لائن",
  "sync.offlinePending.one": "آف لائن · 1 تبدیلی اس فون پر محفوظ ہے",
  "sync.offlinePending.other": "آف لائن · {count} تبدیلیاں اس فون پر محفوظ ہیں",
  "sync.syncing": "ہم آہنگ ہو رہا ہے…",
  "sync.failed": "ہم آہنگی ناکام",
  "sync.pending.one": "1 تبدیلی ہم آہنگی کی منتظر ہے",
  "sync.pending.other": "{count} تبدیلیاں ہم آہنگی کی منتظر ہیں",

  "conflict.title": "یہ دو جگہ تبدیل ہوا ہے",
  "conflict.body": "آپ نے فون پر اس میں تبدیلی کی جبکہ کلاؤڈ میں بھی یہ بدل گیا۔ کون سا ورژن رکھیں؟",
  "conflict.mine": "اس فون پر",
  "conflict.cloud": "کلاؤڈ میں",
  "conflict.keepMine": "میرا رکھیں",
  "conflict.useCloud": "کلاؤڈ والا استعمال کریں",

  "error.offline.title": "آپ آف لائن ہیں",
  "error.offline.body": "اپنا کنکشن چیک کریں۔ آپ کی تبدیلیاں اس فون پر محفوظ ہیں۔",
  "error.timeout.title": "بہت دیر لگ گئی",
  "error.timeout.body": "سرور ابھی سست ہے۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔",
  "error.server.title": "ہماری طرف کچھ مسئلہ ہوا",
  "error.server.body": "غلطی آپ کی نہیں۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔",
  "error.generic.title": "یہ لوڈ نہیں ہو سکا",
  "error.generic.body": "براہ کرم دوبارہ کوشش کریں۔",
  "error.assistant.title": "اسسٹنٹ دستیاب نہیں",
  "error.assistant.body": "آپ کے کام ٹھیک چل رہے ہیں۔ اسسٹنٹ کو بعد میں دوبارہ آزمائیں۔",

  "restart.title": "ترتیب بدلنے کے لیے ری اسٹارٹ کریں",
  "restart.body": "پڑھنے کی سمت بدلنے کے لیے ایپ کو دوبارہ شروع کرنا ہوگا۔",
};

export const dictionaries = { en, ur } as const;
export type Language = keyof typeof dictionaries;
