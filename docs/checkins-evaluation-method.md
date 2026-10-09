# Check-in evaluation method (FR-RN-004)

Method section for the FYP report. Numbers come from `backend/scripts/checkin-report.ts`, which writes the results to `docs/checkin-evaluation-results.md` and the raw (pseudonymous) rows to CSV.

## 1. Study design

**Randomised part (research mode).** A participant can switch on *research mode* (`UserSettings.checkinResearchMode`). When it is on, each START / START_FOLLOWUP check-in is planned either with its first step or with the first step deliberately left out. The choice is a stable hash of `taskId:kind:fireAt`, decided once per check-in when it is planned (`researchIncludesStep` in `checkinService.ts`), so re-planning never flips it. It is 50/50 over many check-ins, not balanced per participant. Omitted steps are logged as `copySource = WITHHELD`, and `CheckinLog.researchMode` records that the row was planned under research mode. Only these rows support a causal comparison: *first step shown* vs *WITHHELD*, among research-mode START check-ins.

**Observational part.** All other check-ins (research mode off) are described, not compared causally: response rates, start rate by tone (Funny / Serious / Gentle) and by first-step source (Gemini / Ollama / library / none). Tone is chosen by the participant (or lowered to Gentle after a hard mood), and the source depends on availability, so these groups differ in more than the thing being compared. The report labels these tables "descriptive, not randomised".

## 2. Measures

| | Measure | Definition |
|---|---|---|
| (a) | Response rates | Per check-in kind: answered / ignored (no answer 2 h after firing) / stale (answered after the check-in was cancelled, e.g. rescheduled). Only resolved check-ins count. |
| (b) | Start rate | Share of resolved, non-stale START check-ins answered "Started" within 15 minutes of the fire time. The tap time (`respondedAt`) is used, not the delivery time. Reported with a 95% Wilson interval, the number of distinct users, and the per-user average rate (each user weighted equally). Cells with n < 20 are labelled "too few to compare". |
| (c) | Estimate ratio | Median of actual ÷ estimated duration per category, from tasks with `startedAt`, `completedAt` and a duration; actual = `completedAt − startedAt`. Excluded: partial-progress tasks, tasks rescheduled after starting, work that crosses local midnight, and ratios below 0.2 or above 4. At least 5 usable tasks per category. Reported separately for tasks completed by a check-in answer and completed manually. |
| (c) | Suggestion acceptance | Accepted ÷ shown for the "Use 2h 45m?" suggestion. A display counts once per user, category, original duration and local day; it is accepted if the same key has an acceptance event. |
| (d) | Estimate accuracy | Mean \|actual − planned\| ÷ planned. Descriptive, **not causal**: only categories in which the user was shown a suggestion, split at that user's first display, then accepted vs shown-but-not-accepted. |

**Clustering caveat.** Wilson intervals assume independent check-ins. Check-ins cluster by user (and by task), so the intervals are too narrow. Read the per-user average and the number of users next to every rate; with few users the pooled rate is dominated by the most active ones.

Excluded everywhere: stale answers, and users listed in `--exclude-users` (the development team and anyone who only tested the feature).

## 3. Data collection

Every check-in is stored in `CheckinLog` when planned (kind, tone, whether a first step was included, `copySource`, mood at planning, `researchMode`, message) and updated when answered (`response`, `respondedAt`, `stale`). Completion method is stored on the task (`completedVia` = `CHECKIN` or `MANUAL`). Suggestion displays and acceptances are `ActivityEvent` rows (`ESTIMATE_SUGGESTION_SHOWN` / `ESTIMATE_SUGGESTION_ACCEPTED`) with category, original and suggested minutes, and the surface (task form or chat). Participants use the app normally on their own phones over the study period; the report is run once at the end with `--from` / `--to`.

## 4. Privacy

- **Participants must consent** before research mode is turned on: they are told that their check-in answers and timings are analysed, that some check-ins will intentionally have no first step, and that they can switch it off or delete their account at any time (logs are deleted with the account).
- The export (`checkin-log.csv`, `estimate-suggestions.csv`) has **no task titles, no message text and no emails**. User ids are replaced by `sha256(REPORT_ID_SALT:id)` truncated to 10 hex characters; the salt is kept private and the script refuses to run without it. Data in the report is category-level.
- Only the **task title and planned duration** are ever sent to a language model for the first step (Gemini if configured, otherwise the local Ollama model). Descriptions, notes, mood and user details are not sent. With Gemini configured, titles leave the device and the participant's machine to Google; unset the key to keep everything local.

## 5. Held-out evaluation (Roman Urdu dates and times)

Date and time extraction is deterministic code (`assistant/entities.ts`), not a model. The Roman Urdu rules were developed against `tests/eval/assistant-eval.json`, so scores on that file are not an unbiased estimate. `tests/eval/roman-urdu-holdout.json` is reserved for messages written by a teammate who has not read `entities.ts`; its accuracy is reported separately as "held-out" by `scripts/model-benchmark.ts --deterministic`, and the extractor is not tuned against it. At the time of writing it contains no scored messages.

## 6. Threats to validity

- **Small sample.** A student project with a handful of participants over a few weeks: most cells will be under n = 20 and the report says so.
- **Clustering.** Repeated check-ins from the same few users (see §2).
- **Completion times anchored to check-ins.** "Actual" duration is `completedAt − startedAt`, where `startedAt` is when the user *told* the app (a check-in tap or a status change), and `completedAt` is often the tap on the completion check-in. Tasks finished by a check-in answer are biased towards the check-in time, which is why the ratio is also reported for manual completions.
- **Practice and novelty effects.** Users may start more often just because the feature is new, and estimate better because they practise; (d) cannot separate this from the effect of the suggestion.
- **Team members as users.** Developers know how the system works. They are excluded from the report, but participants recruited from friends may also behave unnaturally.
- **Gemini availability changes the source mix.** On a free key Gemini often returns 429/503, so which first-step source a check-in gets depends on load at planning time, not on the task. Comparisons by source mix tasks, languages and times.
- **Quiet hours and the daily cap** remove check-ins non-randomly (late-evening tasks, busy days).
