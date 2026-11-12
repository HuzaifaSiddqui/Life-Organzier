# Task collaboration: phone checklist (PR A)

Backend: `COLLAB_TASKS=on` (and the migration applied, see the PR). Optional for step 9: `SMTP_*` in `backend/.env`.
Two accounts on two phones: **A** (owner) and **B** (member), connected in People & sharing. No app rebuild is needed.

## One account

1. Home shows a **bell** right of the sync badge; with no notices it has no badge.
2. Chat: type `@` → "Your people" lists your connections; type letters → it filters; tap one → `@username ` is
   inserted. Send "finish the slides with @username tomorrow 5 pm" → the preview "Share … Together / Only for them /
   Just me" appears; nothing is sent until you tap one.
3. Settings → Notifications: "Email me about shared tasks" is on; turn it off and on.

## Two accounts

4. **A** shares a task with **B** (form "Share with", or chat + Together).
   - **B**: a push "Shared task"; tapping it opens the task's accept screen. Home shows the **Shared with you** card;
     the bell shows a badge.
5. **B** taps **Accept**.
   - **A**: push "Task accepted"; tapping it opens A's own copy. Notifications lists "@B accepted …".
   - **B**: Notifications lists "You joined …" (no push on B's phone).
6. **A** shares another task; **B** taps **Decline** → "Why are you declining?" → quick pick or typed reason → Decline.
   Decline is disabled until there is a reason.
   - **A**: push "Task declined: <reason>"; Notifications and the task under People & sharing → Shared show the reason.
7. On a task done together, **B** sets progress to 50 %.
   - **A**: within a sync (pull to refresh, or the push), A's copy shows 50 % and "Updated by @B"; Notifications lists
     "@B set … to 50%". **A** then sets 75 % → B's copy follows. **B** marks done → A's copy stays at 75 % (done is
     personal).
8. Notifications on **A**: tap a row → it opens the task; "Mark read" on one row; "Mark all read" clears the badge.
9. With SMTP set: **B**'s inbox gets "@A shared a task with you: …". Turn the email switch off on **B** and share
   again → no email. The address never appears in the app or the logs.
10. Chat on **B**: "decline the <title> task" → "Why? 1 Too busy · 2 Not my task · 3 Wrong time" → "2" → declined with
    "Not my task". WhatsApp (if linked): the same, with numbers.
