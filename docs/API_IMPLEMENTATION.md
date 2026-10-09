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
