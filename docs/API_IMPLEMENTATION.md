# Life Organizer — API implementation reference

This document describes how the REST API is structured, which server and client functions implement each concern, and the TypeScript types used on the mobile app. It matches the current codebase (FYP-1).

---

## Base URL and stack

| Layer | Technology |
|--------|------------|
| Server | Node.js + **Express** (`backend/src/app.ts`, `backend/src/server.ts`) |
| Auth | **Firebase Admin** verifies `Authorization: Bearer <Firebase ID token>` (`backend/src/middleware/authMiddleware.ts`) |
| Database | **PostgreSQL** via **Prisma** (`backend/prisma/schema.prisma`) |
| Mobile HTTP | **Axios** singleton (`mobile/src/services/api.ts`) |

- **API prefix:** all JSON routes are mounted under `/api` (see `createApp()` in `backend/src/app.ts`).
- **Mobile base URL:** `EXPO_PUBLIC_API_BASE_URL`, normalized to end with `/api` (`mobile/src/constants/config.ts`). Example: `http://<host>:5050/api` (port comes from `PORT` in `backend/.env`, 5050 in this project; code default is 5000).

**Non-prefixed endpoints (no `/api`):**

- `GET /health` → `{ ok: true, ai: { enabled, available, models: { checked, chat, embeddings, missing } } }`
- `GET /` → short service banner with links

---

## Response envelope

All JSON API handlers use helpers from `backend/src/utils/apiResponse.ts`.

### Success

```ts
{ success: true, message: string, data: T }
```

- `sendSuccess(res, data, message?, status?)` — default HTTP **200**, **201** for task create.

### Error

```ts
{ success: false, message: string, error: string }
```

- `sendError(res, message, errorCode, status)` — e.g. `UNAUTHORIZED`, `VALIDATION_ERROR`, `USER_NOT_FOUND`.

### Mobile types

```48:49:mobile/src/types/models.ts
export type ApiSuccess<T> = { success: true; message: string; data: T };
export type ApiError = { success: false; message: string; error: string };
```

Helpers: `isApiError`, `unwrap` in `mobile/src/services/api.ts`.

---

## Authentication

1. The **mobile app** signs in with **Firebase Auth** (`mobile/src/lib/firebase`).
2. Before each request, Axios attaches:

```11:17:mobile/src/services/api.ts
api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

3. The **backend** validates the token with Firebase Admin and attaches `req.firebase` (`uid`, `email`, etc.):

```26:34:backend/src/middleware/authMiddleware.ts
    const decoded = await getFirebaseAuth().verifyIdToken(token);
    req.firebase = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
      picture: decoded.picture,
    };
```

There is **no custom JWT** issued by this API; the bearer token is a **Firebase ID token** (JWT format, verified by Firebase).

---

## Endpoints (under `/api`)

### Auth — `POST /api/auth/sync-user`

| Item | Detail |
|------|--------|
| **File** | `backend/src/modules/auth/authRoutes.ts` |
| **Middleware** | `requireFirebaseUser` |
| **Service** | `syncUserFromFirebase` in `backend/src/modules/users/userService.ts` |
| **Purpose** | Upsert `User` in Postgres from Firebase claims (email required). |

**Mobile usage:** `api.post("/auth/sync-user", {})` in `mobile/src/context/AuthContext.tsx` (after sign-in / profile refresh).

**Response data:** `{ user: User }` (Prisma user shape, serialized as JSON).

---

### Users — `GET /api/users/me`

| Item | Detail |
|------|--------|
| **File** | `backend/src/modules/users/userRoutes.ts` |
| **Middleware** | `requireFirebaseUser` |
| **Service** | `getUserByFirebaseUid` in `userService.ts` |
| **Errors** | **404** `USER_NOT_FOUND` if sync never ran |

**Mobile usage:** `api.get("/users/me")` in `AuthContext.tsx`.

**Response data:** `{ user: User }`.

---

### Tasks — `/api/tasks`

| Item | Detail |
|------|--------|
| **Router** | `backend/src/modules/tasks/taskRoutes.ts` |
| **Middleware** | `requireFirebaseUser` on all routes; `requireDbUser` loads Postgres user by Firebase UID |
| **Validation** | **Zod** schemas `createBody`, `updateBody`, `statusBody` |
| **Services** | `taskService.ts`: `createTask`, `listTasksForUser`, `getTaskForUser`, `updateTask`, `deleteTask`, `setTaskStatus` |

| Method | Path | Handler role |
|--------|------|----------------|
| `POST` | `/api/tasks` | Create task (**201**) |
| `GET` | `/api/tasks` | List current user’s tasks |
| `GET` | `/api/tasks/:id` | Get one task |
| `PUT` | `/api/tasks/:id` | Partial/full update (body fields optional except validation rules) |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `PATCH` | `/api/tasks/:id/status` | Body `{ status: TaskStatus }` only |

**Prisma enums** (also mirrored in mobile `types/models.ts`): `Priority`, `TaskStatus`, `TaskSource`.

**Mobile client:** `mobile/src/services/tasksApi.ts`

| Function | HTTP |
|----------|------|
| `getTasks()` | `GET /tasks` |
| `getTask(id)` | `GET /tasks/:id` |
| `createTask(payload)` | `POST /tasks` |
| `updateTask(id, payload)` | `PUT /tasks/:id` |
| `deleteTask(id)` | `DELETE /tasks/:id` |

**Note:** `PATCH /tasks/:id/status` exists on the server but is **not** wrapped in `tasksApi.ts`; the app updates status via **`updateTask`** (`PUT`) where needed.

**Create body (Zod):** `title`, `priority`, `source` required; `description`, `dueDate`, `dueTime`, `category`, `status`, `confidence` optional. `dueDate` is an ISO string parsed to `Date` on the server.

---

### Parser — `POST /api/parser/task`

| Item | Detail |
|------|--------|
| **File** | `backend/src/modules/parser/parserRoutes.ts` |
| **Middleware** | `requireFirebaseUser` |
| **Core logic** | `parseTaskFromTextHybrid` in `backend/src/modules/parser/taskParserService.ts` (Ollama semantic extraction plus deterministic rule validation and fallback) |

**Request body (Zod):**

- `text` (required) — natural language task
- `clientTodayYmd` (optional) — `YYYY-MM-DD` for “today” on the device
- `clientNowIso` (optional) — anchor for “in X hours/minutes”
- `clientTimezoneOffsetMinutes` (optional) — `Date#getTimezoneOffset()` from the client

**Mobile usage:** `parseTaskText(text)` in `tasksApi.ts` sends `text` plus client date/time context.

**Response `data`:** matches **`ParsedTask`** on the client (`mobile/src/types/models.ts`): title, optional semantic description, due fields, priority, category, `confidence` (internal clarity input), `needsConfirmation`, flags like `priorityDetected` / `timeDetected`, `dueDateIso`, `dueDateYmd`, etc.

---

### Estimate suggestions (FR-RN-004 §7)

- **`GET /api/events/estimate-suggestion?category=Academic&minutes=120`** → `data.suggestion`: `{ category, original, suggested, ratio, n }` or `null` (no reliable ratio for the category, or the rounded-to-15-min adjustment differs by less than 15 min). Never applied automatically.
- **`POST /api/events/estimate-suggestion`** — body `{ action: "SHOWN" | "ACCEPTED", category, original, suggested, taskId? }` logs `ESTIMATE_SUGGESTION_SHOWN` / `ESTIMATE_SUGGESTION_ACCEPTED` (the chat draft card logs its own server-side; accepting it sends `{ type: "accept_estimate", minutes }` to `POST /api/assistant/message`).
- Insights lists the `estimate_ratio:<category>` patterns returned by `GET /api/insights`.

### Location reminders (FR-LB-001)

Saved places are reusable; tasks link to them. The phone monitors geofences; the server never tracks location. Create/update/attach need `tier: "PRO"` (403 `PRO_REQUIRED`); list, delete and detach always work.

- **`GET /api/locations`** → `{ locations: SavedLocation[] }` (most used first). `SavedLocation = { id, name, displayAddress, latitude, longitude, radiusM, preset: "PRECISE"|"NEARBY"|"AREA", usageCount, createdAt, updatedAt }`; `displayAddress` is the Nominatim address (null for older places).
- **`POST /api/locations`** — `{ name, latitude, longitude, radiusM?, preset?, displayAddress? }`. Returns the existing place when the name matches (case-insensitive): `{ location, created }`. Radius: explicit value, else the preset's (200 / 350 / 750), else 350. Bounds: lat ±90, lng ±180, radius 100–2000, name 1–100 chars.
- **`PUT /api/locations/:id`** — any of the fields above (409 `LOCATION_NAME_TAKEN` on a duplicate name). **`DELETE /api/locations/:id`** — also removes its task links.
- **`POST /api/tasks/:id/locations`** — `{ savedLocationId }`; increments `usageCount` (attaching twice is a no-op). **`DELETE /api/tasks/:id/locations/:taskLocationId`**. Both return `{ task }`.
- Tasks from `GET /api/tasks`, `GET /api/tasks/:id` and `POST /api/sync` (`changes`) include `locations: [{ id, savedLocationId, name, displayAddress, latitude, longitude, radiusM, preset, usageCount, active, lastTriggeredAt }]`. `active` is false while the task is completed, skipped or deleted. Changing a place or a link bumps the task's `updatedAt` so incremental sync re-sends it.
- **`GET /api/geocode?q=…&near_lat=…&near_lng=…`** → `{ results: [{ name, displayName, latitude, longitude }] }` (max 5; empty on no match or Nominatim error). With `near`: only places within ~30 km, then ~39 km, and only if both are empty anywhere (still ranked towards the user). Without `near`: the country of the user's timezone is added to the query (e.g. "KFC, Pakistan"). **`GET /api/geocode/reverse?lat=…&lng=…`** → `{ result }` or `null`. Nominatim is called at most once per second with User-Agent `LifeOrganizer/1.0 (FYP)`; results are cached in memory for 24 h.

**Chat** (`POST /api/assistant/message`): for Pro users a place named in a new task ("from Ali Medical Store", "ghar ja ke") is attached — saved place first (aliases: ghar/home, uni/university, daftar/kaam/office, masjid/mosque, hostel, library); else Nominatim: one result is attached (saved under the user's words, with its address); 2–4 results are listed as numbered choices (5 or more: the first 4 plus "Open task to search") and the reply "2", part of an address, or "none" resolves it (working-memory pending `location_choice`); none → the reply offers a `location_setup` card to set it on the map. Personal places (home, uni, office, hostel and aliases) are never geocoded: unsaved, they get the same card. The app sends `locationReminders: boolean` (its toggle + permission) in the body; `false` adds "Turn on Location reminders below" and the card (`{ type: "location_setup", taskId, place, saved, remindersOn }`). Free users get the task plus an invitation to Pro. Location commands (intent `manage_location`): "remove the location (from X)", "location hata do", "change/set its location to Y", "set the location of X to Y", "add/check for location of Y", "use Y as the location", and a task named up front ("2nd task from today, change its location to Y"); lead-ins like "ok", "so", "also" are ignored. Once a named place is attached, the title drops "from/at <place>" ("Eat burger from KFC kalma chowk" → "Eat burger"); Free users and places not found keep it. "It/its" is the task just discussed; "the 2nd task", "task 3", "the last one" are positions in the last list shown (state `listed`). A typed pick from a numbered list is at most 5 words.

### WhatsApp (FR-WA, Pro only)

- **`POST /api/whatsapp/webhook`** (Twilio, form-encoded, `X-Twilio-Signature` checked against `PUBLIC_BASE_URL`). Records the `MessageSid` (a repeat returns an empty `<Response/>` and does nothing), answers at once with an empty TwiML and processes in the background; the reply is sent through the Twilio REST API. `LINK <code>` from any number links it; unlinked numbers get instructions (once an hour), linked Free accounts a Pro notice (once a day).
- **`POST /api/whatsapp/link/start`** (auth, Pro) → `{ code, expiresAt, botNumber }`. 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, valid 10 minutes, replaces the previous code; only a hash is stored. 403 `PRO_REQUIRED` for Free.
- **`DELETE /api/whatsapp/link`** (auth) unlinks.
- **`PUT /api/settings/phone` was removed.** The number is set only by the LINK flow. `GET /api/settings` returns `whatsapp: { linked, maskedNumber }` (last 3 digits) instead of the number; `/auth/sync-user` and `/users/me` mask it the same way.
- **Documents** (`POST /api/documents/upload`, `POST /api/documents/text`): the same file (or text) with the same type and language, sent again within 24 h, returns the saved document with `reused: true` instead of a new one; a second identical request while the first is still processing gets the first one's result. `503 OCR_BUSY` ("try again in a minute") when the OCR queue is full or a queued image would start too late for the 150 s limit.
- **Routines** accept and return `intervalDays` (2..30, or null) and `anchorDate` (local `YYYY-MM-DD`, required with
  `intervalDays`): the routine repeats every N days counted from the anchor; frequency/days are then ignored for
  which days count (the server decides). Changing `frequency`, `daysOfWeek` or `dayOfMonth` to a different value
  without `intervalDays` drops the interval; resending the same values (the routine form sends the whole schedule
  on every save) keeps it. An interval change replaces future pending occurrences; completed ones stay.
- **Routines** accept and return `location` (room/venue, max 60). `POST /api/documents/:id/confirm` schedules accept `location`.

### Push (P2)

- **`POST /api/push/register`** (auth) `{ token, platform: "android"|"ios", deviceId? }` saves the device's Expo push token (a token used by another account on the same phone moves to this one). **`DELETE /api/push/register`** `{ token }` removes it (only the owner's). **`POST /api/push/unregister-device`** `{ token, deviceId }` (no login) is used by the phone's sign-out retry queue: it deletes the token only when the device id matches the one it was registered with. Tokens are never logged.

### Check-ins (FR-RN-004)

**`GET /api/reminders/plan?days=7`** now also returns `checkins: PlannedCheckin[]` (separate from `reminders`):

```ts
type PlannedCheckin = {
  id: string; taskId: string;
  kind: "START" | "START_FOLLOWUP" | "COMPLETION" | "COMPLETION_EXTRA";
  category: "START" | "COMPLETION";   // START → Started / Not today · COMPLETION → Done / +30 min / Update…
  fireAt: string; title: string; body: string;
  tone: "FUNNY" | "SERIOUS" | "GENTLE"; offerSplit: boolean;
};
```

Ids are stable across re-plans. Check-ins that drop out of the plan (rescheduled task, done, cap, quiet hours)
are marked `CANCELLED`; the phone should cancel any scheduled notification whose id is no longer in the list.

**`POST /api/checkins/:id/respond`** — body `{ response, respondedAt? }` (`respondedAt` = ISO tap time from the offline queue, clamped to [fireAt, now]; used for respondedAt, startedAt/completedAt and the extra-time base):

| Kind | Allowed responses |
|---|---|
| START, START_FOLLOWUP | `STARTED`, `NOT_TODAY` |
| COMPLETION, COMPLETION_EXTRA | `DONE`, `PLUS_30`, `MORE_15`, `MORE_60`, `PARTIAL_25`, `PARTIAL_50`, `PARTIAL_75`, `DIDNT` |

Response `data`: `{ checkin, task, message, next, suggestion, remainingMinutes, deadlineWarning, refused, alreadyAnswered }`.
`next` is the check-in to schedule immediately (completion after `STARTED`, or the extra-time check-in);
`suggestion` is a reschedule / plan-the-rest slot the user may accept; `refused` (`limit | quiet_hours | dnd`)
comes with a user-facing `message`. Answers are claimed atomically: answering twice (or concurrently) returns `alreadyAnswered: true` and changes nothing. Answers to a `CANCELLED` check-in, or for a task already `COMPLETED`/`SKIPPED`, are recorded but don't change the task (short message, no `next`).
CheckinLog `copySource`: `GEMINI | OLLAMA | LIBRARY | NONE | WITHHELD` (research mode omitted an existing first step).
Errors: 400 `INVALID_RESPONSE`, 404 `CHECKIN_NOT_FOUND`.

**Settings (`PATCH /api/settings`)**: `checkinsEnabled` (boolean, default `true`), `checkinTone`
(`FUNNY` default · `SERIOUS` · `GENTLE`), `checkinResearchMode` (boolean, default `false`).

**Assistant command `find_items`** (`POST /api/assistant/message`): a question that names something to look for ("is there any task related to KFC", "anything with Kalma Chowk", "what do I have at uni", "KFC wala kaam"; English and Roman Urdu) searches the user's open tasks and active routines: title, notes, tags, category, subtasks, place name and address, routine title and location. Reply: "Found N matching …" with one line per item ("· matched in: location"), a `task_list` card and `routine` cards (WhatsApp: text only, at most 8); nothing found → "I couldn't find a task or routine about …" plus up to 2 closest. Filters from the words: completed/all, urgent/high/low priority, `#tag`, overdue / today / tomorrow / this week (dates from entities.ts). English and Urdu replies.

**Assistant intent `set_checkin_style`** (`POST /api/assistant/message`): rules first ("be more serious with
reminders", "change your tone to gentle", "stop joking", "serious ho jao", "mazaq band karo", "turn off
check-ins"), LLM only if unsure. Updates the setting and replies in the user's language with chips for the
other styles (intents in the reply: `checkin_style_set`, `checkin_style_ask`, `checkins_off`, `checkins_on`).

**`GET /health`** also reports `ai.gemini: { configured, model, available, lastError: { type, at } | null }`
(`type`: `rate_limit | unavailable | timeout | not_found | auth | error`).

## Domain types (mobile)

Defined in `mobile/src/types/models.ts`:

| Type | Purpose |
|------|---------|
| `User` | Profile from `/users/me` and sync |
| `Task` | Task entity from CRUD responses |
| `ParsedTask` | NL parse preview from `/parser/task` |
| `Priority` | `"LOW" \| "MEDIUM" \| "HIGH" \| "URGENT"` |
| `TaskStatus` | Includes `PENDING`, `IN_PROGRESS`, `COMPLETED`, `DELETED` |
| `TaskSource` | `"MANUAL" \| "CHAT" \| "VOICE"` |

Database mirror: Prisma `User`, `Task`, enums in `backend/prisma/schema.prisma`.

---

## Higher-level mobile flows (not separate HTTP APIs)

These **use** the APIs above but add client-only behavior:

| Module | Role |
|--------|------|
| `mobile/src/services/createTaskWithReminder.ts` | After `createTask`, schedules or clears **local** notifications via `reminders.ts` |
| `mobile/src/services/parsedNaturalTask.ts` | Clarity threshold, shared due resolution, `createTaskFromParsedNatural` for chat/voice |
| `mobile/src/services/reminders.ts` | `expo-notifications`, AsyncStorage map of notification IDs |
| `mobile/src/utils/datetimeValidation.ts` | Due date/time normalization aligned with manual task forms |

---

## File index (quick lookup)

| Concern | Backend | Mobile |
|---------|---------|--------|
| App bootstrap | `app.ts`, `server.ts` | `App.tsx`, `index.ts` |
| Axios + auth header | — | `services/api.ts` |
| Auth sync / profile | `authRoutes.ts`, `userService.ts` | `context/AuthContext.tsx` |
| Tasks CRUD | `taskRoutes.ts`, `taskService.ts` | `services/tasksApi.ts`, task screens |
| Hybrid NL parse | `parserRoutes.ts`, `taskParserService.ts`, `ai/ai.service.ts`, `ai/providers/ollama.provider.ts` | `parseTaskText` in `tasksApi.ts` |
| API shape | `utils/apiResponse.ts` | `types/models.ts` (`ApiSuccess` / `ApiError`) |

---

## Environment variables (reference)

| Variable | Where | Purpose |
|----------|--------|---------|
| `DATABASE_URL` | Backend | PostgreSQL connection string |
| `PORT` | Backend | Listen port (default `5000` in code) |
| Firebase admin keys / project | Backend `config/firebase.ts` | Verify ID tokens |
| `EXPO_PUBLIC_API_BASE_URL` | Mobile | API base ending with `/api` |

### Local AI environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_ENABLED` | `true` | Disable semantic extraction with `false`; rules still run. |
| `AI_PROVIDER` | `ollama` | Provider selector for the semantic extraction layer. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama server URL. |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Ollama model used for JSON extraction. |
| `OLLAMA_TIMEOUT_MS` | `30000` | Maximum wait before rule-parser fallback. |

This document is intended for FYP documentation and onboarding; it should be updated if routes or envelopes change.

### Gemini pacing and cooldowns

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | Flash model for check-in first steps |
| `GEMINI_THINKING_BUDGET` | `0` | Thinking tokens (off for short JSON jobs) |
| `GEMINI_MIN_INTERVAL_MS` | `4000` | Minimum gap between background Gemini calls |
| `GEMINI_RATE_LIMIT_COOLDOWN_MS` | `600000` | How long Gemini is skipped after a 429 (503/timeouts: 30 s) |
