# Evaluation sets

- `assistant-eval.json` — fixed set for `scripts/model-benchmark.ts` (intent, titles, first steps, deterministic fields). The Roman Urdu date/time rules in `entities.ts` were tuned against it, so its Roman Urdu scores are not an unbiased estimate.
- `assistant-eval.json` → `commands` — 169 chat-command rows (English, Urdu script, Roman Urdu) with the expected registry command and arguments, scored together with the `messages` intents by `npm run eval:assistant` (rules only, AI off; `-- --baseline` = the rules before the command registry). **Tuned set (rules written against these rows)**: its score (207/211) is a regression check, not accuracy.
- `assistant-eval.json` → `pending` — replies sent while a question is open (every pending kind × short answers such as "2", "tomorrow", "haan", plus new requests that may replace the question). Also tuned.
- `chat-holdout.json` — **held-out** chat commands, **still empty** (two `"example": true` rows show the schema), so there is no accuracy number for chat commands yet. Scored separately by `npm run eval:assistant` once filled.
- `roman-urdu-holdout.json` — **held-out** Roman Urdu messages, currently empty (two `"example": true` rows show the schema and are not scored).

- `utterance-bank.json` — the example bank for the meaning-based router (`npm run eval:router`): seeded from the rows above, `query-eval.json` and the failures in `docs/chat-failures.md`. Rows are added only by `npm run bank:approve` (approved review rows) or by hand for a new miss. Never from `chat-holdout.json`.
- `review/paraphrases-review.json` — model paraphrases waiting for review (`npm run paraphrases`, English only); none are in the bank until approved.
- `collect-sheet.md` — the sheet classmates fill (12 everyday situations + "anything else"). `npm run collect -- collect-AB.md` adds the labelled messages (S01–S12, labelled by their situation) to `chat-holdout.json` and the "anything else" ones to `review/collect-review.json` with no command; a person labels those and moves them to `chat-holdout.json` by hand. Nothing from either goes into the bank.

## Adding to the held-out set

A teammate who **has not read `assistant/entities.ts`** should add about 20 messages, the way they or their friends really type tasks (mix of dates, clock times, "subah/shaam", "saarhe/sawa/pone", durations; include some with no date or time). For each message add the expected `date`, `time` and/or `duration` as a human would read it, using the file's `now` (Mon 5 Oct 2026) and Asia/Karachi. Leave a field out if the message doesn't contain it.

Do not tune `entities.ts` against these rows; if you fix a miss, add new rows rather than moving the failing ones. Report with `npx tsx scripts/model-benchmark.ts --deterministic` (section "Held-out Roman Urdu").

## Adding to the chat held-out set

Same rule: a teammate who **has not read `assistant/commands/` or `entities.ts`** writes about 30 messages asking the assistant to do things in the app (routines, settings, insights, bulk changes, two requests in one message), in the three languages. For each, add the command name from `docs/chat-coverage.md` and only the arguments a human reads from the message. Never tune the rules on these rows.
