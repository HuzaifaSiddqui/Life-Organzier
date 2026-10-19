# WhatsApp — manual end-to-end checklist

For a teammate testing FR-WA on real phones with the Twilio sandbox. Unit tests cover the logic
(`backend/tests/whatsapp.test.ts`, `backend/tests/queries.test.ts`); this checks the real Twilio path.

## Setup

1. Twilio console → Messaging → Try it out → **Send a WhatsApp message**. Note the sandbox number
   (e.g. `+14155238886`) and the **join code** (`join <two-words>`).
2. Start the backend: `cd backend && npm run dev` (port from `PORT`, default 5050).
3. Expose it: `ngrok http 5050`. Copy the `https://….ngrok-free.app` URL.
4. `backend/.env` (never commit it):
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` from the Twilio console
   - `TWILIO_WHATSAPP_FROM="+14155238886"` (the sandbox number, E.164)
   - `PUBLIC_BASE_URL="https://….ngrok-free.app"` (no trailing slash; must match exactly or signatures fail)
   - leave `WHATSAPP_ALLOW_UNSIGNED` unset
   Restart the backend.
5. Twilio sandbox settings → **When a message comes in**: `https://….ngrok-free.app/api/whatsapp/webhook`, method POST.
6. On the test phone, send the join message (`join <two-words>`) to the sandbox number. It expires after 72 h
   of inactivity; send it again if messages stop arriving.

## Linking

- [ ] Free account: Settings → WhatsApp shows the Pro-locked card; no code button.
- [ ] Pro account (Settings → turn on the Pro demo switch): "Get link code" shows `LINK XXXXXXXX`, the sandbox number and
      "works for 10 minutes". "Open WhatsApp" opens a chat with the message filled in.
- [ ] Send it → reply "Linked! …". In the app, "I've sent it" now shows "Linked to ••••••NNN".
- [ ] Send `LINK AAAAAAAA` from another phone → the generic "That code didn't work…" reply.
- [ ] Wrong code 5 times from one phone → the 6th `LINK` (even a correct one) gets no reply for an hour.
- [ ] A code older than 10 minutes → generic failure.
- [ ] Unlink in the app → the next message gets the "isn't linked" instructions (at most once an hour).

## Messages (linked Pro account)

- [ ] "Add submit lab report tomorrow 5 PM" → task created once (check the app). Twilio retries don't create duplicates
      (in the Twilio console a retry shows the same MessageSid).
- [ ] Send three messages quickly → three answers, in order.
- [ ] "What's due today?", "aaj kya due hai", "آج کیا جمع کرانا ہے" → a short plain-text list (max 8 + "…and N more").
- [ ] "When is the lab report due?", "lab report kab due hai" → its due time.
- [ ] "What's my most urgent task?" → up to 3, overdue first.
- [ ] With a timetable uploaded (rooms in the document): "where is my class", "agli class kab hai", "kal ki classes" →
      time and room; a class without a room says the room isn't in the timetable.
- [ ] A question that offers options → numbered list; replying "1" acts on option 1.
- [ ] A voice note → "Voice notes aren't supported…".
- [ ] A photo of a timetable or a PDF → "Read your document. Created N items…".
- [ ] A crisis phrase (see `mood/crisis.ts` tests) → the support message with helpline numbers, nothing else.
- [ ] Stop the backend right after sending a message, start it again → within ~5 minutes "Sorry, I missed that, please resend".

## Reminders

- [ ] Settings → Notification devices = "WhatsApp only": the phone schedules no local reminders.
- [ ] Message the bot (opens the 24 h window), create a task due in ~1 h with reminders on → a WhatsApp reminder
      arrives at its reminder time (the job runs every 5 minutes), ending with "1. Done".
- [ ] Reply "done" (or "1") → the task is completed in the app.
- [ ] Turn on Do Not Disturb before a reminder is due → it is not sent.
- [ ] No message to the bot for 24 h → reminders are not sent on WhatsApp (local notifications cover it).
- [ ] A Free account never receives WhatsApp reminders.
