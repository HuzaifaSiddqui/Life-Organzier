/**
 * Compile-time check (no runtime code): every web / desktop build file (`*.web.ts(x)`, picked by Metro for web)
 * exports what its phone file exports, with compatible types. If a phone module gains an export and its web file
 * doesn't, `npx tsc --noEmit` fails here instead of the desktop app failing at runtime.
 */
import type * as CalendarNative from "../services/calendar";
import type * as CalendarWeb from "../services/calendar.web";
import type * as LocationNative from "../services/locationReminders";
import type * as LocationWeb from "../services/locationReminders.web";
import type * as PushNative from "../services/push";
import type * as PushWeb from "../services/push.web";
import type * as RemindersNative from "../services/reminders";
import type * as RemindersWeb from "../services/reminders.web";
import type * as ShareNative from "../services/share";
import type * as ShareWeb from "../services/share.web";
import type * as FirebaseNative from "../lib/firebase";
import type * as FirebaseWeb from "../lib/firebase.web";
import type * as MapNative from "../components/MapPicker";
import type * as MapWeb from "../components/MapPicker.web";

type Covers<Native, Web> = Web extends Pick<Native, keyof Native> ? true : false;
type Assert<T extends true> = T;

export type PlatformParity = [
  Assert<Covers<typeof CalendarNative, typeof CalendarWeb>>,
  Assert<Covers<typeof LocationNative, typeof LocationWeb>>,
  Assert<Covers<typeof PushNative, typeof PushWeb>>,
  Assert<Covers<typeof RemindersNative, typeof RemindersWeb>>,
  Assert<Covers<typeof ShareNative, typeof ShareWeb>>,
  Assert<Covers<typeof FirebaseNative, typeof FirebaseWeb>>,
  Assert<Covers<typeof MapNative, typeof MapWeb>>,
];
