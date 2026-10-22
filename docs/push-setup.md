# Push notifications — setup

Push is used for one thing: a task or routine created on WhatsApp shows up on the phone at once
("Added from WhatsApp"). The push carries `{type: "sync"}`; the app pulls the task and schedules its local
alarms. Without this setup everything else works and the task appears at the next sync (app open).

## One-time prerequisites

1. **EAS project id.** In `mobile/`: `npx eas-cli init` (logs in to your Expo account and writes
   `expo.extra.eas.projectId` into `app.json`). The app reads it from the config; it is never hard-coded.
2. **Firebase / FCM (Android).** In the Firebase console, add an Android app with package
   `com.anonymous.lifeorganizer` (or your package), download **`google-services.json`** into `mobile/`
   and set `"android": { "googleServicesFile": "./google-services.json" }` in `app.json`.
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
