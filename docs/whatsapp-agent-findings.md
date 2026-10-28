# WhatsApp Agent API: findings

What the WhatsApp Agent API actually does. Two sources:

- **Working project** — the separate test project (`D:\Academic\BSE\FYP\Whatsapp agen api key test`), which
  polls a real agent, receives texts, voice notes and images, downloads media, transcribes voice notes locally and
  replies. Life Organizer's client, parser and fake server (`backend/tests/fakes/fakeAgentServer.ts`) follow it.
- **Probe** — `npm run wa:probe` (redacted: field names, types, MIME types, sizes, status codes only).

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Base URL and auth | `https://api.whatsapp.com/agent/v1`, `Authorization: Bearer <key>` | Working project |
| 2 | `GET /updates` | `?offset&limit&timeout`; 200 → `{ entry: [{ changes: [{ value: { messages: [...] } }] }], next_offset: "<opaque string>" }`; **204** with no body when nothing new | Working project |
| 3 | Offset | Opaque: send back `next_offset` as received. Messages have their own ids (`id`), used to de-duplicate | Working project |
| 4 | Message shape | WhatsApp Cloud API: `{ id, from: "user:<id>", timestamp, type, text?: { body }, image / audio / video / document / sticker?: { id, mime_type, caption?, filename? } }`; voice notes are `type: "audio"` with `audio.voice: true` | Working project |
| 5 | Send | `POST /messages` `{ messaging_product: "whatsapp", to: "user:<id>", type: "text", text: { body } }`; `to` is the `from` of a message the user sent | Working project |
| 6 | Media | `GET /media/{id}` → `{ url, mime_type, … }`; the file is downloaded from `url` (a Meta host) with the same Bearer key. Voice notes are Ogg/Opus, photos JPEG | Working project |
| 7 | Upload | `POST /media` multipart (`messaging_product`, `type`, `file`) → `{ id }`; a document is then sent as `{ type: "document", document: { id, filename } }` | Working project |
| 8 | Second poller | 409 with error code `1752041` | Working project |
| 9 | Local transcription | faster-whisper "small" on CPU: a real voice note took 11.3 s (model load included), language detected, confidence 0.66 | Working project's script, run from Life Organizer |
| 10 | Agent messages first (reminders without a recent user message) | **Unconfirmed.** Reminders therefore default to WhatsApp **and** the phone | Probe step 4 pending |
| 11 | Recipient before any inbound message | **None known**: replies and reminders need the user to have written once | Working project |
| 12 | `POST /statuses` (read receipts) | Unconfirmed; sent best effort in the Cloud form `{ messaging_product, status: "read", message_id }` | — |
| 13 | Limits: 12/min messages, statuses, each media method; 15/min polls; text 4000 soft / 4096 hard | Community implementation; not tested on purpose | — |
| 14 | Non-creator → 403 code 131005; bad key → 400 code 100 / 401 | Community implementation | — |
| 15 | Not end-to-end encrypted | Community implementation (shown to users) | — |
| 16 | Media size limits, retention, availability in Pakistan | Unknown (Agents work on the developer's own account in Pakistan) | — |

## Still to do

1. Probe step 4 (`npm run wa:probe -- proactive --quiet 30`): if the agent-first message is accepted **and**
   arrives, "WhatsApp only" reminders are safe; until then the default "Both" keeps the phone notification.
2. Save one redacted `findings-*.json` from the probe and add it as a contract-test fixture.
