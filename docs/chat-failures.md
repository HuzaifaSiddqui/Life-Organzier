# Chat failures (11–25 Oct 2026) and how chat changes from now on

Every chat misread fixed in the last two weeks, from device testing and phone tests, including the three
commits from `fix/chat-misreads` (merged in #22). Each one is now a row in `backend/tests/eval/utterance-bank.json`
(id in the last column), so a regression shows up in the bank, not on the phone.

## Classes

- **Contract**: the app or the engine produced text that the engine then couldn't read back (a button sends a
  sentence, a reply says "Say: …"). Fixed for good by structured actions (below), not by more phrases.
- **Capability**: no command existed for the request.
- **Vocabulary**: a command existed, but the words weren't in its rules.
- **Ordering**: the right rule existed, but another rule, or an open question, took the message first.

## The list

| # | Date | Message | What happened | Class | Fix | Bank |
|---|---|---|---|---|---|---|
| 1 | 25 Oct | "Make Go to gym mandatory" (the button after a new routine) | "Which task do you mean?": routine edits needed the word "routine" | Contract | add0c59 (fix/chat-misreads); now a `command` payload with the routine id | f01 |
| 2 | 25 Oct | "Please remove all the pending tasks" / "…all existing tasks" | "couldn't find a task matching 'all pending tasks'" | Capability | add0c59: `bulk_delete_open` | f02, f03 |
| 3 | 25 Oct | "Get me a task related to KFc" | "Overdue: 1 task": "get me" wasn't a question | Vocabulary | add0c59 | f04 |
| 4 | 25 Oct | "I don't want to do any task, I just want sleep" | a task titled with the whole sentence | Vocabulary | add0c59 (tired words) | f05 |
| 5 | 25 Oct | "Yes scheduled for 6 pm" after the reply "Say: schedule a call with Mooz…" | task "Yes scheduled" | Contract | d5d787b (offer kept as the open question, #22; its button is now an `answer` payload) | (depends on the reply before it: not a bank row) |
| 6 | 25 Oct | "Yes schedule a call at 6 pm" / "I mean schedule a call with mooz at 6 pm" | drafts "Yes schedule a call", "Mean schedule…", then "which day?" | Vocabulary | e108928 | f07, f08 |
| 7 | 25 Oct | "when is my physics task due?" | today's list: the word "task" made the lookup give up | Vocabulary | 7cdfbb9 (#18) | f09 |
| 8 | 24 Oct | "Ok change the location to KFC gulberg" | not understood ("Ok" prefix) | Vocabulary | 3be8a6f | f10 |
| 9 | 24 Oct | "change its location to …", "2nd task …" | no command to change a task's place | Capability | b667ca2 | f11 |
| 10 | 24 Oct | "add a task to do 4 push ups today" | "couldn't find a task": read as an update | Ordering | 794dbb7 | f12 |
| 11 | 24 Oct | "we have to do 5 push ups" | not taken as the user's task | Vocabulary | 2dc9be5 | f13 |
| 12 | 24 Oct | "Do 20 push-ups" while a question was open | answered the open question | Ordering | 68432ab | f14 |
| 13 | 24 Oct | a new task naming a place while "which location?" was open | swallowed by the old question | Ordering | d20be90 | f15 |
| 14 | 24 Oct | "we will do it in the evening" to "when?" | not taken as the answer | Vocabulary | 56ac859 | (pending group) |
| 15 | 24 Oct | "I need to call mom's doctor tomorrow" with "Call mom" open | merged into "Call mom" | Ordering | 3b814fb | f16 |
| 16 | 21 Oct | "2", "tomorrow", "haan" while a question was open | a command took them first | Ordering | e869f97 | (pending group) |
| 17 | 20 Oct | the help screen's own examples | some examples ran a different command | Contract | 47055eb | (help test) |
| 18 | 20 Oct | "how much of the essay is done?" | answered by insights | Ordering | 47055eb | f17 |
| 19 | 25 Oct | "I am on kind of routine to go to gym at every Tuesday and Friday In morning 9 AM" (AI off) | title "Am on kind of routine to go to gym at In morning" | Vocabulary | **open** (fine with AI on) | f18 |
| 20 | 25 Oct | "change the essay" (found by the action contract test) | a new task "Change the essay" | Vocabulary | **open**: bank row (freeze) | f19 |
| 21 | 25 Oct | "blorp zinga" | a task draft "Blorp zinga" | Capability (no "I can't do that") | unknown handling (this branch) | f20 |

21 failures: contract 3 · capability 3 · vocabulary 9 · ordering 6.

Not routing failures, so not in the bank: the search matching inside words ("art" in "start", e60bc87), the voice
hints and spelled letters (d98a653, d2d8582), and the Pro invitation shown too often (beaf9d2).

## What changes

1. **Contract**: every button, chip and suggestion carries a structured payload (`command` with a command id and
   arguments, or `answer` for the open question it belongs to), never a sentence to re-parse. `text` stays
   only as what a WhatsApp user can type. Tested by sending every emitted action back
   (`tests/actionContract.test.ts`).
2. **Unknown messages**: "I can't do that yet" + 2–3 things it can do, and the message is logged without a user id to
   `backend/logs/unknown-utterances.jsonl` (`npm run unknown:review` turns it into review rows for the bank).
3. **Meaning-based routing** (when the rules are not highly sure): the nearest bank examples guide the LLM router
   and give a second opinion. See `docs/AI_ASSISTANT_ARCHITECTURE.md` → "Meaning-based router".

## Freeze (from 25 Oct 2026)

No new regex or keyword patches for vocabulary misses. A vocabulary miss becomes a bank row (and a held-out row
if a teammate wrote it), not a rule. Rules change only for real bugs (wrong data, a crash, safety, a broken
contract) and for capability gaps (a new command). Crisis detection stays rules-first and is never routed.

## Proposals from the AI-written sets (30 Oct 2026; not code changes)

Measured with `scripts/eval-chat-set.ts` (whole chat, seeded tasks and routines, test database). Sets: the first 150
(`chat-heldout-ai-written.json`, dev-informed), `chat-set2-ai-en.json` class-test (40, checks the fixes) and fresh (60,
report only). No real-user rows yet. "Chain" = Ollama first, cloud only if Ollama fails. Fixes = `CHAT_FIXES_V2`.

| Group | AI off: fixes off → on | Chain: fixes off → on | Harmful actions on "none" rows (fixes off → on) |
|---|---|---|---|
| Dev 150 | 101 → 107 | 104 → 113 | 1/10 → 0/10 |
| Class-test 40 | 14 → 20 | 19 → 25 | – |
| Fresh 60 | 43 → 44 | 49 → 50 | 1/5 → 1/5 |

Class-test per class (correct of n; AI off before → after | chain before → after): D 9: 4→5 | 7→8 · E 6: 1→3 | 2→4 ·
H 5: 1→1 | 1→1 · A 3: 3→3 | 3→3 · B 3: 2→3 | 2→3 · C 4: 0→1 | 1→2 · G 3: 0→0 | 0→0 · I 3: 0→0 | 0→0 · F 2: 2→2 | 2→2 ·
routine moves 2: 1→2 | 1→2.

### Clear bugs (shown to the owner first; not fixed)

1. **A habit word alone creates a routine** (harmful): "booked the team lunch, tick it off" (n-069) and "play my
   workout playlist" (n-100) create routines. Proposal: no routine without an explicit repeat cue; otherwise a task,
   or "How often?".
2. **When a fix makes a message unsure, the model can pick a changing command in the wrong family** (chain):
   "not going to the gym today" → routine completed (n-016); "can't make the reading session tonight" → undo (n-018).
   Proposal: an unsure H message may only reach skip / pause commands, an unsure E message only complete commands,
   else ask.
3. **"notifications" goes to a task's reminder mode**: "turn off notifications for 2 hours" (n-032), "mute
   notifications for 90 minutes" (n-087) → task_reminder_mode. Proposal: notification / mute / do-not-disturb words
   reach the settings commands before task commands.

### Fix weaknesses (proposals, to test on new rows)

- I: feelings with no subject ("so tired today", "kind of anxious this morning", "exhausted tonight") still become
  tasks: accept a bare feeling word with a time word and no action verb.
- C: changes without "now / instead" ("actually the dentist is at 5pm", "the call with the bank will take an hour",
  "the car wash can wait until saturday") still create tasks: add "actually", "will take", "can wait until".
- G: the status clause leaks into the reference ("I'm exhausted, move everything to tomorrow" → task "exhausted
  everything"): drop the status clause before resolving; "everything / all of today / today's list" is a bulk move.
- H: "no yoga today" (no verb) is a skip of that routine.
- E: "practiced yoga this morning", "did the gym today": report verbs beyond the current list.

### Vocabulary (bank rows, not code)

"how does my week look", "fit my tasks into my free time this afternoon", "move today's list to thursday", "delete the
completed ones", "mark all my errands as done", "compare this week with last week", "drop the passport thing".
