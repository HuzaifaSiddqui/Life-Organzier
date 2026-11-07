# FRD deviations

Deliberate departures from `docs/FRs/FUNCTIONAL REQUIREMENTS.md`, each approved by the owner and recorded here with
its reason, scope and how to undo it.

| FR | Deviation | Scope | Reason | Undo |
|---|---|---|---|---|
| FR-TM-001 (Clarity Index) | A deadline with a real date but no time is **created**, due at the end of that day (stored date-only, shown as 11:59 PM), with the reply line "11:59 PM assumed. Say 'change time' to set another." The Clarity Index would ask for the time first. A deadline with **no date still asks**. | Only with `CHAT_FIXES_V2=on` (default off). Approved 2 Nov 2026. | Asking the time for every dated deadline ("submit the invoice on the 9th") cost a turn for little gain; a date-only deadline keeps useful reminders (the day before at 10 AM and the morning of the day; no late-night "1 hour left"). "change time" (or "change time to 5 pm") sets it afterwards. | `CHAT_FIXES_V2=off` |
| §1.2 "Third-party calendar integration (Phase 2)" | Built now, on the phone's own calendar (`expo-calendar`) instead of a third-party API: one-way write to a separate "Life Organizer" calendar, busy time read on the phone. No Google OAuth, no `.ics` feed; Google / Outlook reach it only through the phone's calendar sync. See [calendar.md](calendar.md). | Only with `CALENDAR_SYNC=on` (default off) and the user's switch in Settings. Approved 3 Nov 2026. | The owner asked for calendar integration before the 10 Nov freeze; the device route needs no keys, no accounts and no cost, and keeps calendar contents on the phone. | `CALENDAR_SYNC=off` (events already written stay until "Remove all") |
| FR-WA-001 / FR-WA-002 (one WhatsApp number via the Business API) | Each user connects their own WhatsApp Agent instead. See [whatsapp-agent.md → FRD deviation note](whatsapp-agent.md#frd-deviation-note). | – | – | – |
