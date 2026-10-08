
# Life Organizer: AI Personal Assistant
## Functional Requirements Document (FRD) - COMPLETE

**Project:** Life Organizer - AI-Powered Cross-Platform Personal Productivity Assistant  
**Version:** 1.0  
**Date:** March 2026  
**Team:** Muhammad Huzaifa, Muhammad Zohaib, Yasir Imran  
**Institution:** COMSATS University Islamabad, Lahore Campus

---

## Table of Contents

1. [Document Overview](#document-overview)
2. [User Roles & Personas](#user-roles--personas)
3. [Task Management Features](#task-management-features)
4. [Routine Management Features](#routine-management-features)
5. [Reminder & Notification System](#reminder--notification-system)
6. [Document Processing Features](#document-processing-features)
7. [Mood & Mental Health Features](#mood--mental-health-features)
8. [Pattern Learning & Recommendations](#pattern-learning--recommendations)
9. [WhatsApp Integration](#whatsapp-integration)
10. [Voice Features](#voice-features)
11. [Multi-Device Synchronization](#multi-device-synchronization)
12. [Analytics & Dashboard](#analytics--dashboard)
13. [Categories & Tagging](#categories--tagging)
14. [Location-Based Features](#location-based-features)
15. [Account & Preferences](#account--preferences)
16. [Feature Tier Breakdown](#feature-tier-breakdown)
17. [Edge Cases & Error Handling](#edge-cases--error-handling)
18. [Onboarding & Initial Setup](#onboarding--initial-setup)
19. [Acceptance Criteria Summary](#acceptance-criteria-summary)

---

## 1. Document Overview

### 1.1 Purpose

This document specifies all functional requirements for Life Organizer. It describes:
- What the system does (features and capabilities)
- How users interact with the system
- Business rules and workflows
- Which features are in Free tier vs Pro tier
- Acceptance criteria for each feature

### 1.2 Scope

**In Scope:**
- Task management via conversational chat interface
- Offline-first synchronization with intelligent conflict resolution
- AI-powered intent detection and entity extraction
- Document processing (OCR, deadline/schedule extraction, topic analysis)
- Mood-based task recommendations and mental health support
- Multi-device synchronization with version control
- WhatsApp Business API integration
- Voice input/output (speech-to-text, text-to-speech)
- Conversational AI (Pro tier only)
- Location-based reminders (Pro tier only)
- Comprehensive analytics and productivity tracking
- Pattern learning and adaptive recommendations

**Out of Scope:**
- Payment processing (handled by external payment gateway)
- Advanced team collaboration features
- Third-party calendar integration (Phase 2)
- Video conferencing
- Advanced ML model training

### 1.3 Document Conventions

- **MUST:** Mandatory requirement
- **SHOULD:** Strongly recommended
- **MAY:** Optional
- **Free/Pro:** Feature tier designation

---

## 2. User Roles & Personas

### 2.1 Primary User Roles

**Role 1: Student**
- Manages coursework, assignments, exams, deadlines
- Primary channels: WhatsApp, Mobile app
- Key need: Never miss assignment deadlines
- Uses syllabus uploads to extract deadlines
- Age: 18-25

**Role 2: Working Professional**
- Manages projects, meetings, client deadlines, work-life balance
- Primary channels: Mobile app, Desktop app
- Key need: Productivity without burnout
- Works across multiple devices
- Wants detailed analytics
- Age: 25-50

**Role 3: Busy Parent**
- Manages family schedules, personal tasks, health routines
- Primary channels: Mobile app, WhatsApp
- Key need: Flexible rescheduling, context-aware tasks
- Frequently stressed
- Needs mental health support
- Age: 30-55

**Role 4: Health-Conscious Individual**
- Tracks exercise, meals, medications, sleep, wellness
- Primary channels: Mobile app
- Key need: Automated routine reminders
- Values privacy and offline capability
- Age: Any

---

## 3. Task Management Features

### 3.1 FR-TM-001: Add Task via Text Chat

**Description:** User adds tasks by typing natural language messages.

**Key Requirements:**

1. **Natural Language Processing**
   - Extract task name, due date, time, duration, priority, category
   - Calculate Clarity Index (0-100%)
   - If ≥95%: Auto-create with confirmation
   - If <95%: Show extraction for user review

2. **Entity Extraction**
   - Task name (what)
   - Due date (when - relative or absolute)
   - Due time (specific time)
   - Duration (how long)
   - Priority (importance level)
   - Category (work, personal, health, academic, finance)

3. **Mandatory Clarifications**
   - **For deadline tasks:** Must ask for time if missing
   - **For duration tasks:** Must ask for duration if missing
   - **For routines:** Must ask for frequency if missing

4. **Task Type Classification**
   - Deadline-based (must complete by date)
   - Flexible (schedule in available slots)
   - Duration-based (needs specific time)
   - Fixed (cannot move)
   - Routine (recurring)

5. **Auto-Creation Logic**
   - Clarity ≥95% → Auto-create + confirmation
   - Clarity <95% → Show for review before creating

**Acceptance Criteria:**
```
✓ User types: "Complete math assignment by Friday 3 PM"
  → Clarity Index ≥95%
  → Auto-creates task
  → Shows: "✓ Added: Math assignment due Friday 3 PM"

✓ User types: "Study physics"
  → Clarity Index <30% (missing date, time, duration)
  → Shows extraction + prompts: "When? How long? How urgent?"
  → Waits for clarification before creating

✓ User types: "I need 2 hours to study this weekend"
  → System detects: Duration=2 hours, flexible timing
  → Asks: "What are you studying? When this weekend?"
  → Creates after clarification
```

**Tier:** Free

---

### 3.2 FR-TM-002: Add Task via Voice (Speech-to-Text)

**Description:** User speaks task description, system converts to text via STT.

**Key Requirements:**

1. **Voice Capture**
   - User clicks "Voice" button
   - Recording starts with visual indicator
   - Auto-stop on 2+ seconds of silence or manual stop
   - Max duration: 2 minutes

2. **Transcription**
   - Convert audio to text (Hugging Face Whisper)
   - Support 100+ languages
   - If confidence <80%: Ask to repeat
   - If ≥80%: Show transcribed text for confirmation

3. **Processing**
   - Apply same NLP as text input
   - Follow same creation flow

**Acceptance Criteria:**
```
✓ User speaks: "I need to complete physics assignment by Friday at 3 PM"
  → Audio recorded until silence
  → Transcribed with 85% confidence
  → Shows: "I heard: I need to complete physics assignment..."
  → Processes with Clarity ≥95%
  → Auto-creates task

✓ User speaks unclear message
  → Confidence <80%
  → Shows: "I didn't catch that. Try again?"
  → Allows re-recording
```

**Tier:** Free

---

### 3.3 FR-TM-003: View All Tasks

**Description:** User views all tasks with filtering and sorting.

**Key Requirements:**

1. **Task List Display**
   - Show: Task name, due date, priority, category, status, progress
   - Default sort: By due date (earliest first)
   - Color coding: Priority (red=urgent, orange=high, yellow=medium, blue=low)

2. **Filtering**
   - By status: All, Pending, In Progress, Completed, Overdue
   - By category: Work, Personal, Health, Academic, Finance
   - By date range: Today, This Week, This Month, Overdue, All

3. **Sorting**
   - Due date (ascending/descending)
   - Priority (urgent first)
   - Category
   - Created date

4. **Search**
   - Real-time search by task name/description
   - Highlight matching text

5. **Task Actions**
   - Tap to view details
   - Swipe for quick actions (complete/skip/postpone)
   - Long-press for more options (edit/delete/reschedule)

**Acceptance Criteria:**
```
✓ User opens task list
  → All tasks shown sorted by due date
  → Status, priority, category visible
  → Pending tasks shown first

✓ User filters by "Overdue"
  → Only overdue tasks shown
  → Count: "5 overdue tasks"

✓ User searches "math"
  → Only matching tasks shown
  → Matching word highlighted

✓ User swipes task right
  → Task marked complete
  → Visual feedback (grayed out with checkmark)
```

**Tier:** Free

---

### 3.4 FR-TM-004: Edit Task

**Description:** User can edit any task field after creation.

**Key Requirements:**

1. **Editable Fields**
   - Task name, description, due date/time, priority, category, tags, status

2. **Edit Methods**
   - Via chat: "Change [task] to [new details]"
   - Via UI: Tap task → Edit button
   - Quick edit for common changes

3. **NLP for Chat Editing**
   - Support natural edits: "Move to Monday", "Make urgent", "Change to 2 hours"
   - Extract changes and confirm before applying

4. **Version Tracking**
   - Track all edits for sync
   - Increment version number
   - Update last modified timestamp
   - Record device ID

5. **Undo**
   - User can undo last edit immediately
   - Not available after cloud sync

**Acceptance Criteria:**
```
✓ User types: "Move assignment to Monday"
  → System detects edit
  → Changes due date
  → Shows: "✓ Updated: Assignment due Monday"

✓ User opens task → Taps "Edit" → Changes due time
  → Changes applied immediately
  → Confirmation shown

✓ User types: "Make this urgent"
  → Priority changes to urgent
  → Icon color changes to red
```

**Tier:** Free

---

### 3.5 FR-TM-005: Delete Task

**Description:** User deletes tasks; soft delete allows 1-day recovery.

**Key Requirements:**

1. **Soft Delete**
   - Mark as deleted (not removed from DB)
   - Retain for 1 day
   - Recovery option: "Undo" button for 24 hours

2. **Confirmation**
   - Show: "Delete [task]? (Can undo within 1 day)"
   - User must confirm

3. **Sync Behavior**
   - Deleted tasks synced as "deleted" status
   - Permanent deletion after 1 day

4. **Archive Alternative**
   - User can archive completed tasks (keep but hide)
   - Different from delete (no time limit)

**Acceptance Criteria:**
```
✓ User deletes task
  → Shows confirmation
  → Task removed from active list
  → "Undo" button appears for 24h

✓ User clicks "Undo" within 24h
  → Task restored with all details

✓ 24h+ passes
  → Task permanently deleted
  → Undo no longer available
```

**Tier:** Free

---

### 3.6 FR-TM-006: Task Scheduling Algorithm

**Description:** System intelligently schedules tasks based on multiple factors.

**Key Requirements:**

1. **Scheduling Factors (Weighted)**
   - User's productivity patterns (peak hours)
   - User's availability (free time slots)
   - Task difficulty (hard tasks in peak hours)
   - Task priority (urgent = ASAP)
   - Existing workload (don't overload days)
   - Task type (deadline before deadline, flexible in available slots)
   - Duration (find continuous slot)

2. **Peak Productivity Identification**
   - System identifies user's most productive hours from history
   - Example: 85% of tasks completed 9 AM-12 PM and 3-5 PM
   - Important tasks scheduled in these windows

3. **Flexible vs Fixed Tasks**
   - **Fixed:** Cannot move (e.g., classes, meetings)
   - **Flexible:** Can reschedule based on availability
   - **Duration-based:** Find continuous matching slot
   - **Deadline-based:** Schedule before deadline in productive time

4. **Overload Prevention**
   - Track total hours scheduled per day
   - If exceeds capacity (default 8 hours):
     - Flag as "High workload"
     - Suggest moving flexible tasks
     - Ask user: "Move some tasks?"
   - Prevent adding to overloaded days

5. **Smart Spacing**
   - Don't schedule too many difficult tasks consecutively
   - Break long days with breaks/routines
   - Schedule urgent early, less urgent later

**Acceptance Criteria:**
```
✓ User adds "Study Calculus (3 hours)" flexible task
  → Peak productive hours: 9 AM-12 PM, 3-5 PM
  → System finds first 3-hour slot in peak time
  → Schedules: Tuesday 9 AM-12 PM
  → Shows: "Scheduled Tuesday 9 AM-12 PM (your productive time)"

✓ Monday already has 8 hours of tasks
  → User adds 2-hour task
  → System shows: "Monday is at capacity"
  → Suggests tasks to move
  → Asks for user decision

✓ Assignment due Friday
  → Scheduled before Friday
  → Respects user patterns
  → Scheduled in peak productivity hours
```

**Tier:** Free

---

### 3.7 FR-TM-007: Partial Completion & Task Splitting

**Description:** User can mark tasks partially complete and split into subtasks.

**Key Requirements:**

1. **Partial Completion**
   - Set completion percentage (0%, 25%, 50%, 75%, 100%)
   - Visual progress bar shown
   - At 100%, task status changes to "completed"

2. **Mark Progress via Chat**
   - User: "I'm 50% done with assignment"
   - System updates percentage
   - User: "How much is assignment done?"
   - System: "[X]% complete"

3. **Task Splitting**
   - User: "Split assignment into [subtask1], [subtask2], [subtask3]"
   - System creates parent and child tasks
   - Parent progress = average of children
   - All auto-complete when children done

4. **Subtask Management**
   - Shown under parent task
   - Can collapse/expand
   - Each can have own due date
   - Reschedule parent → reschedule children

**Acceptance Criteria:**
```
✓ User: "I'm 75% done with essay"
  → Progress bar shows: ████████░ 75%
  → Status remains "in_progress"

✓ User: "Split exam study into Chapter 1, 2, 3"
  → Parent: "Study for exam (4 hours)"
  → Child 1: "Chapter 1 (1.3 hours)"
  → Child 2: "Chapter 2 (1.3 hours)"
  → Child 3: "Chapter 3 (1.3 hours)"

✓ User completes all 3 children
  → Parent automatically marked complete
  → Shows: "✓ Exam preparation complete!"
```

**Tier:** Free

---

### 3.8 FR-TM-008: Handle Missed/Overdue Tasks

**Description:** System intelligently handles tasks user didn't complete on time.

**Key Requirements:**

1. **Overdue Detection**
   - Past deadline + not completed → Overdue
   - Task shown in red
   - Displayed in "Overdue" section

2. **Task-Type-Specific Behavior**

   **Classes/Fixed Meetings:**
   - Auto-marked as "skipped"
   - Message: "You missed [Class]"
   - Next occurrence created automatically
   - No reschedule option

   **Assignments/Deadlines:**
   - Show: "✗ Assignment still pending"
   - Options:
     1. "Complete now" (if time available)
     2. "I couldn't finish" (acknowledge & archive)
     3. "Ask extension" (user action)
     4. "Plan to finish remaining" (system suggests schedule)

   **Routines - Time-locked (morning activities):**
   - If missed morning slot (e.g., 6-7 AM but now 2 PM):
     - Shows: "Missed morning meditation"
     - Does NOT reschedule to afternoon
     - Next day's routine automatically created

   **Routines - Flexible (doctor checkup, bill payment):**
   - Show: "Want to reschedule this week?"
   - Offer available slots
   - User can accept or skip

3. **No Auto-Reschedule**
   - System MUST NOT automatically reschedule
   - User has full control
   - System provides suggestions, user decides

**Acceptance Criteria:**
```
✓ Class at 10 AM-11 AM missed, now 11:15 AM
  → Auto-marked as "skipped"
  → Shows: "You missed Calculus Lecture"
  → Next class date auto-created
  → No reschedule option

✓ Assignment due yesterday, not completed
  → Shows options:
    1. "Complete now"
    2. "I couldn't complete"
    3. "Need extension?" (external)
    4. "Plan finishing"
  → User chooses action

✓ Meditation routine 6-7 AM missed, now 4 PM
  → Shows: "Missed morning meditation"
  → Does NOT suggest afternoon reschedule
  → Tomorrow's meditation auto-created

✓ Flexible doctor checkup missed
  → Shows: "Want to reschedule this week?"
  → Lists available slots
  → User decides
```

**Tier:** Free

---

## 4. Routine Management Features

### 4.1 FR-RM-001: Create Routine

**Description:** User creates recurring activities (daily, weekly, monthly, custom).

**Key Requirements:**

1. **Frequency Types**
   - Daily, Weekly, Monthly, Custom

2. **Routine Properties**
   - Name, description, frequency, time, duration, category, priority, wellness type

3. **Mandatory Clarifications**
   - If frequency unclear: Ask "How often?"
   - If time unclear: Ask "Specific time or flexible?"
   - If priority unclear: Ask "Mandatory or optional?"

4. **Creation Methods**
   - Via chat, UI forms, document extraction

5. **Smart Time Assignment**
   - System learns user's preferred times from behavior
   - User can override with specific time

**Acceptance Criteria:**
```
✓ User: "Daily meditation at 6 AM for 10 minutes"
  → All info provided
  → Auto-creates routine
  → Shows: "✓ Created: Daily meditation (6 AM, 10 min)"

✓ User: "Morning workout"
  → Time missing
  → System asks: "What time? Or flexible?"
  → Waits for response

✓ User: "Mandatory daily prayer at 5 AM"
  → Creates with priority="mandatory"
  → Prevents skipping/rescheduling
  → Shows: "⭐ Mandatory routine"
```

**Tier:** Free

---

### 4.2 FR-RM-002: Routine Categorization & Priority

**Description:** Routines have categories and priority affecting system behavior.

**Key Requirements:**

1. **Categories**
   - Health, Work, Personal, Learning, Admin

2. **Priority Levels**
   - **Mandatory:** Cannot skip, schedule first, blocks other tasks
   - **Important:** Should not skip, preferred times respected
   - **Normal:** Can skip if overloaded

3. **Conflict Resolution**
   - Mandatory routine vs conflicting task:
     - System shows: "Routine conflicts with task"
     - User chooses between them

4. **System Handling**
   - Mandatory: Schedule first
   - Important: Schedule in preferred times
   - Normal: Schedule if possible

**Acceptance Criteria:**
```
✓ Mandatory "Prayer 5 AM" + Study task 4:45-6:45 AM
  → System shows conflict
  → Prompts: "Prayer blocks study. Choose?"
  → User decides

✓ Try to skip mandatory "Medication 8 AM"
  → Shows: "⭐ Mandatory. Are you sure?"
  → Requires confirmation
  → Logs skip

✓ Skip optional "Reading" routine
  → System accepts immediately
```

**Tier:** Free

---

### 4.3 FR-RM-003: Smart Routine Rescheduling

**Description:** System handles missed routines based on their nature.

**Key Requirements:**

1. **Time-Locked Routines**
   - Cannot reschedule to different time
   - If missed: Accept as missed, next day auto-created
   - Examples: Morning jog, prayers, breakfast

2. **Time-Flexible Routines**
   - Can reschedule if missed
   - System asks: "Reschedule this week?"
   - Shows available slots
   - Examples: Doctor checkup, bill payment

3. **Routine Continuation**
   - Next occurrence created even if previous missed
   - Each occurrence independent

4. **User Decision-First**
   - Show 2-3 clear options
   - User clicks to decide
   - Minimal text response required

**Acceptance Criteria:**
```
✓ Missed time-locked "Morning walk 6-7 AM", now 2 PM
  → Marks as skipped
  → Does NOT offer reschedule
  → Tomorrow's walk auto-created
  → Shows: "Missed today's walk. Tomorrow's ready 6 AM."

✓ Missed flexible "Dentist (monthly)", missed last week
  → Shows: "Reschedule this month?"
  → Lists available slots
  → "Skip for now" option

✓ Overloaded day with "Morning meditation" 6 AM
  → Routine still scheduled (doesn't overlap with task hours)
  → Shows: "Very busy day, but morning routine kept"
```

**Tier:** Free

---

### 4.4 FR-RM-004: Location-Based Routines

**Description:** Routines change based on user's location context.

**Key Requirements:**

1. **Location Contexts**
   - User defines: "At Home", "At University", "At Work", "In Village", "Traveling"
   - Each context has different routine sets

2. **Context-Specific Routines**
   - Same routine name can exist in different contexts
   - Different times per context
   - System switches when context changes

3. **Detection**
   - Manual selection (MVP): User selects context
   - Future: Auto-detect from geolocation

4. **Routine Filtering**
   - Show only routines for current context

**Acceptance Criteria:**
```
✓ User defines contexts: "At Home", "At University"
  → "At Home": Morning meditation 6 AM
  → "At University": Breakfast at hostel 8 AM

✓ User is "At Home"
  → Shows: Morning meditation 6 AM
  → Hides: Breakfast at hostel

✓ User switches to "At University"
  → Shows: Breakfast at hostel 8 AM
  → Hides: Morning meditation
```

**Tier:** Free

---

## 5. Reminder & Notification System

### 5.1 FR-RN-001: Smart Escalating Reminders

**Description:** System sends intelligent reminders at optimal times, escalating as deadline approaches.

**Key Requirements:**

1. **Multi-Reminder Sequences**
   - NOT just at deadline
   - Multiple strategic reminders
   - Escalate from gentle to urgent

2. **Critical Reminder Logic**
   - For task requiring 2 hours: Final reminder 2+ hours before deadline
   - MUST schedule in user's productive hours
   - Example: Assignment due Friday 11:59 PM → Final reminder Friday 9 AM

3. **Timing Strategy**
   - Considers: Difficulty, duration, completion patterns, productivity hours, current workload

4. **Example Sequence** (Assignment due Friday 11:59 PM):
   - Monday 2 PM: "3 days until"
   - Wednesday 9 AM: "2 days left, good time to start"
   - Thursday 10 AM: "Due tomorrow, final day"
   - Friday 9 AM: "Final critical: 9 hours left"
   - Friday 10 PM: "1 hour left!"

5. **Adaptive Based on Response**
   - If user ignored previous reminder: Next reminder more prominent
   - If user completes after first reminder: Reduce future reminders

6. **Respect Quiet Hours**
   - User sets quiet hours (e.g., 10 PM-8 AM)
   - Critical reminders scheduled around quiet hours
   - Moved to first thing in morning if conflicts

**Acceptance Criteria:**
```
✓ Assignment due Friday 11:59 PM (2-hour task)
  → Monday 2 PM: "3 days until assignment"
  → Wednesday 9 AM: "2 days left. Good time to start." (productive time)
  → Thursday 10 AM: "Due tomorrow!"
  → Friday 9 AM: "Final critical: Must start within 2 hours"
  → Friday 10 PM: "1 hour left!"

✓ User ignored Monday reminder
  → Same task type: Next reminders more prominent
  → Maybe earlier in day
  → System asks: "How much notice do you need?"

✓ Quiet hours 10 PM-8 AM, reminder due 2 AM
  → Moved to 8 AM (after quiet hours)
  → Or previous day 9 PM (before quiet hours)
```

**Tier:** Free

---

### 5.2 FR-RN-002: Notification Delivery Methods

**Description:** Reminders delivered via OS notifications, push notifications, and WhatsApp.

**Key Requirements:**

1. **Primary: OS-Level Notifications**
   - Android: AlarmManager + system notifications (works offline, even if app closed)
   - iOS: UserNotifications (local notifications, works offline)
   - Desktop: System notification API
   - Works even if app never opens (OS handles)

2. **Secondary: Push Notifications**
   - When app in foreground/open
   - Less reliable (depends on internet)

3. **Offline-First Approach**
   - Reminders downloaded during sync
   - Scheduled locally using OS alarm
   - Works without internet
   - 99.9% delivery reliability

4. **Notification Content**
   - Title: Task name
   - Body: Deadline, urgency
   - Action buttons: "Mark Done", "Snooze", "View Details"
   - Sound + Vibration: Customizable

5. **WhatsApp Reminders (Pro Tier Only)**
   - Requirement: User messaged in last 24 hours
   - System tracks: "last_message_time"
   - If reminder due and last_message_time <24 hours: Send WhatsApp
   - If >24 hours: Use app notification instead (avoids spam detection)
   - Prevents Twilio account suspension from bulk messaging

**Acceptance Criteria:**
```
✓ User syncs Tuesday morning, downloads week's reminders
  → Device offline rest of week
  → Reminder Thursday 10 AM scheduled
  → OS triggers notification at Thursday 10 AM
  → Works without internet
  → User can interact offline

✓ Pro user messaged bot Monday 2 PM
  → Reminder due Wednesday 10 AM
  → last_message_time = Monday 2 PM (<24h)
  → Sends WhatsApp reminder
  → Message: "Remember: Assignment due Friday 3 PM"

✓ User last messaged 3 days ago
  → Reminder due tomorrow
  → Does NOT send WhatsApp (violates 24h policy)
  → Sends app notification instead
```

**Tier:** Free (App notifications), Pro (WhatsApp reminders)

---

### 5.3 FR-RN-003: User Reminder Preferences

**Description:** User customizes reminder behavior globally or per-task.

**Key Requirements:**

1. **Global Preferences**
   - Quiet hours (e.g., 10 PM-8 AM)
   - Notification frequency: "Adaptive" (default), "Frequent", "Minimal", "None"
   - Method: "App notification", "Sound+Vibration", "Sound only", "Silent"
   - Device: "All devices", "Phone only", "Desktop only"

2. **Per-Task Preferences**
   - Override global settings for specific task
   - Frequency: "Single", "Multiple", "Escalating"
   - Timing: "1 hour before", "1 day before", "Custom"
   - Method: "Notification", "Sound alarm", "Vibration", "Silent"
   - When: "Only when offline", "Always", "During work hours"

3. **Do Not Disturb (DND)**
   - User can pause all reminders (2h, 4h, until tomorrow)
   - Critical reminders can override DND (user option)
   - Queued reminders shown when DND ends

**Acceptance Criteria:**
```
✓ User sets quiet hours 10 PM-8 AM
  → No reminders during this time
  → Pending reminders shown at 8 AM
  → Critical reminders moved to 8 AM if scheduled 10 PM-8 AM

✓ Global "Minimal" reminders
  → "Final Exam" task: Change to "Escalating"
  → Final Exam gets multiple reminders
  → Other tasks use "Minimal"

✓ User activates DND 2 hours
  → All reminders paused
  → At 2-hour mark, all pending reminders shown
  → User can dismiss or act
```

**Tier:** Free

---

### 5.4 FR-RN-004: Start & Completion Check-ins

**Description:** After a task's planned start time, the system asks whether the user has started, using a short motivating message that includes a concrete first step. After the expected duration, it asks whether the task is done. Responses feed progress tracking, pattern learning and time-estimate correction.

**Key Requirements:**

1. **Eligibility**
   - Tasks of type FLEXIBLE or DURATION with a `scheduledStart` (start check-in) and `durationMinutes` (completion check-in)
   - DEADLINE tasks qualify when they have both `durationMinutes` and `scheduledStart` (the scheduled start is the work block; the deadline is separate)
   - Not for FIXED events, DEADLINE tasks without a duration or scheduled start, routines, completed, deleted or archived tasks
   - Disabled when the user turns check-ins off or notification frequency is "None"
   - A deadline that has already passed uses the overdue flow (FR-TM-008), never a check-in

2. **Start Check-in**
   - Fires at `scheduledStart` + 5 min if the task is not started or completed
   - Buttons: "Started" / "Not today"
     - Started → status IN_PROGRESS, `startedAt` recorded, completion check-in scheduled
     - Not today → opens the app with reschedule suggestions (user decides, no auto-reschedule)
   - No response → one follow-up 25 min after the first, then stop

3. **Completion Check-in**
   - Fires at (`startedAt`, or `scheduledStart` if never confirmed) + duration + max(10 min, 10% of duration)
   - Softer wording when the start was never confirmed ("How did it go?")
   - Buttons: "Done" / "+30 min" / "Update…"
     - Done → COMPLETED, `completedAt` recorded
     - +30 min → one more completion check-in after 30 minutes
     - Update… → in-app sheet: Partly done (25/50/75%, updates progress per FR-TM-007, offers to schedule the rest), Need more time (+15/+60), Didn't get to it (reschedule suggestions)
   - If extra time would pass the deadline, say so: "That would take you past Friday 3 PM. Plan the rest?"
   - No response → stop; do not assume done or not done

4. **Limits & Timing Rules**
   - Max 3 check-ins per task, max 5 check-ins per user per day. When the daily cap is exceeded, start follow-ups are dropped first, then the soonest check-ins are kept
   - User-requested extra time (+15 / +30 / +60) is exempt from both caps, limited to 2 per task; a refused request shows the user a short message
   - If the task is rescheduled to a later start after work began, the completion check-in is calculated from the new `scheduledStart`
   - Check-in history counts per scheduled slot: after "Not today" or a partial completion, a task rescheduled to a new start gets a fresh set of check-ins for that slot
   - Short tasks: if the completion check-in would fire within 10 min of the start follow-up (or before it), the follow-up is dropped
   - Planned check-ins that would fire after the task's deadline are dropped (the overdue flow takes over); user-requested extra time still warns and is allowed
   - Check-in logs are kept for evaluation when a task is deleted (the task link is cleared); they are removed with the user's account
   - A check-in that falls in quiet hours or DND is skipped, not moved
   - Check-in messages are pre-generated; nothing is generated at notification time

5. **Message Content & Tone**
   - Generated by the backend LLM in the background when a task's scheduled start is set or changed; deterministic templates as fallback
   - Includes the smallest concrete first step for that task where possible
   - Check-in style setting: Funny (default) / Serious / Gentle. The style only changes when the user changes it, in Settings or by asking in chat
   - Exception, per message only: if the user's latest mood in the last 24 h is stressed, anxious, overwhelmed or sad, that check-in uses Gentle wording, no jokes, and offers to split the task. The saved setting does not change
   - Humour is about the task, never the user. No guilt, shaming or comparisons
   - Body ≤ 120 characters, in the user's language (English or Urdu)
   - On completion: brief positive reinforcement. On "Didn't get to it": neutral, no guilt

6. **Changing the Style**
   - Settings → Notifications: "Check-in style" (Funny / Serious / Gentle) and a check-ins on/off switch
   - Chat: the assistant recognises requests like "be more serious with reminders", "change your tone to gentle", "stop joking", "serious ho jao", "mazaq band karo", updates the setting, and confirms with chips for the other styles. "Turn off check-ins" disables them
   - One-time hint the first time the user sees a check-in in the app: "Prefer a different style? Change it in Settings or just tell me."

7. **Learning & Evaluation**
   - Every check-in is logged: kind, tone, whether it had a first step, message source (LLM/template), mood, response, response time
   - Estimate-accuracy ratio (actual ÷ estimated duration) per category, from tasks with `startedAt` and `completedAt`, minimum 5 samples
   - When a ratio is reliable, suggest an adjusted duration on new tasks in that category ("Your Academic tasks usually take ~1.4× your estimate. Block 2h 45m?"); user decides
   - Optional research mode randomly includes or omits the first step (50/50) for comparison

**Acceptance Criteria:**
```
✓ Flexible task "Physics assignment", scheduledStart 4:00 PM, duration 2h
  → 4:05 PM: start check-in with a concrete first step, buttons "Started" / "Not today" only
  → User taps "Started" at 4:07 PM → IN_PROGRESS, startedAt = 4:07 PM
  → ~6:19 PM: completion check-in (4:07 + 2h + 12 min)

✓ No response to start check-in at 4:05 PM
  → 4:30 PM: one follow-up
  → No further start check-ins

✓ scheduledStart 10:30 PM, quiet hours 10 PM–8 AM
  → No start check-in

✓ New user, no style chosen
  → Check-ins use Funny tone

✓ User says "be more serious with reminders" in chat
  → Style = Serious, assistant confirms, next check-ins are serious

✓ Style Funny, user logged "overwhelmed" 3 hours ago
  → That check-in is Gentle and offers to split the task
  → Saved style stays Funny

✓ Completion check-in → "Update…" → Partly done 50%
  → Progress 50%, offer to schedule the remaining ~1h

✓ "+30 min" would pass the deadline
  → Message warns about the deadline and offers to plan the rest

✓ Fixed event "Physics class 10 AM"
  → No check-ins

✓ AI unavailable when the task is scheduled
  → Template message used; check-in still fires on time
```

**Tier:** Free

---

## 6. Document Processing Features

### 6.1 FR-DP-001: Upload & Process Document

**Description:** User uploads syllabi, schedules, or notes. System extracts text and information.

**Key Requirements:**

1. **File Upload**
   - Formats: PDF, JPG, PNG, DOCX
   - Max size: 10 MB per file
   - Multiple files allowed
   - Show upload progress and storage used

2. **Document Type Classification**
   - System asks: "What type? (Syllabus/Schedule/Notes/Other)"
   - Used for extraction strategy

3. **OCR Text Extraction**
   - Extract all visible text using Tesseract.js
   - Support 100+ languages
   - Confidence score for extraction
   - If confidence <70%: Warn "Quality low, results incomplete"

4. **Text Cleaning**
   - Remove noise (watermarks, page numbers)
   - Normalize spacing
   - Preserve section structure

**Acceptance Criteria:**
```
✓ User uploads PDF
  → Shows upload progress
  → Asks: "Syllabus/Schedule/Notes/Other?"
  → User selects
  → Starts OCR

✓ Blurry/low-quality PDF
  → Confidence <70%
  → Shows warning: "Quality is low"
  → "Try uploading clearer image?"
  → Allows proceeding anyway

✓ Urdu document
  → System detects unclear language
  → Asks: "Urdu or another language?"
  → Applies correct OCR model
```

**Tier:** Free

---

### 6.2 FR-DP-002: Extract Deadlines

**Description:** System identifies assignment due dates and exam dates from documents.

**Key Requirements:**

1. **Deadline Detection**
   - Patterns: "Assignment 1 due March 30", "Final Exam April 15 at 10 AM"
   - Relative dates: "due next Friday", "in 2 weeks"
   - Various formats: 3/30/26, 2026-03-30, March 30

2. **Named Entity Recognition**
   - Extract activity (Assignment, Quiz, Exam, Project)
   - Extract date and time
   - Extract additional details
   - Confidence score per deadline

3. **Presentation**
   - Show "Extracted Deadlines:" list
   - Each: "[Activity] due [Date] at [Time]" with confidence %
   - Checkboxes to include/exclude
   - Edit button to correct OCR errors

4. **Auto-Task Creation**
   - Confidence ≥95%: Auto-create task, show confirmation
   - Confidence 80-95%: Ask user before creating
   - Confidence <80%: User manually corrects before creating

5. **Intelligent Clarification**
   - "Due Friday" without year: Assume next Friday, confirm with user
   - Time missing: Assume EOD (11:59 PM), ask to confirm

**Acceptance Criteria:**
```
✓ Syllabus: "Assignment 1 due March 30, 2026 at 3 PM"
  → Confidence: 98%
  → Auto-creates task
  → Shows: "✓ Created task: Assignment 1 due March 30, 3 PM"

✓ Ambiguous: "Final exam next month"
  → Confidence: 45% (too vague)
  → Shows extraction to user
  → User manually enters date/time
  → Then creates

✓ Time missing: "Project submission by Friday"
  → Shows: "Project due Friday 11:59 PM. OK?"
  → User accepts or changes time
  → Creates after confirmation
```

**Tier:** Free

---

### 6.3 FR-DP-003: Extract Schedules

**Description:** System identifies class schedules and recurring activities from documents.

**Key Requirements:**

1. **Schedule Pattern Detection**
   - "Monday, Wednesday, Friday 10-11:30 AM Lecture"
   - "Tue & Thu 2:30-4:00 PM"
   - Table-based timetables
   - "Every Tuesday & Thursday 2 PM"

2. **Extracted Information**
   - Activity name, days, start/end time, duration, frequency, room, instructor

3. **Presentation**
   - Show "Extracted Schedules:" list
   - For each: "[Activity] [Days] [Time] (Confidence: XX%)"
   - Checkboxes and edit buttons

4. **Auto-Routine Creation**
   - Confidence ≥90%: Create routine directly
   - Confidence <90%: Ask for confirmation

5. **Handle Tables**
   - Parse course timetable
   - Create routine per cell
   - Show all before creating

**Acceptance Criteria:**
```
✓ Syllabus: "Linear Algebra: MWF 10-11:30 AM, Room 301"
  → Extracts: Activity, Days, Time, Room
  → Confidence: 94%
  → Auto-creates routine

✓ Table-based timetable with 12 courses
  → Extracts each course-time-day combo
  → Shows all: "Found 12 classes. Create all?"
  → User accepts or selects specific ones

✓ Ambiguous: "Class in morning"
  → Confidence: 20% (too vague)
  → Shows: "I found: Class in morning"
  → User enters: "Monday & Friday 10 AM"
  → Creates after clarification
```

**Tier:** Free

---

### 6.4 FR-DP-004: Extract Topics & Context

**Description:** System extracts learning topics, course info, and resources.

**Key Requirements:**

1. **Information Extraction**
   - Course name/code, instructor, learning objectives, topics, prerequisites, grading, resources

2. **Storage & Use**
   - Store linked to document
   - Use for recommendations
   - Reference for context on related assignments

3. **Intelligent Discussion**
   - If "Prerequisite: Linear Algebra" mentioned:
     - System asks: "Have you completed Linear Algebra?"
     - If "No": Suggest adding to learning plan
     - If "Yes": Continue with current task

4. **Presentation**
   - Show course info section
   - Display prerequisites, objectives, topics, resources

**Acceptance Criteria:**
```
✓ Syllabus for "CS301 Data Structures"
  → Extracts:
    - Course: CS301
    - Instructor: Prof. Ahmed Khan
    - Prerequisite: CS101
    - Topics: Arrays, Lists, Trees, Graphs, Sorting
    - Grading: 30% Assignments, 20% Midterm, 20% Project, 30% Final

✓ Prerequisite mentioned
  → User creates: "Study trees chapter"
  → System: "I see you're learning CS301 topics. Completed CS101?"
  → If "No": "Want to add CS101 learning first?"
  → If "Yes": Proceed with trees

✓ No prerequisite mentioned
  → User creates related task
  → System uses topics for context/recommendations
```

**Tier:** Free

---

## 7. Mood & Mental Health Features

### 7.1 FR-MH-001: Mood Tracking & Logging

**Description:** System tracks user's mood for personalized recommendations.

**Key Requirements:**

1. **Mood Log Entry**
   - Manual via chat: "I'm stressed" / "I'm happy"
   - Manual via UI: Emoji scale (1-10)
   - Mood categories: Stressed, Anxious, Happy, Tired, Motivated, Sad, Overwhelmed, Focused

2. **Automatic Mood Detection**
   - Sentiment analysis on chat text
   - Detect mood keywords: "stressed", "happy", "tired", etc.
   - Return confidence score
   - Prompt user to confirm/correct

3. **Daily Mood Check-in**
   - Optional prompt once per day
   - Triggered 1 hour after wake-up routine/first app action
   - User can skip or answer
   - Identifies mood patterns

4. **Mood Context**
   - Store: Time, pending task count, deadline pressure, recent accomplishments
   - Used for recommendations and pattern analysis

5. **Mood History**
   - Track over time
   - Identify patterns (stressed on Mondays)
   - Available in analytics

**Acceptance Criteria:**
```
✓ User types: "I'm feeling overwhelmed"
  → Detects: overwhelmed, confidence 90%
  → Prompts: "I sense you're overwhelmed. Correct?"
  → User confirms or corrects
  → Logs with timestamp

✓ User types: "This assignment is making me anxious"
  → Extracts: anxious, confidence 85%
  → Shows: "Sounds like you're anxious. Need help?"
  → Offers support options

✓ User opens app first time at 9 AM
  → 1 hour after wake-up routine
  → Prompts: "How are you feeling today?" (emoji scale)
  → User selects or skips
  → Stored for pattern analysis
```

**Tier:** Free

---

### 7.2 FR-MH-002: Mood-Based Task Recommendations

**Description:** System adapts task suggestions based on current mood.

**Key Requirements:**

1. **Mood-Task Mapping**

   **Stressed/Anxious:**
   - Recommend: Light tasks (<15 min), self-care, breathing exercises
   - Avoid: Difficult tasks, large projects
   - Message: "Let's take this slow. How about a 10-minute break?"

   **Tired:**
   - Recommend: Simple tasks, routines, easy wins
   - Avoid: Complex problem-solving

   **Happy/Motivated:**
   - Recommend: Challenging tasks, learning, ambitious projects
   - Avoid: Boring/repetitive work
   - Message: "Great energy! Want to tackle something challenging?"

   **Overwhelmed:**
   - Recommend: Break down work, meditation, priority setting
   - Avoid: Adding more tasks
   - Message: "Let's break this down. One thing at a time."

   **Sad:**
   - Recommend: Social tasks, hobbies, mood-lifting routines
   - Avoid: Solitary, demanding tasks
   - Message: "How about connecting with someone?"

2. **Recommendation Flow**
   - User logs mood
   - System: "I sense you're [mood]. Let me help."
   - Suggests mood-appropriate action (with one-click accept)
   - Then: "After that, here's what you could do:"
   - Or: "Talk about it? I'm here to listen." (premium)

3. **Customization**
   - Respect user's language preferences
   - Learn user's preferences: Don't suggest English songs if user prefers Urdu
   - System learns: "User listens to Urdu ghazals when stressed"

**Acceptance Criteria:**
```
✓ User logs: "I'm really stressed about exams"
  → Shows:
    1. "Let's calm down first. Breathing exercise?" (with start button)
    2. "After that, suggestions:"
       - "Short review session (20 min)"
       - "Call a friend"
       - "Take a walk"
  → NOT shown: "Study 4 hours", "Start new project"

✓ User mood: Happy (9/10)
  → Shows: "Great energy! Which challenge you want?"
  → Options: Hardest assignment, new learning, creative project
  → NOT shown: Easy routine, simple work

✓ User logs: "Too much to do"
  → Shows:
    1. "Let's slow down" (reassurance)
    2. "List top 3 urgent things?"
    3. "Ignore the rest for now"
    4. "Let's break down #1"
  → Does NOT add more tasks
```

**Tier:** Free (basic), Pro (advanced with stress relief, music recommendations)

---

### 7.3 FR-MH-003: Adaptive Task Rescheduling During Stress

**Description:** System modifies task scheduling when user is stressed.

**Key Requirements:**

1. **Stress Detection**
   - From mood logs: "stressed", "anxious", "overwhelmed"
   - From behavior: No completion for 2+ days, constant procrastination
   - From deadline pressure: Multiple urgent tasks same day

2. **Adaptive Scheduling**
   - If stressed AND has large task scheduled today:
     - Option 1: Break into smaller chunks
     - Option 2: Move some chunks to next day
     - Option 3: Suggest calming routine before task
   - Ask: "Big task and you're stressed. Break it down?"

3. **Slot Modification**
   - Instead: "Study Calculus 3-6 PM" (3 hours straight)
   - Suggest: 3-3:45 PM (study), 3:45-4:00 PM (break), 4:00-4:45 PM (study), etc.
   - Break every 45 minutes

4. **Support Resources**
   - Pro: AI discussion for stress
   - Free: Break suggestions, breathing exercises, music recommendations
   - All: Mood-based music per user preferences

5. **No Force-Complete**
   - System NEVER forces when stressed
   - Respects mental state
   - Offers: "Postpone?" as primary option

**Acceptance Criteria:**
```
✓ User mood: "stressed"
  → Scheduled: "Study Calculus 3-6 PM" (3h)
  → System shows:
    - "You're stressed with big task. Options:"
    - [Break into 45-min chunks with breaks]
    - [Move to tomorrow]
    - [Do as scheduled]
  → Respects choice

✓ User very stressed (2/10 mood)
  → Opens app
  → Shows: "Going through a lot. Postpone non-urgent?"
  → Lists flexible tasks
  → User can postpone all or select
  → NOT forced

✓ Task: "Project (6 hours)"
  → User accepts breaking down
  → Creates subtasks:
    - Part 1: Research (2h)
    - Part 2: Design (2h)
    - Part 3: Implementation (2h)
  → Scheduled across multiple days
```

**Tier:** Free

---

### 7.4 FR-MH-004: Mental Health Support & Conversational AI (Pro)

**Description:** Pro users can discuss feelings and get emotional support from AI.

**Key Requirements:**

1. **Conversational Support**
   - User can discuss stress, anxiety, overwhelm
   - AI responds empathetically (not clinically)
   - Suggests practical coping strategies
   - Example:
     - User: "I'm so stressed about workload"
     - AI: "I understand. What's making you most anxious? Top 3 things?"

2. **Insights for Recommendations**
   - From conversation, system learns what helps user
   - What tasks reduce stress
   - What routines are helpful
   - What time/context user recovers in

3. **Emotion-Aware Task Suggestions**
   - Uses conversation context + mood patterns
   - Example: If user mentions "music helps", suggest music break
   - If "exercise helps", suggest quick workout

4. **No Clinical Claims**
   - Not a therapist or medical advice
   - Frame as "supportive assistant" not "mental health professional"
   - When needed, suggest professional help

**Acceptance Criteria:**
```
✓ User (Pro) stressed
  → Types: "I'm overwhelmed by my classes and work"
  → System: "That sounds really tough. Tell me more."
  → Conversation unfolds
  → System learns coping strategies from chat
  → Future recommendations reflect this

✓ From conversation, system learns: "User relaxes with music"
  → When stressed again
  → System suggests: "Music helped before?"
  → Offers to play calming music
  → User accepts

✓ System detects serious depression indicators
  → Does NOT claim to treat
  → Shows: "It sounds like you're struggling. Have you considered talking to a professional?"
  → Offers resources
```

**Tier:** Pro

---

## 8. Pattern Learning & Recommendations

### 8.1 FR-PL-001: Identify User Patterns

**Description:** System identifies user's behavioral patterns for personalization.

**Key Requirements:**

1. **Patterns to Identify**
   - **Task Completion:** Completion rate by category, time of day, difficulty
   - **Routine Adherence:** Which routines consistently completed, which skipped
   - **Mood Cycles:** Mood patterns by day/time (always stressed Mondays)
   - **Work Hours:** Peak productivity hours (9-12, 3-5 PM)
   - **Procrastination:** Tendency to complete tasks day before vs. early
   - **Category Performance:** Success rates by task type

2. **Data Collection**
   - Track every task: Created, due date, completion time, status
   - Track routines: Scheduled, completed, skipped
   - Track mood: Daily logs, detected from messages
   - Track interactions: When user uses app, response times

3. **Pattern Calculation**
   - Confidence score (0-1): Based on data point count
   - Example: User need 50+ tasks per category to calculate pattern
   - Once confidence high, system starts using pattern

4. **Update Frequency**
   - Real-time: Pattern updated as new data arrives
   - Weekly: System reviews and identifies new patterns
   - Monthly: Deep analysis for trends

**Acceptance Criteria:**
```
✓ User has completed 80 tasks
  → System analyzes completion times
  → Identifies: "User completes 85% of tasks 9-12 AM and 3-5 PM"
  → Confidence: 82% (good sample size)
  → System uses for scheduling

✓ User completes meditation every day for 30 days
  → Routine adherence: 100%
  → System marks as "reliable routine"
  → Future scheduling prioritizes this

✓ User always stressed on Mondays (mood logs show)
  → Pattern: "User stressed on Mondays"
  → Confidence builds after 4+ weeks of Monday logs
  → System suggests lighter Monday tasks
```

**Tier:** Free

---

### 8.2 FR-PL-002: Make Pattern-Based Recommendations

**Description:** System recommends tasks and routines based on identified patterns.

**Key Requirements:**

1. **Optimal Task Timing**
   - Identify user's peak productivity hours
   - Schedule difficult/important tasks in these windows
   - Avoid scheduling in low-productivity hours

2. **Routine Recommendations**
   - Suggest new routines based on user's patterns
   - Example: If user always completes tasks 9-12 AM, suggest "Study time 9-12 AM"
   - If user stressed, suggest stress-relief routine

3. **Task Type Recommendations**
   - Based on user's success rates by category
   - Example: If user always completes work tasks but skips personal, prioritize work

4. **Confidence Display**
   - Show confidence to user
   - "I'm 70% sure you should keep checking health...I'm 90% sure you're destroying sleep cycle"
   - User can adjust recommendations

5. **Confidence Threshold**
   - Minimum 50% confidence to show recommendation
   - Higher confidence = stronger recommendation
   - Below 50%: Don't recommend, just observe

**Acceptance Criteria:**
```
✓ User's patterns identified
  → Peak productivity: 9-12 AM, 3-5 PM (90% confidence)
  → System recommends: "Schedule challenging tasks 9-12 AM?"
  → User can accept/reject

✓ User completes work tasks 95%, personal 40%
  → System: "You're great at work tasks, but skip personal ones"
  → Recommends: "How about we prioritize personal tasks too?"

✓ Confidence only 40% on pattern
  → System doesn't show recommendation
  → Just logs for future use
  → When confidence reaches 50%+, then recommends

✓ Pattern confidence display
  → "I'm 20% sure you need to keep check on health"
  → "I'm 70% sure you're destroying your sleep cycle"
  → User sees confidence levels
```

**Tier:** Free

---

## 9. WhatsApp Integration

### 9.1 FR-WA-001: Receive & Process WhatsApp Messages

**Description:** User sends messages to Life Organizer WhatsApp number; system processes and responds.

**Key Requirements:**

1. **Message Reception**
   - User initiates conversation (sends message first)
   - System receives via Twilio webhook
   - Message can be: Text, voice (transcribed), image (OCR)
   - No cost for first 24 hours after user message

2. **Message Processing**
   - Parse text for intent and entities
   - If unclear syntax, AI analyzes to categorize intent
   - If still unclear, ask clarifying questions back to user

3. **Multi-Turn Conversation**
   - User can send multiple messages in one conversation
   - System remembers context within conversation
   - Allows follow-ups: "Change to Friday", "Make it high priority"
   - Conversation tracked by phone number + time window (24 hours)

4. **Supported Commands**
   - Create task: "Add assignment due Friday"
   - Update task: "Change to Monday", "Make urgent"
   - Query: "What do I have today?"
   - Status updates: "I completed homework"
   - Delete: "Remove homework from list"
   - Any unclear command: System asks clarifying question

5. **Response Format**
   - Clear, concise responses
   - Include action taken (✓ for success, ? for confirmation)
   - Example: "✓ Added: Math homework due Friday 3 PM"

**Acceptance Criteria:**
```
✓ User sends: "Add assignment due Friday"
  → System receives via webhook
  → Processes intent: CREATE_TASK
  → Entities: task="assignment", date="Friday"
  → Clarity OK, asks: "What time?"
  → User: "3 PM"
  → System: "✓ Created: Assignment due Friday 3 PM"

✓ User sends unclear: "I need to do math"
  → Intent detected as: VAGUE
  → AI analyzes, uncertain of actual intent
  → Asks: "Do you want to create a task? Or just telling me?"
  → User clarifies

✓ Multi-turn: User sends "Add project due next week"
  → System: "✓ Created: Project due next week"
  → User: "Make it high priority"
  → System: "✓ Updated: Project now HIGH priority"
  → User: "Change to Thursday"
  → System: "✓ Updated: Project due Thursday"
```

**Tier:** Free (text/image task creation)

---

### 9.2 FR-WA-002: Send Reminders via WhatsApp (Pro Only)

**Description:** Pro users receive reminders via WhatsApp if messaged in last 24 hours.

**Key Requirements:**

1. **24-Hour Rule**
   - System tracks: "last_message_time" for each user
   - Only send WhatsApp messages if last_message_time < 24 hours
   - Enforced by WhatsApp Business API (free tier rule)

2. **Reminder Timing**
   - If reminder due and last_message_time < 24 hours: Send WhatsApp
   - If last_message_time ≥ 24 hours: Use app notification instead
   - Prevents account suspension from spam detection

3. **Message Content**
   - Simple reminder message: "Remember: [Task] due [Date/Time]"
   - One message per reminder (not multiple)
   - Actionable: User can reply to confirm or reschedule

4. **Risk Mitigation**
   - Only for Pro tier (less users = lower spam risk)
   - If bulk messaging detected, pause WhatsApp reminders
   - Log all messages for compliance

**Acceptance Criteria:**
```
✓ Pro user messaged bot Monday 2 PM
  → Reminder due Wednesday 10 AM
  → last_message_time = Monday 2 PM (< 24h)
  → System sends WhatsApp: "Remember: Assignment due Friday 3 PM"
  → User can reply to interact

✓ User last messaged 3 days ago
  → Reminder due today
  → last_message_time > 24h
  → Does NOT send WhatsApp (violates policy)
  → Sends app notification instead
  → No message to user WhatsApp

✓ Bulk reminders detected (many users getting messages)
  → System pauses WhatsApp sending
  → Switches to app notifications only
  → Prevents account suspension
```

**Tier:** Pro

---

## 10. Voice Features

### 10.1 FR-VF-001: Voice Input (Speech-to-Text)

**Description:** User speaks task descriptions; system converts to text (Free tier).

**Key Requirements:**

1. **Voice Capture**
   - User clicks "Voice" button
   - Recording starts (visual indicator)
   - Auto-stops on 2+ seconds silence or manual stop
   - Max: 2 minutes per recording

2. **Transcription**
   - Convert audio to text using Hugging Face Whisper
   - Support 100+ languages
   - Confidence score

3. **Processing**
   - Apply same NLP as text input
   - Create task with confirmed entities

**Acceptance Criteria:**
```
✓ User speaks: "Complete physics assignment by Friday at 3 PM"
  → Recorded until silence
  → Transcribed: 85% confidence
  → Shows: "I heard: Complete physics assignment..."
  → Processes normally
  → Auto-creates task

✓ Unclear audio
  → Confidence <80%
  → Shows: "I didn't catch that. Try again?"
  → Allows re-recording
```

**Tier:** Free

---

### 10.2 FR-VF-002: Voice Output (Text-to-Speech)

**Description:** System reads back task details using TTS (Free tier).

**Key Requirements:**

1. **TTS Output**
   - System reads task details back to user
   - User can control: Speed, voice, language

2. **When Used**
   - After task creation confirmation
   - When user asks to "Read back" details
   - Optional: Enable/disable in preferences

3. **Supported Languages**
   - English, Urdu, Arabic, Spanish, etc.
   - Use user's selected language preference

**Acceptance Criteria:**
```
✓ Task created
  → System: "Task created: Math assignment due Friday 3 PM"
  → Reads text aloud
  → User can adjust speed/voice

✓ User asks: "Read back my tasks"
  → System reads: "You have 3 pending tasks..."
```

**Tier:** Free

---

### 10.3 FR-VF-003: Conversational Voice Chat (Pro Tier)

**Description:** Pro users can have voice conversations with AI (future feature, not MVP).

**Key Requirements:**

1. **Voice Conversation**
   - User speaks continuously
   - System listens, understands, responds with voice
   - Natural back-and-forth dialogue

2. **Capabilities**
   - Answer questions about tasks
   - Discuss feelings and get support
   - Give recommendations naturally

**Tier:** Pro (Phase 2)

---

## 11. Multi-Device Synchronization

### 11.1 FR-MS-001: Offline-First Architecture

**Description:** All devices store data locally; sync to cloud when online.

**Key Requirements:**

1. **Local-First Storage**
   - Mobile: SQLite database
   - Desktop: SQLite database
   - All data synced locally first
   - App works fully offline

2. **Cloud Backup**
   - When online, sync to PostgreSQL
   - Cloud acts as backup + multi-device source
   - Eventually consistent (not real-time)

3. **Sync Process**
   - On app foreground: Attempt sync
   - Manual sync button: Force sync
   - Periodic sync: Every 6-12 hours (WiFi preferred)
   - User preferences: When to sync

**Acceptance Criteria:**
```
✓ User creates task on phone offline
  → Stored immediately in SQLite
  → Marked "pending sync"
  → App works normally

✓ User goes online
  → App detects network
  → Initiates sync
  → Changes uploaded to cloud
  → Marked "synced"

✓ User opens desktop app offline
  → Syncs cached data from previous session
  → Works fully offline
  → Updates when online again
```

**Tier:** Free

---

### 11.2 FR-MS-002: Conflict Resolution

**Description:** Handle cases where same task edited on multiple devices.

**Key Requirements:**

1. **Conflict Scenarios**
   - Device A: Changes task offline, saves as version 2
   - Device B: Changes same task online, saved as version 2
   - Device A: Comes online, tries to sync version 2
   - Cloud: Already has version 2, but different content!

2. **Auto-Resolution**
   - Single user base on last-modified timestamp: Device with newer timestamp wins
   - Overwrites older version
   - Simple, fast, no user prompt

3. **Field-Level Merge** (for complex conflicts)
   - If different fields changed on each device, merge both
   - Example:
     - Local: Changed title only
     - Cloud: Changed due date only
     - Result: Both changes merged

4. **Sync Status Tracking**
   - Task version number: Incremented on each sync
   - Last modified timestamp: When device last changed
   - Sync status: "synced", "pending", "conflict"
   - Device ID: Which device made last change

**Acceptance Criteria:**
```
✓ Same task edited on 2 devices
  → Device A: Changes title (local time: 3 PM)
  → Device B: Changes due date (cloud time: 3:30 PM)
  → Device A syncs
  → Cloud comparison: 3:30 PM > 3 PM
  → Cloud version wins
  → Device A pulls updated version

✓ Field-level merge
  → Device A: title="Study Math" (changed)
  → Device B: due="Friday" (changed)
  → Cloud: title="Study Physics" (old), due="Thursday" (old)
  → Merged: title="Study Math" (from A), due="Friday" (from B)
  → Result: Both changes applied

✓ True conflict (same field, different values)
  → Device A: title="Assignment"
  → Device B: title="Homework"
  → Same field, different values
  → Last-write-wins: Later timestamp wins
```

**Tier:** Free

---

### 11.3 FR-MS-003: Instant Sync When Possible

**Description:** Tasks synced to cloud as soon as possible, ideally immediately.

**Key Requirements:**

1. **Real-Time Sync**
   - If online: Changes uploaded within seconds
   - If offline: Queued locally, synced when online

2. **Sync Queue**
   - Store pending operations: Create, update, delete
   - Each operation: Entity ID, type, full payload
   - Status: pending, syncing, synced, conflict
   - Retry on failure with exponential backoff

3. **Other Devices Notification**
   - After sync to cloud, other devices notified
   - Pull changes from cloud periodically
   - Not real-time push (eventual consistency)

**Acceptance Criteria:**
```
✓ User creates task online
  → Immediately synced to cloud
  → Desktop user (same account) sees it within minutes
  → Both devices show identical data

✓ User offline, creates task
  → Stored locally, marked "pending"
  → Goes online
  → Task syncs to cloud within 2-3 seconds
  → Desktop sees task appear

✓ User deletes task on phone, offline
  → Marked as "deleted" locally
  → Goes online
  → Delete synced to cloud
  → Desktop's version deleted too
```

**Tier:** Free

---

### 11.4 FR-MS-004: Version Control & History

**Description:** Track all changes to tasks for sync and debugging.

**Key Requirements:**

1. **Version Tracking**
   - Each task has version_number (starts at 1)
   - Incremented on each change
   - Last modified timestamp
   - Device ID that made change

2. **Internal History** (for system use, not shown to user)
   - Store task snapshots per version
   - Used for conflict resolution
   - Kept for 90 days, then deleted

3. **No User-Visible History**
   - User doesn't see version history
   - Just shows current state + ability to undo recent edits

**Acceptance Criteria:**
```
✓ Task created
  → version_number = 1
  → last_modified = creation time
  → device_id = phone

✓ Task edited on desktop
  → version_number = 2
  → last_modified = desktop edit time
  → device_id = desktop

✓ Another edit on phone
  → version_number = 3
  → last_modified = phone edit time
  → device_id = phone

✓ User doesn't see this
  → Just sees current state
  → Can undo one recent edit only
```

**Tier:** Free

---

## 12. Analytics & Dashboard

### 12.1 FR-AN-001: Track & Calculate Metrics

**Description:** System tracks productivity metrics for analytics dashboard.

**Key Requirements:**

1. **Tracked Metrics**
   - **Completion Rate:** % of tasks completed (daily, weekly, monthly)
   - **On-Time Completion:** % completed before deadline
   - **Category Performance:** Completion rate per category
   - **Task Distribution:** How many tasks per category
   - **Routine Adherence:** % of routine completions per routine
   - **Timing Patterns:** Most common task completion times
   - **Avg Completion Time:** Average time from due date to completion

2. **Data Collection**
   - Log every task: Created, due date, completion date/time, status
   - Log every routine: Scheduled, completed/skipped
   - Log every interaction: When opened, actions taken

3. **Calculation**
   - Real-time: Update as new data arrives
   - Daily rollup: Calculate daily metrics
   - Weekly/Monthly: Aggregate daily metrics

**Acceptance Criteria:**
```
✓ User completes 12 out of 15 tasks this week
  → Completion rate: 80%

✓ 10 completed on time, 2 after deadline
  → On-time rate: 83%

✓ Gym routine completed 6 out of 7 days
  → Routine adherence: 86%

✓ Task distribution: 40% work, 35% personal, 25% health
  → Shown in pie chart
```

**Tier:** Free (basic), Pro (advanced analytics)

---

### 12.2 FR-AN-002: Display Analytics Dashboard

**Description:** User views productivity analytics with multiple visualizations.

**Key Requirements:**

1. **Analytics Views**
   - Completion rate chart (daily, weekly, monthly, yearly)
   - Category breakdown (pie chart showing % per category)
   - Routine adherence tracking (progress bar per routine)
   - Task distribution over time (line chart)
   - Productivity heatmap (best hours/days)

2. **Time Range Filtering**
   - User can apply filters: "This week", "This month", "Last 3 months", "All time"
   - Dynamic charts update based on filter
   - Compare periods: "This week vs last week"

3. **Detailed Metrics Displayed**
   - Total tasks created this period
   - Total tasks completed
   - Completion percentage
   - Average days to completion (how long after due date)
   - Most productive day/time
   - Most challenging category
   - Best performing category

4. **Insights & Notifications**
   - System generates insights: "You're most productive on Mondays"
   - Highlight trends: "Completion rate improving 5% per week"
   - Warnings: "Health tasks completion down to 40%"

5. **Export Capability**
   - Export analytics to PDF (Pro tier)
   - Export data to CSV (Pro tier)
   - Include charts and metrics in export

**Acceptance Criteria:**
```
✓ User opens "Analytics" tab
  → Displays completion rate chart (default: this month)
  → Shows: Total tasks, completed, completion %
  → Shows pie chart of categories
  → Shows routine adherence list

✓ User selects "This week" filter
  → Charts update to show only this week's data
  → Completion rate recalculated
  → Comparison shown vs previous week

✓ System generates insight
  → Shows: "You're most productive 9 AM-12 PM"
  → Based on historical completion data
  → User can dismiss or acknowledge

✓ User (Pro) exports to PDF
  → Downloads file with all charts and metrics
  → Formatted nicely with colors
  → Includes date range and filters applied
```

**Tier:** Free (basic analytics), Pro (advanced analytics + export)

---

## 13. Categories & Tagging

### 13.1 FR-CT-001: Predefined & Custom Categories

**Description:** User can organize tasks using predefined or custom categories.

**Key Requirements:**

1. **Predefined Categories**
   - Work (projects, meetings, deadlines)
   - Personal (hobbies, personal goals)
   - Health (exercise, wellness, medical)
   - Academic (study, assignments, exams)
   - Finance (bills, expenses, budgeting)

2. **Custom Categories**
   - User can create custom categories (e.g., "Traveling", "Home Renovation")
   - Name and color selection
   - Can be edited or deleted anytime

3. **Category Assignment**
   - Assign during task creation
   - Can change anytime
   - System suggests category based on task description (via NLP)

4. **Category Filtering**
   - Filter task list by category
   - Multiple category selection (show all selected)
   - View analytics per category

**Acceptance Criteria:**
```
✓ Predefined categories shown during task creation
  → User selects "Work" for "Meeting with boss"
  → Task tagged with Work category
  → Shown with work color in list

✓ User creates custom category
  → Name: "Traveling"
  → Color: Blue
  → Can assign to tasks
  → Appears in category list

✓ System suggests category
  → User: "Exercise for 30 minutes"
  → System suggests: "Health" category
  → User can accept or change

✓ Filter by multiple categories
  → User selects: Work + Health
  → Shows only tasks in these categories
  → Task count updates
```

**Tier:** Free

---

### 13.2 FR-CT-002: Task Tagging

**Description:** User can add multiple tags to tasks for additional organization.

**Key Requirements:**

1. **Tag System**
   - Each task can have multiple tags
   - Tags are keywords/labels (e.g., "urgent", "important", "review")
   - User creates tags ad-hoc (not predefined)
   - Autocomplete suggests previously used tags

2. **Tag Management**
   - Add tags during creation or editing
   - Remove tags anytime
   - View all tags in settings
   - Delete unused tags

3. **Tag-Based Filtering**
   - Filter tasks by tag
   - Multiple tag selection (AND/OR logic)
   - Show task count per tag

4. **Tag Suggestions**
   - System suggests tags based on task content
   - Example: "Assignment" → suggest "homework", "deadline"

**Acceptance Criteria:**
```
✓ User adds task with tags
  → Tags: "urgent", "deadline", "important"
  → Shown as chips below task name
  → Can remove individual tags

✓ User searches by tag
  → Clicks "urgent" tag
  → Shows all urgent tasks across categories
  → Task count: "12 urgent tasks"

✓ System suggests tags
  → User: "Study for calculus exam"
  → Suggests: "exam", "study", "deadline"
  → User can accept or ignore

✓ Multiple tag filter
  → Select: "urgent" AND "work"
  → Shows only tasks with both tags
```

**Tier:** Free

---

## 14. Location-Based Features

### 14.1 FR-LB-001: Location-Based Reminders (Pro Tier)

**Description:** Pro users receive reminders when entering location (geofence).

**Key Requirements:**

1. **Geofence Setup**
   - User assigns task/routine to location
   - Example: "Buy medicine at Medical Store"
   - User sets location on map (address or GPS coordinates)
   - User sets radius (default 500 meters, adjustable)

2. **Location Detection**
   - App monitors user's location (if location permission granted)
   - When user enters geofence: Location reminder triggered
   - Only when app is open or in background (depends on OS permissions)

3. **Reminder Trigger**
   - Show notification: "You're near [Location]. Remember to [Task]?"
   - User can mark done, snooze, or dismiss
   - Only shows once per visit to location

4. **Multiple Tasks Per Location**
   - Multiple tasks can be assigned to same location
   - When entering location, all relevant tasks reminded
   - Shown as list: "At Medical Store: Buy medicine, Get prescription refill"

5. **Context-Aware Radius**
   - City locations: 500 meters-1 km radius
   - Home/precise locations: 100-200 meters
   - User can customize per location

**Acceptance Criteria:**
```
✓ User creates task: "Buy medicine at Medical Store"
  → Assigns location on map
  → Sets radius: 500 meters
  → Task saved with location

✓ User is within 500m of Medical Store
  → App triggers notification: "You're near Medical Store. Buy medicine?"
  → User can mark done or snooze
  → Notification doesn't repeat today (already shown)

✓ Multiple tasks at same location
  → Location: "Market"
  → Tasks: "Buy groceries", "Pay bills", "Get haircut"
  → Shows all when entering market

✓ User customizes radius
  → Home location: 100 meters (precise)
  → Office location: 1 km (wider)
  → Each location has own radius
```

**Tier:** Pro

---

## 15. Account & Preferences

### 15.1 FR-AP-001: User Account Management

**Description:** User can manage account settings and preferences.

**Key Requirements:**

1. **Account Basics**
   - Email, phone number (for WhatsApp)
   - Display name, profile picture
   - Password management (change, reset)
   - Account deletion (with 30-day recovery period)

2. **Subscription Management**
   - View current tier (Free / Pro)
   - Subscription status and expiry date
   - Payment method
   - Cancel or upgrade subscription
   - Billing history

3. **Data Management**
   - Export all data (CSV, PDF)
   - Delete all data permanently
   - Download backup
   - Data privacy statement

4. **Account Recovery**
   - If deleted: 30-day recovery window
   - After 30 days: Permanently deleted
   - Recovery via email link

**Acceptance Criteria:**
```
✓ User updates profile
  → Changes name, picture
  → Changes reflected across app

✓ User changes password
  → Enters old password
  → Sets new password
  → Logged out on all devices
  → Must re-login

✓ User deletes account
  → Shows: "Account will be deleted in 30 days"
  → Email sent with recovery link
  → Can click link to cancel deletion
  → After 30 days: Permanently deleted

✓ User exports data
  → Downloads CSV with all tasks, routines, mood logs
  → Can open in Excel or Google Sheets
```

**Tier:** Free (basic), Pro (includes export)

---

### 15.2 FR-AP-002: Notification & Reminder Preferences

**Description:** User customizes notification behavior globally.

**Key Requirements:**

1. **Quiet Hours**
   - User sets: "From 10 PM to 8 AM (no reminders)"
   - Critical reminders respect quiet hours
   - Rescheduled to after quiet hours end

2. **Notification Frequency**
   - Adaptive (system decides based on patterns)
   - Frequent (many reminders)
   - Minimal (only critical reminders)
   - None (no reminders, manual only)

3. **Notification Method**
   - App notification (silent, visual only)
   - Sound alert (with sound)
   - Vibration (silent but vibrates)
   - Sound + Vibration (both)

4. **Device Selection**
   - Remind on all devices
   - Phone only
   - Desktop only
   - WhatsApp only (Pro tier)

5. **Reminder Customization Per Task**
   - Override global for specific task
   - Frequency: Single, Multiple, Escalating
   - Timing: Custom hours before deadline
   - Method: Override global method

**Acceptance Criteria:**
```
✓ User sets quiet hours 10 PM-8 AM
  → No reminders during this time
  → Critical reminders moved to 8 AM
  → Pending reminders shown at 8 AM

✓ User selects "Minimal" reminders
  → Only critical/urgent reminders sent
  → Routine tasks get no reminder
  → Final deadline reminder only sent

✓ For specific task "Final Exam"
  → Override global "Minimal" setting
  → Set to "Escalating" reminders
  → Final Exam gets multiple reminders
  → Other tasks use "Minimal"

✓ User selects "Phone only" devices
  → Reminders sent to mobile only
  → Desktop app doesn't get notifications
  → WhatsApp doesn't get reminders
```

**Tier:** Free

---

### 15.3 FR-AP-003: Language & Localization

**Description:** Support for multiple languages and regional preferences.

**Key Requirements:**

1. **Supported Languages**
   - English, Urdu, Arabic, Spanish, French, Chinese, Hindi
   - All UI translated
   - Messages translated
   - System responses in user's language

2. **Language Selection**
   - Set during onboarding
   - Can change in settings
   - App UI switches immediately
   - Messages/AI responses adapt

3. **Region-Specific Content**
   - Prayer times (if user's location supports)
   - Regional holidays (not counted as productive time)
   - Currency preferences (for budget tracking)

4. **RTL Support** (for Arabic, Urdu)
   - Right-to-left text rendering
   - UI mirrors for RTL languages
   - Proper text alignment

**Acceptance Criteria:**
```
✓ User selects Urdu during onboarding
  → Entire UI switches to Urdu
  → Messages: "اپنا ٹاسک شامل کریں" (Add your task)
  → System responses in Urdu

✓ User changes language to Arabic
  → UI becomes RTL
  → Text aligned right
  → All messages in Arabic

✓ Region: Pakistan selected
  → Prayer times shown for Islamabad
  → Islamic holidays marked
  → Currency: PKR for budgeting
```

**Tier:** Free

---

### 15.4 FR-AP-004: Context-Aware Scheduling

**Description:** Different task views and schedules per location context.

**Key Requirements:**

1. **Context Definitions**
   - User creates contexts: "At Home", "At Work", "At University", "In Village", "Traveling"
   - Each context is independent
   - Can switch contexts manually

2. **Context-Specific Task Views**
   - Tasks filtered by context
   - Show only relevant tasks for current context
   - Example: "At Home" shows personal tasks, "At Work" shows work tasks

3. **Context-Specific Routines**
   - Routines assigned to contexts
   - Different times per context
   - Example: "Morning routine at Home" (6 AM) vs "Morning at Office" (8 AM)

4. **Automatic Context Detection** (Future)
   - Initially: Manual selection
   - Later: Auto-detect from location
   - Or time-based (9-5 = work context)

5. **Context Switching**
   - User manually switches context
   - Visual indicator showing current context
   - Can quickly switch between contexts

**Acceptance Criteria:**
```
✓ User creates contexts: "At Home", "At Work"
  → "At Home": Morning meditation (6 AM), Personal tasks
  → "At Work": Team standup (9 AM), Work tasks

✓ User selects "At Home" context
  → App shows only home-relevant tasks
  → Shows morning meditation routine
  → Hides work tasks

✓ User switches to "At Work"
  → Task list updates
  → Shows work tasks only
  → Shows team standup (not morning meditation)

✓ Routine times differ per context
  → "Breakfast at Home": 7 AM
  → "Breakfast at Office": 8:30 AM
  → System shows correct time based on context
```

**Tier:** Free

---

## 16. Feature Tier Breakdown

### 16.1 Free Tier Features

**Available for all users (no payment required):**

- ✅ Task management (create, edit, delete, view)
- ✅ Task scheduling algorithm
- ✅ Partial completion & task splitting
- ✅ Routine management (create, edit, delete)
- ✅ Routine prioritization (mandatory/important/normal)
- ✅ Location-based routines (context switching)
- ✅ Smart escalating reminders
- ✅ Start & completion check-ins (FR-RN-004)
- ✅ OS-level notifications (offline-friendly)
- ✅ Notification preferences (quiet hours, frequency, method)
- ✅ Document upload & processing (OCR)
- ✅ Deadline extraction from documents
- ✅ Schedule extraction from documents
- ✅ Topic & context extraction
- ✅ Mood tracking & logging
- ✅ Mood-based recommendations (basic)
- ✅ Adaptive task rescheduling (stress handling)
- ✅ Pattern identification & learning
- ✅ Pattern-based recommendations
- �� WhatsApp integration (task creation only)
- ✅ Voice input (speech-to-text)
- ✅ Voice output (text-to-speech)
- ✅ Multi-device sync (offline-first)
- ✅ Conflict resolution (automatic)
- ✅ Basic analytics & dashboard
- ✅ Task filtering & sorting
- ✅ Categories (predefined + custom)
- ✅ Task tagging
- ✅ Account management (basic)
- ✅ Data export
- ✅ Language support (English, Urdu, Arabic)
- ✅ Context-aware scheduling
- ✅ Undo task deletion (24 hours)

---

### 16.2 Pro Tier Features

**Available for paid subscribers only:**

- ✅ Everything in Free Tier, plus:
- ✅ WhatsApp reminders (within 24-hour window, if user messaged)
- ✅ Conversational AI (Ollama-based LLM for emotional support)
- ✅ Advanced mood-based recommendations
- ✅ Location-based reminders (geofence-triggered)
- ✅ Budget tracking & expense management
- ✅ Advanced analytics (detailed insights, comparisons)
- ✅ Export to PDF (with formatting and charts)
- ✅ Extended memory (more user context stored)
- ✅ More efficient pattern detection (faster recommendations)
- ✅ Priority email/chat support

---

## 17. Edge Cases & Error Handling

### 17.1 FR-EH-001: Handle Offline Scenarios

**Description:** System handles various offline situations gracefully.

**Key Requirements:**

1. **App Launch Offline**
   - App launches normally, loads from local SQLite
   - Shows cached data from last sync
   - Visual indicator: "Offline" badge shown
   - No error message, app works normally

2. **Tasks Created While Offline**
   - Stored immediately in SQLite
   - Marked "pending sync"
   - When online, synced to cloud
   - No data loss

3. **Reminders While Offline**
   - OS alarm triggers reminders (no internet needed)
   - Local database checked for task status
   - Notification shown even without internet
   - When online, sync confirms delivery

4. **No Network Sync Failure**
   - If sync fails (network error):
     - Retry automatically (exponential backoff)
     - Show notification: "Syncing tasks..." then "Sync failed. Retry?"
     - User can manually retry or ignore
     - Data NOT lost

5. **Document Upload Offline**
   - User cannot upload documents while offline
   - Show: "No internet. Download files when online."
   - Allow retry when online

**Acceptance Criteria:**
```
✓ User opens app while offline
  → App launches normally
  → Shows "Offline" badge
  → Displays cached data
  → Works fully

✓ User creates task while offline
  → Task stored in SQLite
  → Shown in list with gray checkmark (pending sync)
  → When online, syncs automatically

✓ Reminder due while offline
  → OS triggers alarm at scheduled time
  → Notification shown without internet
  → User marks done
  → When online, marked complete in cloud

✓ Sync fails due to network error
  → Shows: "Sync failed. Retry?"
  → User can click "Retry"
  → Auto-retry every 30 seconds
  → No data lost
```

**Tier:** Free

---

### 17.2 FR-EH-002: Handle Network Interruptions

**Description:** System handles mid-sync interruptions.

**Key Requirements:**

1. **Sync Interrupted**
   - If sync stops mid-operation:
     - Partial changes marked "pending"
     - Next sync completes operation
     - No duplicate creation

2. **Retry Logic**
   - Initial retry: 5 seconds
   - Exponential backoff: 10s, 20s, 40s, 80s, 160s (max)
   - After 5 retries, pause and show user notification
   - User can manually retry

3. **Connection Recovery**
   - When internet restored:
     - Auto-attempt sync immediately
     - User doesn't need to do anything

**Acceptance Criteria:**
```
✓ Sync interrupted mid-operation
  → Task partially synced
  → Marked "pending sync"
  → Next sync completes operation
  → No duplicate creation

✓ Sync fails, retry logic activates
  → Retry 1: After 5 seconds
  → Retry 2: After 10 seconds
  → Retry 3: After 20 seconds
  → After 5 retries: Show "Sync failed" notification

✓ User clicks "Retry"
  → Immediately attempts sync
  → No artificial delay
```

**Tier:** Free

---

### 17.3 FR-EH-003: Handle Invalid Input & Clarification

**Description:** System handles unclear user input gracefully.

**Key Requirements:**

1. **NLP Extraction Failures**
   - If Clarity Index very low (<20%):
     - Show: "I'm not sure what you mean. Can you clarify?"
     - Show options: "Create task?", "Set reminder?", "Something else?"
     - User selects or provides clearer input

2. **Missing Critical Information**
   - If task has no due date:
     - System asks: "When should this be done?"
     - Waits for response before creating
   - If no task name:
     - System asks: "What's the task?"

3. **Conflicting Information**
   - If user says: "Due yesterday"
     - System asks: "You mean [date]? That's in the past."
     - Offers alternatives: "Set for today?", "Tomorrow?", "Another date?"

4. **System Suggests Correction**
   - If typo detected: "Did you mean [corrected]?"
   - User can accept or correct
   - Learning: System remembers corrections

**Acceptance Criteria:**
```
✓ User: "I need to do stuff"
  → Clarity Index: 10%
  → Shows: "I'm not sure. Do you want to:"
  → Options: "Create task?", "Set reminder?", "Add routine?"

✓ User: "Assignment due yesterday"
  → System: "That's in the past. Did you mean today or another date?"
  → User selects: "Tomorrow"
  → Creates task for tomorrow

✓ User: "Aassignment due Friday"
  → System: "Did you mean 'assignment'?"
  → User confirms
  → Creates with corrected spelling
```

**Tier:** Free

---

### 17.4 FR-EH-004: Handle Database & Sync Errors

**Description:** System recovers from database corruption or sync errors.

**Key Requirements:**

1. **Local Database Corruption**
   - If SQLite corrupted:
     - App attempts repair
     - If repair fails, shows: "Data issue. Force sync?"
     - User can sync from cloud (overwrites local)
     - Or restart app to retry

2. **Sync Conflict With No Resolution**
   - If conflict cannot be auto-resolved:
     - Show both versions to user
     - User chooses: "Keep mine" or "Use cloud version"
     - Applied immediately

3. **Cloud Data Loss** (unlikely but prepared)
   - Backups kept for 90 days
   - If user notices data missing:
     - Contact support
     - Support can restore from backup

4. **Version Mismatch**
   - If local version higher than cloud (shouldn't happen):
     - Local wins (assume network issue delayed sync)
     - Sync attempts again

**Acceptance Criteria:**
```
✓ Local database corrupted
  → App detects on startup
  → Shows: "Database issue. Sync from cloud?"
  → User accepts
  → Overwrite local with cloud data
  → App works normally

✓ Sync conflict cannot resolve
  → Show: "Conflict found. Your version or cloud version?"
  → User selects one
  → Applied immediately
  → Synced to confirm

✓ True data loss detected
  → User can request restore from backup
  → Support team restores data
  → No user data permanently lost
```

**Tier:** Free

---

## 18. Onboarding & Initial Setup

### 18.1 FR-OB-001: Account Creation & First Login

**Description:** New user creates account and starts using app.

**Key Requirements:**

1. **Sign Up Process**
   - Email or phone number registration
   - Firebase Auth handles secure signup
   - Email verification (click link to verify)
   - Password strength requirements
   - Optional: Social login (Google, Apple)

2. **Initial Preferences Setup**
   - User's language preference
   - Time zone
   - Notification preferences (quiet hours, frequency)
   - Context creation (At Home, At Work, etc.)
   - **Estimate time:** 10-15 minutes

3. **Skip Setup Option**
   - User can use basic features without full setup
   - But for best experience, onboarding recommended
   - Show: "Setup now (10 min) or Start using? (Setup later in preferences)"

4. **Setup Progress**
   - Show progress: "Step 1 of 5" with checkmark
   - Allow going back to previous steps
   - Save progress automatically

5. **Welcome Tutorial**
   - First-time user gets quick walkthrough
   - Show: "Here's how to add a task", "Here's how to view reminders"
   - Interactive: User tries each feature while tutorial active
   - Can skip if experienced user

**Acceptance Criteria:**
```
✓ New user signup
  → Enters email
  → Creates password
  → Verifies email
  → Account created

✓ Initial preferences
  → Select language: "English" or "Urdu"
  → Select timezone: "Asia/Karachi"
  → Set quiet hours: "10 PM to 8 AM"
  → Create contexts: "At Home", "At Work"
  → Estimated: 10 minutes

✓ Skip setup
  → Shows: "Setup now or Start using?"
  → User clicks "Start using"
  → Preferences accessible later
  → Basic app features available

✓ Welcome tutorial
  → Shows: "Try adding a task"
  → User types task
  → Tutorial: "Great! Now check your tasks list"
  → User can skip anytime
```

**Tier:** Free

---

### 18.2 FR-OB-002: Feature-Based Tutorials

**Description:** When user first uses a feature, brief tutorial appears.

**Key Requirements:**

1. **Contextual Help**
   - When user first accesses a feature, tooltip shown
   - Example: First time opening "Routines" → "Here's how to create a routine"
   - Short 1-2 sentence explanation with example

2. **Interactive Tutorials**
   - For complex features, interactive walkthrough
   - Example: First time uploading document → Step-by-step guide
   - User performs action while tutorial active

3. **Dismiss Options**
   - User can dismiss tutorial anytime
   - Don't show again for this feature: Checkbox available
   - Tutorials can be re-enabled in preferences

4. **Help Button**
   - Every feature has "?" help button
   - Shows: Explanation, example, link to full documentation

5. **Video Tutorials** (Future)
   - Short 30-second videos per feature
   - Accessible from help

**Acceptance Criteria:**
```
✓ User first opens "Routines" feature
  → Tooltip: "Create recurring activities here. Try it!"
  → Simple example shown
  → Can dismiss and continue

✓ User first uploads document
  → Interactive guide:
    1. "Select file"
    2. "Choose type: Syllabus or Schedule"
    3. "We'll extract deadlines automatically"
  → User follows steps
  → Can skip if needed

✓ User clicks "?" help button
  → Shows explanation
  → Example provided
  → Link to full guide

✓ User disables tutorial
  → Checkbox: "Don't show this again"
  → Re-enabled in preferences
```

**Tier:** Free

---

### 18.3 FR-OB-003: Guest Mode (No Account Required)

**Description:** User can use basic app features without creating account.

**Key Requirements:**

1. **Guest Access**
   - User can open app, click "Try without account"
   - Access basic features:
     - Create tasks (stored locally only)
     - View tasks
     - Get reminders (local OS notifications)
     - Create routines
   - NO: Sync, WhatsApp, multi-device access, cloud backup

2. **Limitations**
   - Data stored locally only (lost if app uninstalled)
   - No cloud backup
   - No access from other devices
   - After 30 days, show: "Sign up to save your data"

3. **Convert to Account**
   - Guest user can create account anytime
   - Existing local data can be synced to account
   - Or start fresh with cloud data

4. **Data Loss Warning**
   - Show: "Data stored locally only. Create account to backup?"
   - Regular reminders: "Create account to save your data"

**Acceptance Criteria:**
```
✓ User clicks "Try without account"
  → App launches in guest mode
  → Can create and manage tasks
  → Can set reminders
  → Data stored locally

✓ User uses guest mode for 30 days
  → System shows: "Sign up to save your data to cloud"
  → User can sign up or continue as guest

✓ Guest user converts to account
  → Creates account with email
  → Offered: "Save my current data?" or "Start fresh?"
  → Choice syncs accordingly

✓ Guest user uninstalls app
  → All local data lost
  → No recovery available (warned beforehand)
```

**Tier:** Free

---

## 19. Summary of Acceptance Criteria

### Task Management
- ✅ Add task via text with automatic clarity detection
- ✅ Add task via voice with STT
- ✅ View and filter tasks
- ✅ Edit tasks (via chat or UI)
- ✅ Delete tasks (soft delete with 24-hour recovery)
- ✅ Smart scheduling based on patterns
- ✅ Handle missed tasks based on type
- ✅ Partial completion & task splitting

### Routine Management
- ✅ Create routines (daily, weekly, monthly, custom)
- ✅ Priority levels (mandatory vs optional)
- ✅ Smart rescheduling based on routine type
- ✅ Location-based context switching

### Reminders & Notifications
- ✅ Smart escalating reminders
- ✅ OS-level delivery (offline-friendly)
- ✅ WhatsApp reminders (Pro tier)
- ✅ User preference customization
- ✅ Quiet hours respect
- ✅ Start & completion check-ins with first step and user-chosen style

### Documents & OCR
- ✅ Upload and OCR text extraction
- ✅ Extract deadlines (auto-create tasks)
- ✅ Extract schedules (auto-create routines)
- ✅ Extract topics & context

### Mood & Mental Health
- ✅ Mood tracking (manual & automatic)
- ✅ Mood-based recommendations
- ✅ Adaptive task rescheduling during stress
- ✅ Conversational AI support (Pro tier)

### Patterns & Learning
- ✅ Identify user patterns (completion, routine, mood, productivity)
- ✅ Make pattern-based recommendations
- ✅ Confidence scoring for recommendations

### WhatsApp Integration
- ✅ Receive and process messages
- ✅ Multi-turn conversation support
- ✅ Send reminders (Pro tier, within 24h window)

### Voice & Language
- ✅ Voice input (STT)
- ✅ Voice output (TTS)
- ✅ Multiple language support
- ✅ RTL support for Arabic, Urdu

### Sync & Offline
- ✅ Offline-first architecture
- ✅ Automatic conflict resolution
- ✅ Version control & history
- ✅ Instant sync when possible

### Analytics
- ✅ Track completion metrics
- ✅ Display analytics dashboard
- ✅ Time range filtering
- ✅ Export to PDF (Pro tier)

### Categories & Tagging
- ✅ Predefined + custom categories
- ✅ Task tagging system
- ✅ Filter & sort by categories/tags

### Location & Context
- ✅ Location-based reminders (Pro tier)
- ✅ Context-aware scheduling
- ✅ Geofence setup and detection

### Account & Preferences
- ✅ Account management
- ✅ Notification preferences
- ✅ Language & localization
- ✅ Context definitions

### Onboarding
- ✅ Account creation & setup
- ✅ Feature-based tutorials
- ✅ Guest mode access

### Error Handling
- ✅ Handle offline scenarios
- ✅ Handle network interruptions
- ✅ Handle invalid input
- ✅ Handle database errors

---

## End of Functional Requirements Document

**Next Steps:**
1. Merge PART 1 and PART 2 into single document
2. Review with stakeholders
3. Create use case diagrams
4. Begin technical design phase
5. Start sprint planning

---

**Document Prepared By:** Muhammad Huzaifa, Muhammad Zohaib, Yasir Imran  
**Date:** March 2026  
**Version:** 1.0 (Complete)
