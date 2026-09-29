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
- **Mobile base URL:** `EXPO_PUBLIC_API_BASE_URL`, normalized to end with `/api` (`mobile/src/constants/config.ts`). Example: `http://<host>:5000/api` (backend default port is `process.env.PORT ?? 5000` in `server.ts`).

**Non-prefixed endpoints (no `/api`):**

- `GET /health` → `{ ok: true }`
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
