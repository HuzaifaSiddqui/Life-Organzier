# WhatsApp Agent

**Pro** users connect **their own WhatsApp Agent** to Life Organizer: in WhatsApp they open Settings → Agents,
create an agent, open it → Chat info → API key, and paste the key into the app (Settings → WhatsApp → WhatsApp
Agent). That is the only step. The server does everything else by itself: it checks the key, creates the
connection, starts polling, answers text, voice notes, photos, PDFs and Word files through the same assistant
engine as the app, and sends reminders. Nothing has to be configured on the server: the feature, voice notes and
reminders are **on by default**, and the key-encryption secret is generated on first start.

The existing Twilio WhatsApp number (FR-WA-001/002, `modules/whatsapp/`) is untouched and keeps working; both can
run at the same time.

> **Status of the API facts.** The payload shapes come from a separate project that works against a real agent
> (polling, texts, voice notes, images, media download, replies); see
> [whatsapp-agent-findings.md](whatsapp-agent-findings.md). Not confirmed yet: whether the agent may message
> first, and the documented limits. Meta has not published a manual we could check.

## What is confirmed and what is not

| Item | Status |
|---|---|
| `GET /updates` long poll → `{ entry[].changes[].value.messages[], next_offset }`, 204 when empty; opaque offset | **Confirmed** (working project) |
| Cloud-API messages (`id`, `from: "user:<id>"`, `type`, `text.body`, `image/audio/document {id, mime_type, …}`, `audio.voice`) | **Confirmed** |
| Send `{ messaging_product: "whatsapp", to: "user:<id>", type: "text", text: { body } }` | **Confirmed** |
| Media: `GET /media/{id}` → `{ url, mime_type }`, download from a Meta host with the key | **Confirmed** |
| Second poller → 409 code `1752041` | **Confirmed** |
| The agent can only write to a user who has written to it (`to` comes from an incoming message) | **Confirmed** as far as known: no other recipient form |
| The agent may message first (hours after the user's last message) | **Unconfirmed** — reminders default to WhatsApp **and** the phone |
| Limits: 12/min messages, statuses, each media method; 15/min polls; text 4000/4096 | Community implementation; enforced conservatively |
| Not end-to-end encrypted | Community implementation (shown to users) |
| Read receipts, media size limits, retention | Unconfirmed |

## Configuration (`backend/.env`): nothing required

Everything is on by default; the variables only switch things off or move them.

| Variable | Default | Effect |
|---|---|---|
| `WHATSAPP_AGENT` | on | `off` is the kill switch: no poller runs, the routes answer 404 `FEATURE_OFF`, the card is hidden |
| `WHATSAPP_KEY_SECRET` | generated | Encrypts API keys at rest (32 bytes, 64 hex characters or base64). If unset, the server creates one on first start in `backend/.secrets/whatsapp-key-secret` (git-ignored; `WHATSAPP_KEY_SECRET_FILE` moves it) and logs where. **Back it up**: losing it means every user must paste their key again. An invalid value is an error, never silently replaced |
| `WHATSAPP_AGENT_REMINDERS` | on | `off` stops reminders on WhatsApp for everyone (phones keep their notifications) |
| `WHATSAPP_VOICE` | on | `off` stops transcribing voice notes (users are asked to type) |
| `STT_PROVIDER` | `faster-whisper` | `whisper-local` (whisper.cpp server) or `none` |
| `WHISPER_MODEL` / `WHISPER_PYTHON` | `small` / `python` (`python3` off Windows) | faster-whisper model and interpreter |
| `WHISPER_URL` | `http://127.0.0.1:8178` | The whisper.cpp server for `whisper-local` |
| `WHATSAPP_AGENT_BASE_URL` | `https://api.whatsapp.com/agent/v1` | Only for tests / a different endpoint |

**Pro only.** Connecting needs Pro (403 `PRO_REQUIRED`); Free users see a locked card. A user who goes back to Free
stops being polled at the next minute's rescan (any message before that gets a Pro notice and is not processed);
the connection is kept and polling resumes after upgrading. Reminders go only to Pro users.

**Revert:** set `WHATSAPP_AGENT=off` and restart. Pollers stop; stored connections stay (keys stay
encrypted) and resume when the switch is removed. Phones get reminders as notifications again on their next
sync (the plan's `viaWhatsappAgent` is false when the flag is off). The migration is additive (two tables, two
columns with defaults), so the code can be rolled back without a down-migration.

## Architecture

```
WhatsApp (user's agent) ⇄ Agent API ⇄ [long poll] connectionManager ─ Poller per connection
                                                     │  advisory lock, backoff, 409/429/401 handling
                                                     │  claim update → handle → mark done → save offset
                                                     ▼
                                       whatsappAgent/inbound.ts  (crisis check first)
                         text ─────────────► handleAssistantMessage (channel WHATSAPP_AGENT) ─► reply
                         voice ─► STT ─► "I heard: …" + the same engine
                         photo / PDF / DOCX ─► processDocument (unchanged, autoCreate off)
                                              ─► document_add_items preview (confirm_command, 10 min)
                                       Outbox: priority (reply > reminder > digest), coalescing,
                                       split at 4000, token buckets ─► POST /messages
```

| File | What |
|---|---|
| `backend/src/modules/whatsappAgent/client.ts` | `WhatsAppAgentClient` interface + HTTP client; typed errors `InvalidKeyError`, `ConflictError`, `RateLimitedError{retryAfterMs}`, `ForbiddenError`, `NetworkError`, `MediaTooLargeError`. The key sits in a private field and never appears in errors, logs, `JSON.stringify` or `inspect` |
| `shapes.ts` | Tolerant parsing of updates (id, kind, text, media, chat reference, message id) and `nextOffset` |
| `secrets.ts` | AES-256-GCM with `WHATSAPP_KEY_SECRET`; the user id is the authenticated data (a ciphertext copied to another row doesn't decrypt) |
| `lock.ts` | Postgres session advisory lock per connection on a dedicated one-connection Prisma client |
| `connectionManager.ts` | One poller per CONNECTED connection; start/add/remove/rescan/stop |
| `rateLimiter.ts`, `outbox.ts` | Per-connection token buckets and the outbound queue |
| `inbound.ts` | Text, voice and file handling (English + Roman Urdu replies) |
| `reminders.ts` | Reminder delivery (on by default, Both mode) |
| `service.ts`, `routes.ts` | Connect / status / test / settings / disconnect |
| `backend/src/modules/conversations/conversationContext.ts` | Context window (below) |
| `backend/src/modules/assistant/commands/documents.ts` | Internal `document_add_items` / `document_review` commands |
| `backend/src/ai/stt.ts` | Speech-to-text provider interface |
| `mobile/src/components/WhatsappAgentCard.tsx` | Settings card |

### One engine

Every message goes through `handleAssistantMessage` with channel `WHATSAPP_AGENT`, like the app, voice and the
Twilio number (`assistant/channel.ts`: `isWhatsapp()` covers both WhatsApp channels, so formatting, list caps and
"Added from WhatsApp" pushes behave the same). Crisis detection runs first on every text and voice transcript; a
crisis message gets the resources at once and nothing is stored. Options are numbered with the Twilio path's own
`formatReply` / `whatsappActions`, and "1", "2" … send that option's payload (the action contract and its lint stay
green). Memory is shared across channels.

### Polling, locks and delivery guarantees

- **One poller per key.** A Postgres session advisory lock (namespace `WAAG`, key from the connection id) on a
  dedicated one-connection client. Checked before every poll, so a lost database session stops the poller instead
  of letting two run. A dead process releases its locks with its session; another instance takes over on its next
  minute rescan.
- **Long poll** with `timeout=25`, at most 15 polls a minute. Network errors back off exponentially with full jitter
  (0.5 s – 60 s).
- **401, or 400 with code 100** → `NEEDS_RECONNECT`, the poller stops, the user gets a push ("WhatsApp needs
  reconnecting", data `{type: "sync"}` so the phone also re-plans its reminders). **403** → `ERROR`, same. **409** →
  wait 30–35 s and re-check the lock. **429** → the poll bucket waits for Retry-After (a minute if absent);
  `rateLimitedUntil` drives the "Paused for a minute" chip.
- **No duplicates.** Each message id is claimed in `WhatsAppProcessedUpdate` before it is handled; a repeat is
  skipped. The API's `next_offset` is saved only after the whole batch was handled. An update claimed but not finished (crash) gets one "Sorry, I missed your
  last message. Please send it again." when that connection's poller starts again. Rows are purged after 7 days.
- **No history replay.** Connecting reads the backlog once and starts after the newest message. The newest
  sender is kept (encrypted) as the chat to answer, so a user who already wrote to the agent can send a test at once.
- **Who to send to.** The agent can only write to `from` of a message the user sent. Until the user has written once,
  "Send test message" answers `NO_CHAT_YET`, reminders stay on the phone, and the card asks the user to say hi.
- **Graceful shutdown** (SIGINT/SIGTERM) aborts the open polls, waits for the current message and releases the locks.

### Rate limits and the outbound queue

Per connection: 12 messages, 12 statuses, 12 media downloads, 12 uploads and 15 polls a minute (token buckets that
start full and refill evenly). Replies go before reminders, reminders before digests. Whatever is queued with the
same priority when the sender is free is joined into one message (a burst of reminders becomes one). Text longer
than 4000 characters is split on paragraph, line or word boundaries. A 429 waits (up to 3 times per part), network
errors are retried 3 times with backoff; a rejected key fails everything queued. Read receipts are best effort and
only sent when the status budget has room right now.

### Context window (`conversationContext.ts`)

Per user and channel: the last 8 turns inside 30 minutes, about 600 tokens (oldest dropped first), CNIC and phone
numbers masked; plus the last reply's options and the last list shown. Used in exactly three places:

1. **Open questions** (`dropStaleQuestion`): after 30 quiet minutes an open question and the "2nd task" list are
   dropped, so an old "which day?" can't swallow a new message.
2. **Numbered replies**: "1" picks from the last reply's options only while they are in the window (a reminder's
   options carry their own 6-hour expiry).
3. **Router / intent prompt**: the window's turns replace the stored history passed to `handleAssistantMessage`
   (`history`), so the LLM sees trimmed, masked context.

Deterministic code still owns dates (entities.ts), data, scheduling and safety (crisis.ts).

### Documents

Photos (JPEG, PNG, WebP), PDFs and Word files (DOCX) up to **10 MB** (the app's own limit). The declared size is
checked before downloading and the download stops at 10 MB. Other types or larger files get a clear reply. The file
goes through the **existing pipeline unchanged** (`processDocument`, all gates: OCR confidence, AI-only items, dates
must appear in the document) with **`autoCreate: false`**: nothing from WhatsApp is ever created automatically. The
reply lists the dated items (8 at most, "…and N more"), says how many need a date, and offers
`1. Add all  2. Review in app  3. Ignore` as a `confirm_command` (10-minute expiry; "Show again" after that).
"Add all" uses the same code as the app's review screen (`documents/applyItems.ts`), skipping items that exist.

### Voice notes

On by default (the user can turn it off in the card). At most 2 minutes / 5 MB. The note is downloaded and
transcribed **locally** with **faster-whisper**, the same way the working test project does it
(`backend/scripts/transcribe.py`, CPU, int8; audio never leaves the server and its temporary file is deleted). The
app's own voice input uses the phone's speech recognizer, which can't read WhatsApp audio. The transcript is handled
as text and the reply starts with `I heard: "…"`. If faster-whisper isn't installed (checked at most every 10 min)
the user gets "please type your message"; a failure, noise or low confidence → "Sorry, I couldn't make that out.
Could you type it?". The card says "On, but the server can't transcribe right now" while it is unavailable.

Install once on the server: `python -m pip install -r backend/scripts/requirements-voice.txt`. The model downloads on
first use (`small` ≈ 0.5 GB). `WHISPER_MODEL=base` or `tiny` is faster on a slow machine, `medium` better for Urdu;
`WHISPER_PYTHON` picks the interpreter. One note is transcribed at a time; each run loads the model (about 10 s on
a laptop CPU for a short note). `STT_PROVIDER=whisper-local` uses a whisper.cpp server instead
(`whisper-server -m models/ggml-small.bin --convert --port 8178`, `WHISPER_URL`).

Other candidates if local is too slow (not implemented; verify each one's terms before approving):

| Candidate | Where the audio goes | Notes |
|---|---|---|
| **faster-whisper, local** (default, implemented) | Stays on the server | `pip install faster-whisper`; as in the working test project |
| whisper.cpp, local (`STT_PROVIDER=whisper-local`, implemented) | Stays on the server | Open source. Needs whisper.cpp built with `whisper-server`, a multilingual model (`ggml-small.bin` ≈ 0.5 GB, `medium` better for Urdu) and ffmpeg for WhatsApp's Ogg/Opus: `whisper-server -m models/ggml-small.bin --convert --port 8178`. No npm dependency. CPU latency depends on the machine |
| OpenAI transcription API | OpenAI | Not implemented. Per OpenAI's API terms API data is not used for training by default and may be kept for a limited time for abuse monitoring; check the current policy |
| Google Cloud Speech-to-Text (`ur-PK`, `en-PK`) | Google Cloud | Not implemented. Data logging is opt-in; check current terms |
| Gemini (already an optional LLM provider) | Google | Not implemented. Free-tier terms differ from paid-tier terms on use of data; check before approving |

Roman Urdu: Whisper-family models write spoken Urdu in Urdu script unless steered, and forcing English can translate
instead of transliterate. The benchmark (`npm run stt:bench -- <folder>`, notes + `.txt` references, file names with
`ru` count as Roman Urdu) reports word error rate and latency per language. **Not run yet: it needs your recordings.**

### Reminders (on by default)

`UserSettings.waAgentReminders`: `BOTH` (WhatsApp and phone notifications, the default), `WHATSAPP` (WhatsApp
instead of phone notifications) or `OFF` (phone only). Pro users with a connected agent only. Because the default is
`BOTH`, a reminder WhatsApp doesn't deliver (agent-first sends are unconfirmed) still arrives as a notification. The same planner as the phone (`planReminders`: quiet hours, DND, mandatory routines, the 60-slot cap)
decides what is due; the job runs every minute and serves only connections polled by that instance. Each reminder
is claimed before sending (task rows SCHEDULED/SNOOZED → SENDING; routine reminders get a ReminderLog row), so
overlapping runs never send twice. In `WHATSAPP` mode the reminder plan tells the phone (`settings.viaWhatsappAgent`)
to leave task and routine reminders out, so nothing arrives twice within the same minute; in `BOTH` the user chose
both. Messages carry numbered actions that reuse the push buttons' handlers: tasks `1 Done, 2 Snooze 15 min`;
routines `1 Done, 2 Snooze 15 min, 3 Skip today`. A failed send goes out as a push in `WHATSAPP` mode (status
`SENT_PUSH`) and the card shows "A reminder couldn't be sent on WhatsApp, so it came as a phone notification."; a key
that needs reconnecting turns `viaWhatsappAgent` off, and the reconnect push makes the phone re-plan.

## API (`/api/whatsapp-agent`, signed in, own connection only)

| Route | Body / answer |
|---|---|
| `GET /status` | `{ enabled, pro, connected, status, keyLast4, polling, lastPollAt, rateLimitedUntil, lastError, consentAt, reminders: {setting, available}, voice: {setting, available, ready} }`. Never the key |
| `POST /connect` | `{ apiKey, consent: true }` → status. Pro only (403 `PRO_REQUIRED`). One validation poll. Errors: 400 `INVALID_KEY`, 403 `NOT_CREATOR`, 409 `KEY_IN_USE`, 429 `RATE_LIMITED`, 502 `NOT_AVAILABLE` / `UNREACHABLE`; 5 per 10 minutes per user |
| `POST /test` | Sends a short test message; 3 a minute |
| `PATCH /settings` | `{ reminders?: "OFF" \| "WHATSAPP" \| "BOTH", voice?: boolean }`; 409 `REMINDERS_UNAVAILABLE` / `VOICE_UNAVAILABLE` when switched off on the server |
| `DELETE /` | Stops the poller, deletes the connection and its key. Reminders go back to the phone at once (nothing is sent without a connection); the user's choice is kept for next time |

## Privacy position

- Chats with a WhatsApp agent are **not end-to-end encrypted**; Meta handles them. The app says so and requires
  explicit consent before connecting.
- The API key is a secret: encrypted at rest (AES-256-GCM), only its last 4 characters are stored in clear, it is
  never returned, logged or put in an error. The chat reference is encrypted the same way (it may be a phone number).
  A test scans console output, API responses and the database for the key.
- The probe prints and saves only field names, value types and a short allowlist of non-personal facts.
- Message text is never logged; activity events record only the message kind.

## Hosting

Outbound polling only: no webhook and no public URL, so it works from a laptop without a tunnel. It needs an
always-on process (messages wait at Meta while the server is down and are fetched on the next poll, if the API
keeps them; retention is unconfirmed). Several instances are safe (advisory lock), but each connection's send budget
lives on the instance that polls it.

## How to run the probe (Phase 0)

1. Create an agent in WhatsApp (Settings → Agents) and copy its API key (Chat info → API key).
2. Stop the Life Organizer server if it is connected with that key (a second poller gets 409).
3. In `backend/`, in your shell (not in a file):
   - PowerShell: `$env:WHATSAPP_AGENT_API_KEY = "<key>"; npm run wa:probe -- listen`
   - bash: `WHATSAPP_AGENT_API_KEY='<key>' npm run wa:probe -- listen`
4. When it says so, send the agent: a short text, a voice note, a photo and a PDF, waiting for each to show up. It
   replies once to the text. Ctrl+C saves and stops early.
5. Later, after at least 30 minutes with no message to the agent: `npm run wa:probe -- proactive --quiet 30`. Then
   check your phone: did the message arrive? (The API accepting it isn't proof of delivery.)
6. Findings are written to `backend/.probe/findings-*.json` (git-ignored, redacted). Read it, then share it to update
   [whatsapp-agent-findings.md](whatsapp-agent-findings.md), the parser and the contract tests.

The probe spaces polls (≤ 12/min) and sends (≥ 10 s apart), stops at the first 429 and never tests limits on purpose.
If the send body is wrong it tries up to 4 forms (stopping at the first that works, or at a 403); a known form can be
forced with `WHATSAPP_AGENT_PROBE_SEND_BODY='{"chat_id":"$CHAT","text":"$TEXT"}'`.

## FRD deviation note

FR-WA-001/002 specify **one Life Organizer WhatsApp number** reached through the WhatsApp Business API (Twilio
webhook), with replies and reminders limited to the 24-hour customer-service window, Pro-only reminders and the
Business API's template/cost rules. This path is different: **each user connects their own WhatsApp Agent** and the
server polls it with that user's key. What changes:

- No business number, webhook or public URL; no per-message Business API cost. Availability depends on Meta's
  Agents rollout (beta) instead of a Twilio account.
- The 24-hour window may not apply, but whether the agent may message first is unconfirmed, so reminders go to
  WhatsApp **and** the phone by default (FR-WA-002's window rule is replaced by that double path).
- Not end-to-end encrypted, unlike a normal WhatsApp chat (the Business API has the same property).
- Pro only, like FR-WA's WhatsApp features.
- Everything else in FR-WA-001 holds: text, voice (transcribed, when approved), images/PDFs, multi-turn context,
  the same commands, clarifying questions. The Twilio implementation stays in place, so the FRD path is still
  available; this path is an additional, flag-guarded channel.

## Known limitations

See [known-limitations.md](known-limitations.md#whatsapp-agent).

## Phone checklist

1. Settings → WhatsApp Agent: read the steps and privacy notice, paste the key, agree, Connect → chip "Connected",
   key shown as ••••last4. If you never wrote to the agent, the card asks you to send it "hi" first.
2. Send test message → it arrives in the agent's chat.
3. Text "Add assignment due Friday 3 PM" → reply; the task is in the app.
4. Voice note (faster-whisper installed on the server) → reply starts "I heard: …" (about 10 s); without it → "please type".
5. Photo of a timetable / deadline sheet → summary with 1 / 2 / 3; nothing created yet; "1" → added.
6. PDF → same; a ZIP or a > 10 MB file → clear refusal.
7. Numbered reply: "help" → "1" runs the first option.
8. Reminders (default Both): make a task due soon → the reminder arrives on WhatsApp and as a notification; choose
   "WhatsApp" in the card → only on WhatsApp; "2" snoozes 15 min.
9. As a Free user: the card is locked; switch a connected user to Free → within a minute WhatsApp messages get the
   Pro notice and are not processed.
10. Regenerate the key in WhatsApp → push "WhatsApp needs reconnecting", chip "Needs reconnect"; paste the new key.
11. Disconnect → the poller stops; reminders come as notifications again.
