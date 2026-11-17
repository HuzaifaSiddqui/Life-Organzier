# Push notifications — setup

Push keeps every phone's reminders current when something changes elsewhere:
- **A silent "sync" push** after any change made on another device (app requests that change tasks, routines,
  settings, chat, documents: `push/pushRules.ts changesUserData`) and after any change made on WhatsApp. The phone's
  background task (`mobile/src/services/notificationActions.ts`) syncs and re-plans its local alarms **without the app
  being opened**. The device that made the change is left out; a burst of changes sends one push (2.5 s).
- **A visible one** for a task or routine added on WhatsApp ("Added from WhatsApp") and for task sharing: the phone
  shows it itself, with the app's notification look.

Without push everything else works; the phone catches up when the app is opened (or at the 6-hour sync).

## Default: Firebase Cloud Messaging (no Expo account)

The backend sends with **firebase-admin** (`FcmPushProvider`), using the service account it already has for sign-in.
1. Firebase console → Project settings → Your apps → the **Android app** `com.anonymous.lifeorganizer` (add it if
   missing) → download **`google-services.json`** into `mobile/` (git-ignored; never commit it).
2. `app.json` has `"android": { "googleServicesFile": "./google-services.json" }`; a prebuild copies it and applies
   the Google Services Gradle plugin. Rebuild the APK (native change).
3. Google Cloud console: the **Firebase Cloud Messaging API** must be enabled, and the backend's service account
   (`FIREBASE_CLIENT_EMAIL`, `firebase-adminsdk-…@<project>.iam.gserviceaccount.com`) needs the role
   **Firebase Cloud Messaging API Admin** (IAM & Admin → IAM → edit the account → Add role). Without it every send
   fails with `messaging/mismatched-credential` ("Permission 'cloudmessaging.messages.create' denied"), while
   sign-in still works (verifying tokens needs no permission).
4. Open the app once and allow notifications: it registers its FCM token (`PushToken` row, platform `android`).
   Messages are **data-only** (`type`, and `loTitle` / `loBody` when something should be shown), high priority.

Phones whose battery saver freezes background apps (Tecno / Infinix / Xiaomi…) may not run that task until the app is
opened. No phone setting is needed for reminders, though: every minute the server checks the task reminders that just
came due, and sends each one as a **visible** FCM notification (shown by Android itself, app frozen or not) to every
phone whose last reminder-plan fetch (`PushToken.planSyncedAt`, set by `GET /reminders/plan` with `X-Device-Id`) is
older than the task's last change (`push/missedReminders.ts`). Phones that are up to date get nothing from it, so a
reminder never arrives twice. These fallback notifications have no buttons (a tap opens the task); routines are
left out (they repeat, so the phone already has them).

## Alternative: Expo push

Used instead when the app config has an EAS project id (tokens `ExponentPushToken[…]` go through Expo; the backend
routes per token, `RoutingPushProvider`). Expo pushes are always visible, so the silent sync push is FCM-only.

### One-time prerequisites (Expo route)

1. **EAS project id.** In `mobile/`: `npx eas-cli init` (logs in to your Expo account and writes
   `expo.extra.eas.projectId` into `app.json`). The app reads it from the config; it is never hard-coded.
2. **Firebase / FCM (Android).** As step 1 above.
3. **FCM V1 key in EAS.** Firebase console → Project settings → Service accounts → generate a private key.
   Then `npx eas-cli credentials` → Android → *Google Service Account Key for Push Notifications (FCM V1)* →
   upload it. Expo uses it to deliver to Android.
4. **Rebuild the dev client** (native config changed): `npx expo run:android` (or an EAS development build),
   then restart Metro with `-c`.
5. Optional: enable *Enhanced security for push* in the Expo dashboard and set `EXPO_ACCESS_TOKEN` in
   `backend/.env`.

## Manual test checklist

Prerequisites above done, backend running, a Pro account with WhatsApp linked (`docs/whatsapp-e2e-checklist.md`).
Check the database with `npx prisma studio` (table `PushToken`).

**Register**
- [ ] Fresh install → sign in → allow notifications. A `PushToken` row appears for the user (platform `android`,
      a `deviceId`). Backend and Metro logs show no token text.
- [ ] Kill and reopen the app → still one row (same token, `updatedAt` newer).
- [ ] With notifications denied → no row, no prompt from the push code, the app works normally.

**WhatsApp-created task → push → sync**
- [ ] App in the background: send "Complete math assignment by Friday 3 PM" to the bot → a notification
      "Added from WhatsApp · Complete math assignment" arrives within seconds (channel: the app's sound + vibrate one).
- [ ] Tap it → the app opens and the task is in the list without pulling to refresh; its local reminders are
      scheduled (Settings → "Re-plan reminders" count goes up, or wait for the reminder).
- [ ] App in the foreground: send another task → the banner shows and the task list updates by itself.
- [ ] Send a timetable photo/PDF on WhatsApp → one push listing the created items.
- [ ] Create a task in the app's own chat → no push.

**Invalid token removed**
- [ ] Uninstall the app (the token row stays), then create a task on WhatsApp → Expo reports
      DeviceNotRegistered and the row is deleted (at once, or after the receipt check about 15 minutes later).

**Sign-out stops pushes**
- [ ] Sign out (online) → the row is deleted; a task created on WhatsApp now gives no push.
- [ ] Airplane mode → sign out → turn the network back on and reopen the app → the row is deleted within a minute
      (queued sign-out retry); no push for new WhatsApp tasks.
- [ ] Sign out offline, then sign back in before going online → pushes keep working (the queued removal is cancelled).

## Privacy

The push text (the task title) passes through Expo's push service and Google's Firebase Cloud Messaging
(Apple's on iOS) to reach the phone. Nothing else about the task is sent. Tokens are never logged.
