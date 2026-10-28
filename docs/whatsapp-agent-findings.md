# WhatsApp Agent API: findings

What the WhatsApp Agent API actually does, as measured by `npm run wa:probe` (see
[whatsapp-agent.md](whatsapp-agent.md#how-to-run-the-probe-phase-0)). Every value here is **redacted**: field names,
value types, MIME types, sizes, durations, status codes and timings only; no message text, names, phone numbers, ids
or keys.

**Status: the probe has not been run yet.** Until it has, every row is the community implementation's claim, not a
measurement. Rows move to *Confirmed* (with the probe run's date) or *Different* (with what was seen).

| # | Question | Community claim (unverified) | Probe result |
|---|---|---|---|
| 1 | Base URL and auth | `https://api.whatsapp.com/agent/v1`, `Authorization: Bearer <key>` | pending |
| 2 | `/updates` envelope | Unknown; code accepts an array or `{result \| updates \| data \| items \| messages: [...]}` | pending (step 1 `poll_envelope`) |
| 3 | Update id type, step | Unknown; code accepts number or string | pending (`offset_semantics.updateIdType`, `idStep`) |
| 4 | Acknowledge with `offset = last + 1`? Re-delivered without it? | Assumed Telegram-style | pending (`redeliveredWithoutOffset`, `redeliveredAfterOffsetLastPlus1`) |
| 5 | Long-poll hold time with `timeout=25` | ~25 s | pending (`poll.held`) |
| 6 | Text message shape | Unknown; code reads `message.text` (string or `{body}`), `body`, `caption` | pending (`update` kind text) |
| 7 | Voice note: shape, MIME, size, duration, format | Unknown | pending (`update` kind voice, `media.magicHex` — `4f676753` = Ogg) |
| 8 | Photo: shape, MIME, size | Unknown | pending |
| 9 | PDF: shape, MIME, size, file name field | Unknown | pending |
| 10 | `GET /media/{id}`: bytes or a URL? | Unknown; code handles both | pending (`media.returns`) |
| 11 | `POST /messages` body that works | Unknown; code sends `{chat_id, text}` (or `{text}` without a chat ref) | pending (`send.variant`, `requestShape`) |
| 12 | `POST /messages` response shape | Unknown | pending (`send.responseShape`) |
| 13 | Agent-first message after ≥ 30 quiet minutes | **Unconfirmed**; reminders stay off until this is yes *and* the message arrived | pending (step 4 `proactive.accepted` + your phone) |
| 14 | `POST /statuses` (read receipts) body | Unknown; code sends `{message_id, status: "read", chat_id}` best effort | not probed (avoids extra calls) |
| 15 | Limits: 12/min messages, statuses, each media method; 15/min polls | Claimed | not tested on purpose; a 429 seen in normal use is recorded |
| 16 | Text limit 4000 soft / 4096 hard | Claimed | not tested; the server splits at 4000 |
| 17 | Non-creator → 403 code 131005; second poller → 409; bad key → 400 code 100 / 401 | Claimed | 409 / 401 are recorded if they happen |
| 18 | Not end-to-end encrypted | Claimed (shown to users) | can't be measured by the probe |
| 19 | Media size and format limits, retention, Pakistan availability | Unknown | partly: sizes seen; availability = whether Agents appear in your WhatsApp |

## After the probe

1. Fill the table from `backend/.probe/findings-*.json` (it is already redacted; check it before sharing).
2. Tighten `backend/src/modules/whatsappAgent/shapes.ts` and the send body in `client.ts` to the real shapes.
3. Replace the assumed shapes in `backend/tests/fakes/fakeAgentServer.ts` with the recorded ones and add contract
   tests that parse the redacted fixtures.
4. If row 13 is confirmed (accepted **and** delivered), reminders can be turned on with `WHATSAPP_AGENT_REMINDERS=on`.
