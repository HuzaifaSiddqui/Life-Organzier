# Evaluation sets

- `assistant-eval.json` — fixed set for `scripts/model-benchmark.ts` (intent, titles, first steps, deterministic fields). The Roman Urdu date/time rules in `entities.ts` were tuned against it, so its Roman Urdu scores are not an unbiased estimate.
- `roman-urdu-holdout.json` — **held-out** Roman Urdu messages, currently empty (two `"example": true` rows show the schema and are not scored).

## Adding to the held-out set

A teammate who **has not read `assistant/entities.ts`** should add about 20 messages, the way they or their friends really type tasks (mix of dates, clock times, "subah/shaam", "saarhe/sawa/pone", durations; include some with no date or time). For each message add the expected `date`, `time` and/or `duration` as a human would read it, using the file's `now` (Mon 5 Oct 2026) and Asia/Karachi. Leave a field out if the message doesn't contain it.

Do not tune `entities.ts` against these rows; if you fix a miss, add new rows rather than moving the failing ones. Report with `npx tsx scripts/model-benchmark.ts --deterministic` (section "Held-out Roman Urdu").
