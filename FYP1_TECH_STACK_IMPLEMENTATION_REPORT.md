# Life Organizer FYP-1: Actual Tech Stack Implementation Report

## 1. Project Overview

Life Organizer FYP-1 is an Expo React Native mobile app with a real backend API and PostgreSQL database (via Prisma). The current codebase is not a frontend-only demo: authentication, task CRUD, parser endpoints, and reminder scheduling are implemented and wired end-to-end.

- **Project type:** Mobile app (`mobile/`) + backend API (`backend/`), no web client implementation in this repo.
- **Implemented modules (observed):**
  - Authentication (signup/login/reset/logout) via Firebase Auth.
  - Authenticated backend user sync/profile.
  - Task management: create/list/detail/edit/delete/status update.
  - Three task entry methods: manual, chat-parse, voice-parse.
  - Local reminder scheduling using Expo Notifications.
- **Backend + DB status:** Implemented (`backend/src/*`, `backend/prisma/schema.prisma`).
- **Frontend-only/demo-only areas:**
  - `mobile/src/screens/future/FuturePreviewScreen.tsx` is explicitly FYP-2 preview content.
  - Some requirement docs in `Requirements/` include proposed items not fully implemented in runtime code.
- **Current FYP-1 (30%) scope inferred from code:** Core MVP is focused on auth + task lifecycle + parser-assisted input + reminders; extended future modules are deferred.

---

## 2. Frontend Technology Implementation

### 2.1 Actual Frontend Stack

From `mobile/package.json`:

- React Native (`react-native`), React (`react`)
- Expo (`expo`, `expo-constants`, `expo-system-ui`, `expo-linear-gradient`, `expo-notifications`, `expo-speech-recognition`)
- TypeScript (`typescript`, `@types/react`)
- Navigation (`@react-navigation/native`, `@react-navigation/native-stack`)
- Form + validation (`react-hook-form`, `@hookform/resolvers`, `zod`)
- Networking (`axios`)
- Storage (`@react-native-async-storage/async-storage`)
- UI utilities (`react-native-safe-area-context`, `react-native-screens`, `react-native-svg`)

### 2.2 Frontend Folder/Entry Structure

- `mobile/index.ts` -> Expo entry (`registerRootComponent(App)`).
- `mobile/App.tsx` -> top-level providers + reminder configuration.
- `mobile/src/navigation/` -> `RootNavigator.tsx`, `AuthStack.tsx`, `MainStack.tsx`.
- `mobile/src/screens/` -> auth, tasks, chat, voice, dashboard, profile, future preview.
- `mobile/src/components/` -> shared UI components (task cards, headers, buttons, pickers, waveform).
- `mobile/src/services/` -> API clients, task APIs, reminder service, create+reminder orchestration.
- `mobile/src/utils/` -> date/time normalization and helper logic.
- `mobile/src/context/` -> auth state/provider.
- `mobile/src/types/` -> app types/interfaces.

### 2.3 Navigation and Screen Implementation

- **Auth flow routes:** `Welcome`, `Login`, `Signup`, `ForgotPassword` in `AuthStack.tsx`.
- **Main app routes:** `Dashboard`, `TaskList`, `TaskDetail`, `AddTask`, `EditTask`, `ChatTask`, `VoiceTask`, `Profile`, `FuturePreview` in `MainStack.tsx`.
- `RootNavigator.tsx` decides auth vs main stack using auth context/bootstrap status.

### 2.4 Reusable Components (actual examples)

- `mobile/src/components/TaskCard.tsx` -> task list card rendering.
- `mobile/src/components/DueDateTimePickers.tsx` -> date/time picker controls.
- `mobile/src/components/ScreenHeader.tsx` -> consistent headers.
- `mobile/src/components/GradientPrimaryButton.tsx` -> CTA button styling.
- `mobile/src/components/ListeningWaveform.tsx` -> voice UI feedback.

### 2.5 How Frontend Connects to Backend/Local Logic

- `mobile/src/services/api.ts`
  - Axios instance with auth token injection (`Authorization: Bearer ...`).
- `mobile/src/services/tasksApi.ts`
  - Calls backend `/tasks` and `/parser/task`.
- `mobile/src/services/reminders.ts`
  - Uses `expo-notifications` for local scheduling/canceling.
- `mobile/src/services/createTaskWithReminder.ts`
  - Centralized orchestration for task creation + reminder scheduling.

### 2.6 Feature-to-Frontend Mapping

- **Authentication screens:** `screens/auth/*`.
- **Task dashboard/listing:** `screens/dashboard/DashboardScreen.tsx`, `screens/tasks/TaskListScreen.tsx`.
- **Manual task form:** `screens/tasks/AddTaskScreen.tsx`.
- **Chat task creation:** `screens/chat/ChatTaskScreen.tsx`.
- **Voice task creation:** `screens/voice/VoiceTaskScreen.tsx`.
- **Task edit/delete/detail:** `screens/tasks/EditTaskScreen.tsx`, `TaskDetailScreen.tsx`.
- **Reminder toggle/feedback:** add/edit/detail flows + `services/reminders.ts`.
- **Toast feedback:** handled via navigation params in `TaskListScreen.tsx`.

---

## 3. TypeScript Usage

### 3.1 Where Types Are Defined

- `mobile/src/types/models.ts`
  - `Task`, `User`, `ParsedTask`, `Priority`, `TaskStatus`, `TaskSource`, API envelope types.
- `mobile/src/navigation/MainStack.tsx`
  - `MainStackParamList` for strongly typed route params.
- `mobile/src/services/reminders.ts`
  - `ReminderResult`, `TaskReminderHint`.
- `mobile/src/services/createTaskWithReminder.ts`
  - `CreateTaskApiPayload`, `CreateTaskReminderOptions`.

### 3.2 Type Usage in Core Flows

- **Task consistency:** `Task` typing is used throughout screen/service layers.
- **Parsed chat/voice data:** `ParsedTask` drives confirmation UI and save behavior.
- **Reminder options:** explicit `TaskReminderHint` + discriminated options in create orchestration.
- **API integration:** typed response casting in `tasksApi.ts`.
- **Navigation safety:** stack param typing avoids invalid route payloads.

### 3.3 `any` / weak typing observations

- No widespread `any` usage in the key mobile flow files reviewed.
- Some response parsing still relies on casted shapes rather than runtime schema validation in frontend services.

### 3.4 Practical TypeScript Benefits in this Project

- Prevents shape mismatches between manual/chat/voice task data.
- Reduces reminder misconfiguration by forcing explicit due-date/time hint contracts.
- Keeps route params and screen navigation consistent.
- Improves maintainability across rapidly changing FYP iterations.

---

## 4. Authentication Implementation

### Auth Technology Used

- **Primary auth:** Firebase Authentication (client-side in mobile app).
- **Backend auth enforcement:** Firebase Admin token verification middleware.
- **Not mock/local-only auth:** Real token-based authentication is implemented.

### Auth flow details (actual files/functions)

File:
`mobile/src/screens/auth/SignupScreen.tsx`  
Function:
`createUserWithEmailAndPassword(...)` call in signup submit handler  
Purpose:
Create Firebase account from email/password  
Status:
Implemented

File:
`mobile/src/screens/auth/LoginScreen.tsx`  
Function:
`signInWithEmailAndPassword(...)` call in login submit handler  
Purpose:
Authenticate existing user with Firebase  
Status:
Implemented

File:
`mobile/src/screens/auth/ForgotPasswordScreen.tsx`  
Function:
`sendPasswordResetEmail(...)` call in reset handler  
Purpose:
Password reset via email  
Status:
Implemented

File:
`mobile/src/screens/profile/ProfileScreen.tsx`  
Function:
`signOut(...)` call in logout action  
Purpose:
Logout current user  
Status:
Implemented

File:
`mobile/src/services/api.ts`  
Function:
Axios request interceptor (`user.getIdToken()`)  
Purpose:
Attach Firebase ID token to backend requests  
Status:
Implemented

File:
`mobile/src/context/AuthContext.tsx`  
Function:
`syncAndLoadProfile(...)`  
Purpose:
Calls backend `POST /auth/sync-user` and `GET /users/me`, stores app user state  
Status:
Implemented

File:
`backend/src/middleware/authMiddleware.ts`  
Function:
`requireFirebaseUser`  
Purpose:
Verify Bearer token with Firebase Admin, gate protected APIs  
Status:
Implemented

File:
`backend/src/config/firebase.ts`  
Function:
`initFirebase`, `getFirebaseAuth`  
Purpose:
Initialize Firebase Admin on server  
Status:
Implemented

### Completeness assessment

- **Auth implementation level:** Functional for FYP-1 MVP.
- **Token/session model:** Firebase handles session; app fetches token per request and backend verifies.
- **Backend APIs used for auth-related data:** Yes (`/auth/sync-user`, `/users/me`).

---

## 5. Backend and Database Implementation

### 5.1 Backend Stack (actual)

From `backend/package.json`:

- Express + CORS
- TypeScript (ESM)
- Prisma ORM + `@prisma/client`
- Firebase Admin
- Zod validation
- dotenv

### 5.2 Backend Structure

- `backend/src/server.ts` -> bootstraps env, Firebase, app listen.
- `backend/src/app.ts` -> middleware and route mounts.
- `backend/src/modules/auth/authRoutes.ts`
- `backend/src/modules/users/userRoutes.ts`, `userService.ts`
- `backend/src/modules/tasks/taskRoutes.ts`, `taskService.ts`
- `backend/src/modules/parser/parserRoutes.ts`, `taskParserService.ts`
- `backend/src/utils/apiResponse.ts`

### 5.3 Database (Prisma/PostgreSQL)

File: `backend/prisma/schema.prisma`

- `User` model with `firebaseUid`, `email`, profile fields.
- `Task` model with `title`, `description`, `dueDate`, `dueTime`, `priority`, `category`, `status`, `source`, `confidence`, timestamps, and `userId` FK.
- Enums: `Priority`, `TaskStatus`, `TaskSource`.
- Datasource: PostgreSQL.

### 5.4 Task and Parser APIs

- Task CRUD/status endpoints in `backend/src/modules/tasks/taskRoutes.ts`:
  - `POST /api/tasks`
  - `GET /api/tasks`
  - `GET /api/tasks/:id`
  - `PUT /api/tasks/:id`
  - `DELETE /api/tasks/:id`
  - `PATCH /api/tasks/:id/status`
- Parser endpoint:
  - `POST /api/parser/task` in `backend/src/modules/parser/parserRoutes.ts`.
- Parser implementation:
  - rule-based extraction in `backend/src/modules/parser/taskParserService.ts`.

---

## 6. How Manual, Chat, Voice, and Reminders Actually Work

### 6.1 Shared Creation Path (current architecture)

All three creation sources now converge on:

- `mobile/src/services/createTaskWithReminder.ts`
  - `createTaskWithReminder(apiPayload, options)`

This function:
1. Calls `createTask(...)` (`tasksApi.ts` -> backend POST `/tasks`)
2. If enabled, calls `upsertTaskReminder(...)` (`reminders.ts`)
3. Else clears existing reminder.

### 6.2 Manual Task Creation Flow

File: `mobile/src/screens/tasks/AddTaskScreen.tsx`  
Function: `onSubmit`

Flow:
1. Validates title and due fields.
2. Normalizes due date/time via `dueDateAndTimeForSave(...)`.
3. Checks past dates via `validateDueDateNotPast(...)`.
4. Calls `createTaskWithReminder(...)` with `source: "MANUAL"`.
5. Navigates back with toast text from `reminderFeedbackText(...)`.

### 6.3 Chat Task Creation Flow

File: `mobile/src/screens/chat/ChatTaskScreen.tsx`  
Functions: `send`, `save`

Flow:
1. `send` -> `parseTaskText(...)` (`POST /parser/task`).
2. User confirms/adjusts missing fields (priority/time).
3. `save` normalizes due fields.
4. Calls `createTaskWithReminder(...)` with `source: "CHAT"`.
5. Shows reminder outcome on task list toast.

### 6.4 Voice Task Creation Flow

File: `mobile/src/screens/voice/VoiceTaskScreen.tsx`  
Functions: `runParse`, `save`

Flow:
1. Speech capture via `useDeviceSpeechRecognition`.
2. Transcript parsed by same parser endpoint (`parseTaskText`).
3. User confirms/adjusts fields (time/all-day/priority).
4. Save via `createTaskWithReminder(...)` with `source: "VOICE"`.

### 6.5 Reminder Scheduling Flow

File: `mobile/src/services/reminders.ts`

- `configureReminders()` sets notification handler and Android channel.
- `upsertTaskReminder(task, hint)`:
  - merges due fields from task/hint,
  - computes trigger via `computeReminderTriggerAt(...)`,
  - checks permission,
  - schedules with `Notifications.scheduleNotificationAsync(...)`,
  - stores mapping in AsyncStorage (`taskReminderMap:v1`).
- `clearTaskReminder(taskId)` cancels scheduled notification id.
- Feedback text generated by `reminderFeedbackText(...)`.

---

## 7. Implementation Status: Complete vs Partial vs Missing vs Planned

## 7.1 Fully Implemented (for FYP-1 scope)

- Firebase email/password auth screens and flows.
- Authenticated API integration with Firebase token verification.
- User sync/profile loading from backend.
- Task CRUD + status update backend APIs.
- Manual/chat/voice task creation UIs.
- Shared task creation + reminder orchestration.
- Local reminders via Expo Notifications.
- Prisma DB schema and backend persistence.

## 7.2 Partially Implemented / Limited

- Parser is rule-based (regex/heuristics), not LLM-backed NLP.
- Some future modules appear as placeholder previews (`FuturePreviewScreen`).
- Frontend response validation mostly relies on TypeScript casts, not runtime schemas.

## 7.3 Missing in current runtime code

- No web app implementation in this repository.
- No advanced analytics/monitoring/observability module implementation found.
- No comprehensive automated test suite observed in reviewed structure.

## 7.4 Planned / FYP-2 Indicators

- `mobile/src/screens/future/FuturePreviewScreen.tsx` explicitly marks future features.
- Requirement docs include proposed items beyond current implemented MVP.

---

## 8. Improvements Needed Before FYP-1 Submission

1. **Configuration consistency**
   - Verify/standardize backend API port defaults between backend and mobile config examples.
2. **Parser reliability hardening**
   - Expand rule coverage, add deterministic tests for date/time phrase variants.
3. **Testing baseline**
   - Add at least smoke/unit tests for task APIs, parser, and reminder helper utilities.
4. **Error handling polish**
   - Improve user-facing error states for parser failures/network failures in chat/voice.
5. **Documentation completeness**
   - Expand root `README.md` with architecture, setup, env variables, run order, and known limitations.
6. **Delete semantics clarity**
   - Align soft-delete enum strategy vs actual hard-delete behavior, and document chosen approach.

---

## 9. Quick File Responsibility Index (for Viva)

File:
`mobile/src/services/createTaskWithReminder.ts`  
Function:
`createTaskWithReminder`  
Purpose:
Single source of truth for task creation + reminder scheduling behavior  
Status:
Implemented

File:
`mobile/src/services/reminders.ts`  
Function:
`configureReminders`, `upsertTaskReminder`, `clearTaskReminder`, `reminderFeedbackText`  
Purpose:
Notification channel setup + schedule/cancel + user feedback  
Status:
Implemented

File:
`mobile/src/services/tasksApi.ts`  
Function:
`createTask`, `updateTask`, `parseTaskText`, etc.  
Purpose:
Frontend backend API access layer  
Status:
Implemented

File:
`backend/src/modules/tasks/taskRoutes.ts`  
Function:
Task route handlers  
Purpose:
Authenticated task CRUD/status API  
Status:
Implemented

File:
`backend/src/modules/parser/taskParserService.ts`  
Function:
`parseTaskFromText`  
Purpose:
Rule-based extraction of title/date/time/priority/category/confidence  
Status:
Implemented (heuristic-based)

File:
`backend/prisma/schema.prisma`  
Function:
Schema definitions (`User`, `Task`, enums)  
Purpose:
Persistent data model for backend  
Status:
Implemented

