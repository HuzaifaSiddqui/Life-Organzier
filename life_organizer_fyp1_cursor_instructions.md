# Life Organizer FYP-1 MVP – Cursor Development Instructions

## 1. Project Overview

Build the **FYP-1 MVP** for **Life Organizer: AI-Powered Personal Productivity Assistant**.

This semester submission requires around **30% implementation**, so the goal is not to build the full final system. The goal is to build a working MVP that clearly proves the core concept:

> A user can sign up, log in, create tasks manually, create tasks through AI-style chat input, create tasks through voice input, view tasks, update tasks through UI, and delete tasks through UI.

The full final project may include advanced modules like OCR document processing, WhatsApp integration, mood-based recommendations, analytics, offline sync, calendar integration, collaboration, Pomodoro timer, and advanced AI scheduling. These should **not** be implemented in FYP-1 unless the core MVP is already completed.

---

## 2. FYP-1 Scope

### Must Build in FYP-1

Build these modules as working features:

1. Authentication Flow
2. Dashboard / Task List
3. Manual Task Creation
4. Chat-Based Task Creation
5. Basic AI/NLP Task Parser
6. Voice-Based Task Creation
7. Task Update via UI
8. Task Delete via UI
9. Basic Profile / Logout Flow
10. Basic Error Handling and Validation

### Should Be Frontend Prototype Only for FYP-1

These screens can be added as UI-only/dummy screens to show future direction:

1. Analytics Dashboard
2. Mood Tracking
3. Document Upload
4. Routine Management
5. Smart Scheduling
6. WhatsApp Integration Preview
7. Calendar Integration Preview
8. Settings / Preferences

### Do Not Build in FYP-1

Avoid implementing these advanced features in this semester:

1. Full OCR document processing
2. WhatsApp/Twilio integration
3. Chroma vector database
4. Redis cache
5. Ollama/Llama full conversational AI
6. Full offline-first sync
7. Multi-device conflict resolution
8. Google/Apple Calendar two-way sync
9. Location-based reminders
10. Advanced analytics engine
11. Collaboration between users
12. Pomodoro tracking engine

---

## 3. Recommended Tech Stack

Use a simple but professional stack suitable for FYP-1 and scalable for FYP-2.

### Frontend

- **React Native**
- **Expo**
- **TypeScript**
- **React Navigation**
- **React Hook Form**
- **Zod** for validation
- **Axios** or **Fetch API** for API calls
- **Expo Speech / Expo AV / browser speech support** for basic voice input depending on platform feasibility

### Backend

- **Node.js**
- **Express.js**
- **TypeScript**
- **Prisma ORM**
- **PostgreSQL**
- **Firebase Authentication Admin SDK** for verifying authenticated users

### Database

- **PostgreSQL**
- Use either local PostgreSQL during development or hosted PostgreSQL such as Supabase Postgres/Neon/Render Postgres.

### Authentication

- Use **Firebase Authentication** for:
  - Signup
  - Login
  - Logout
  - Password reset if time allows

Backend should verify Firebase ID token before allowing protected API access.

### AI/NLP for FYP-1

Do **not** use a complex LLM in FYP-1.

Use a **basic rule-based parser** first.

Example input:

```text
Submit AI assignment tomorrow at 5 PM high priority
```

Expected parsed result:

```json
{
  "title": "Submit AI assignment",
  "dueDate": "tomorrow",
  "dueTime": "5 PM",
  "priority": "high",
  "category": "academic",
  "confidence": 85
}
```

The parser should extract:

- Task title
- Date
- Time
- Priority
- Category
- Confidence score

If confidence is low or important fields are missing, show a confirmation/edit screen before saving.

---

## 4. Project Architecture

Use a simple layered architecture.

```text
Frontend Mobile App
        |
        v
Express API Backend
        |
        v
Service Layer
        |
        v
PostgreSQL Database
```

### Backend Layers

```text
src/
  config/
  middleware/
  modules/
    auth/
    tasks/
    parser/
    users/
  prisma/
  utils/
  app.ts
  server.ts
```

### Frontend Layers

```text
src/
  assets/
  components/
  navigation/
  screens/
    auth/
    dashboard/
    tasks/
    chat/
    voice/
    future/
  services/
  hooks/
  utils/
  types/
  constants/
```

---

## 5. Frontend Screens to Build

### Auth Screens

1. Welcome Screen
2. Signup Screen
3. Login Screen
4. Forgot Password Screen
5. Logout action from profile/settings

### Main App Screens

1. Dashboard Screen
2. Task List Screen
3. Task Detail Screen
4. Add Task Manually Screen
5. Add Task via Chat Screen
6. Add Task via Voice Screen
7. Edit Task Screen
8. Delete Confirmation Modal
9. Basic Profile Screen

### Future/Demo Screens

These can be non-functional but visually clear:

1. Analytics Preview Screen
2. Mood Tracking Preview Screen
3. Document Upload Preview Screen
4. Routine Management Preview Screen
5. Smart Schedule Preview Screen

Each future screen should display a clear label like:

```text
Coming in FYP-2
```

---

## 6. Core User Flow

### Flow 1: Signup/Login

1. User opens app.
2. User signs up or logs in.
3. Firebase returns auth token.
4. Frontend sends token to backend.
5. Backend verifies token.
6. User reaches dashboard.

### Flow 2: Manual Task Creation

1. User taps Add Task.
2. User enters title, description, due date, time, priority, category.
3. Frontend validates form.
4. Task is saved using backend API.
5. User sees task in task list.

### Flow 3: Chat-Based Task Creation

1. User opens Chat Task screen.
2. User types natural language task.
3. Frontend sends text to parser API.
4. Backend parser extracts task details.
5. Frontend shows extracted task confirmation.
6. User edits if needed.
7. User saves task.
8. Task appears in task list.

### Flow 4: Voice-Based Task Creation

1. User opens Voice Task screen.
2. User taps microphone.
3. User speaks task.
4. Speech is converted into text.
5. Text is passed to same parser used in chat.
6. Extracted task confirmation appears.
7. User saves task.

### Flow 5: Update/Delete Task

1. User opens task detail.
2. User taps Edit.
3. User updates fields through UI.
4. User saves changes.
5. User can delete task.
6. Delete should show confirmation modal.
7. Deleted task should be removed from active task list.

---

## 7. Database Schema

Use Prisma with PostgreSQL.

### User Model

```prisma
model User {
  id          String   @id @default(uuid())
  firebaseUid String  @unique
  email       String  @unique
  displayName String?
  photoUrl    String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tasks       Task[]
}
```

### Task Model

```prisma
model Task {
  id          String   @id @default(uuid())
  userId      String
  title       String
  description String?
  dueDate     DateTime?
  dueTime     String?
  priority    Priority @default(MEDIUM)
  category    String?
  status      TaskStatus @default(PENDING)
  source      TaskSource @default(MANUAL)
  confidence  Int?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### Enums

```prisma
enum Priority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum TaskStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  DELETED
}

enum TaskSource {
  MANUAL
  CHAT
  VOICE
}
```

---

## 8. Backend API Endpoints

### Auth/User

```http
POST /api/auth/sync-user
GET /api/users/me
```

### Tasks

```http
POST /api/tasks
GET /api/tasks
GET /api/tasks/:id
PUT /api/tasks/:id
DELETE /api/tasks/:id
PATCH /api/tasks/:id/status
```

### Parser

```http
POST /api/parser/task
```

Request:

```json
{
  "text": "Submit AI assignment tomorrow at 5 PM high priority"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "title": "Submit AI assignment",
    "dueDateText": "tomorrow",
    "dueTime": "5 PM",
    "priority": "HIGH",
    "category": "Academic",
    "confidence": 85,
    "needsConfirmation": false
  }
}
```

---

## 9. Basic AI/NLP Parser Rules

Create a simple parser service in backend.

### Date Keywords

Detect:

- today
- tomorrow
- next Monday
- next Tuesday
- next Wednesday
- next Thursday
- next Friday
- next Saturday
- next Sunday
- this week
- next week
- dates like `12 May`, `May 12`, `12/05/2026`

### Time Keywords

Detect:

- 5 PM
- 5:30 PM
- 17:00
- morning
- afternoon
- evening
- night

Map vague time words:

```text
morning = 09:00
afternoon = 14:00
evening = 18:00
night = 21:00
```

### Priority Keywords

```text
urgent, very important, critical = URGENT
high, important = HIGH
medium, normal = MEDIUM
low, later = LOW
```

### Category Keywords

```text
assignment, quiz, exam, lecture, university, class = Academic
meeting, client, office, project = Work
gym, workout, doctor, medicine, sleep = Health
bill, payment, bank, budget = Finance
home, family, shopping = Personal
```

### Confidence Score

Use simple scoring:

- Title found: +30
- Date found: +25
- Time found: +15
- Priority found: +15
- Category found: +15

If confidence >= 80:

```text
Auto-fill and allow user to save.
```

If confidence 50-79:

```text
Show confirmation screen and allow manual correction.
```

If confidence < 50:

```text
Ask user to clarify.
```

---

## 10. Validation Rules

### Signup

- Email required
- Valid email format
- Password minimum 8 characters
- Password must contain letters and numbers

### Login

- Email required
- Password required

### Task

- Title required
- Priority required
- Status required
- Due date optional
- Category optional
- Description optional

---

## 11. UI/UX Guidelines

Use a clean student/FYP-friendly UI.

### Design Style

- Simple dashboard
- Soft cards
- Clear typography
- Minimal colors
- Priority color indicators:
  - Urgent: Red
  - High: Orange
  - Medium: Yellow
  - Low: Blue/Gray

### Task Card Should Show

- Task title
- Due date/time
- Priority badge
- Category badge
- Status
- Source: Manual / Chat / Voice

### Chat Task Screen

Should include:

- Text input
- Send button
- Extracted task preview card
- Save task button
- Edit extracted details option

### Voice Task Screen

Should include:

- Microphone button
- Recording indicator
- Transcribed text area
- Extracted task preview
- Save task button

---

## 12. Error Handling

Handle these cases:

1. User not logged in
2. Invalid token
3. Task title missing
4. Parser cannot understand input
5. Network request failed
6. Database error
7. Voice transcription failed
8. Delete confirmation cancelled

Show user-friendly messages.

Example:

```text
I could not understand the task clearly. Please add a task name and due date.
```

---

## 13. Security Rules

1. Never store plain passwords in backend.
2. Use Firebase Authentication for password handling.
3. Backend must verify Firebase ID token for protected routes.
4. Every task must belong to the logged-in user.
5. A user should never access another user's tasks.
6. Validate all request body data.
7. Use environment variables for secrets.

---

## 14. Environment Variables

### Backend `.env`

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
PORT=5000
NODE_ENV=development
FIREBASE_PROJECT_ID=""
FIREBASE_CLIENT_EMAIL=""
FIREBASE_PRIVATE_KEY=""
```

### Frontend `.env`

```env
EXPO_PUBLIC_API_BASE_URL="http://localhost:5000/api"
EXPO_PUBLIC_FIREBASE_API_KEY=""
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=""
EXPO_PUBLIC_FIREBASE_PROJECT_ID=""
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=""
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=""
EXPO_PUBLIC_FIREBASE_APP_ID=""
```

---

## 15. Suggested Development Order

Follow this order.

### Phase 1: Project Setup

1. Create frontend Expo app.
2. Create backend Express TypeScript app.
3. Configure PostgreSQL and Prisma.
4. Configure Firebase Auth.
5. Setup environment variables.

### Phase 2: Auth

1. Signup screen.
2. Login screen.
3. Firebase Auth integration.
4. Backend token verification.
5. Sync user to database.

### Phase 3: Task CRUD

1. Create task API.
2. Get all tasks API.
3. Update task API.
4. Delete task API.
5. Connect frontend task screens.

### Phase 4: Chat Parser

1. Build parser service.
2. Build `/api/parser/task` endpoint.
3. Build Chat Task screen.
4. Show extracted task preview.
5. Save parsed task.

### Phase 5: Voice Input

1. Build Voice Task screen.
2. Convert speech to text.
3. Reuse same parser.
4. Save task with source = VOICE.

### Phase 6: UI Polish

1. Dashboard cards.
2. Empty states.
3. Loading states.
4. Error messages.
5. Future feature preview screens.

### Phase 7: FYP Documentation Support

1. Add screenshots.
2. Add architecture diagram.
3. Add database ERD.
4. Add use case diagram.
5. Add 30% implementation summary.

---

## 16. FYP-1 Deliverables

The implementation should support these FYP-1 deliverables:

1. Working mobile app MVP
2. Authentication flow
3. Task CRUD
4. Chat-based AI task creation
5. Voice-based task creation
6. Basic backend APIs
7. PostgreSQL database
8. Figma/prototype-like future screens
9. Screenshots for report
10. Architecture diagram
11. Database diagram
12. Use case diagram
13. Gantt chart
14. WBS and team roles

---

## 17. Future Scope for FYP-2

Keep these features in code comments or UI preview only:

1. Smart AI scheduling
2. Routine management
3. Mood tracking
4. Mood-based recommendations
5. OCR document upload
6. Analytics dashboard
7. Offline-first SQLite sync
8. WhatsApp integration
9. Calendar integration
10. Location-based reminders
11. Collaborative tasks
12. Pomodoro timer
13. Advanced conversational AI

---

## 18. Coding Standards

Use these standards:

1. TypeScript everywhere.
2. Keep components small and reusable.
3. Use clear naming.
4. Keep API responses consistent.
5. Validate backend input.
6. Add comments only where logic is not obvious.
7. Keep FYP-1 scope focused.
8. Do not over-engineer.
9. Make the app demo-friendly.
10. Prioritize working features over too many incomplete modules.

---

## 19. Backend Response Format

Use consistent API response structure.

### Success

```json
{
  "success": true,
  "message": "Task created successfully",
  "data": {}
}
```

### Error

```json
{
  "success": false,
  "message": "Something went wrong",
  "error": "ERROR_CODE"
}
```

---

## 20. Cursor Task Instruction

When generating code, Cursor should follow this priority:

1. First create the project structure.
2. Then create backend setup with Express, TypeScript, Prisma, and PostgreSQL.
3. Then create Firebase auth verification middleware.
4. Then create task CRUD APIs.
5. Then create parser API.
6. Then create frontend Expo app screens.
7. Then connect frontend with backend.
8. Then add voice input screen.
9. Then polish UI.
10. Then add dummy future screens.

Do not start with advanced features.

Do not build WhatsApp, OCR, vector database, or full AI scheduling in FYP-1.

The main FYP-1 goal is:

> A clean working demo where evaluator can log in, create tasks manually, create tasks using chat, create tasks using voice, view tasks, update tasks, and delete tasks.

---

## 21. Sample Demo Script for Evaluator

Use this flow during presentation:

1. Open app.
2. Sign up as new user.
3. Login.
4. Show dashboard.
5. Add a manual task.
6. Add a task using chat:
   - "Submit software engineering assignment tomorrow at 5 PM high priority"
7. Show extracted task preview.
8. Save task.
9. Add a task using voice.
10. Edit the task priority/status.
11. Delete a task.
12. Show future screens:
   - Analytics
   - Mood
   - Document Upload
   - Smart Schedule
13. Explain these future modules will be completed in FYP-2.

---

## 22. Final Reminder

Keep this MVP simple, working, and presentable.

A smaller working system is better than a large incomplete system.

For FYP-1, focus on:

```text
Auth + Task CRUD + Chat Parser + Voice Input + Clean UI
```

Everything else should be documented as future enhancement.
