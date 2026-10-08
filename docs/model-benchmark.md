# Local model benchmark

Run: 2026-10-08T22:13:49.371Z · Ollama 0.34.3 · think:false · num_ctx 4096 · one run per item, warm model (load time excluded).

Inputs: `backend/tests/eval/assistant-eval.json` (42 chat messages, English + Roman Urdu; 10 first-step tasks × en/ur). Raw rows: `backend/tests/eval/results/model-benchmark-2026-10-08T22-13-48-848Z.csv`.

The LLM intent step is called **directly** (rules bypassed). In the app, rules answer most messages first and the LLM is only asked when they are unsure.

## Summary

| Model | Intent accuracy | Title accuracy | JSON valid | First step valid (en) | First step valid (ur) | Intent latency median / p90 | First-step latency median / p90 | Peak memory (VRAM) | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 93% | 93% | 100% | 70% | 70% | 2370 / 2940 ms | 3471 / 4642 ms | 4.7 GB (4.7 GB) | 0 |

## Deterministic fields (same for every model)

Dates, times and durations are extracted by code (`assistant/entities.ts`), never by the LLM, so they are measured once:

- **date:** 73% (8/11) — missed: m03 (expected 2026-10-06, got none), m10 (expected 2026-10-06, got none), m19 (expected 2026-10-06, got none)
- **time:** 75% (3/4) — missed: m03 (expected 9 AM, got none)
- **duration:** 100% (4/4)

## Intent errors

| Model | Message | Expected | Got |
|---|---|---|---|
| qwen2.5:7b | har roz subah namaz parhni hai | create_routine | create_task |
| qwen2.5:7b | math | unclear | query_tasks |
| qwen2.5:7b | the thing for Friday | unclear | query_tasks |

## All first steps

✓ passes `validateFirstStep`, ✗ rejected.

| Task | Lang | qwen2.5:7b |
|---|---|---|
| Physics assignment | en | ✓ Open textbook |
| Physics assignment | ur | ✓ فیزیک کا وظیفہ شروع کریں |
| Write the history essay | en | ✓ Research topic |
| Write the history essay | ur | ✓ تاریخی مقالہ کے عنوان بنائیں |
| Revise for the maths exam | en | ✓ review past exam papers |
| Revise for the maths exam | ur | ✗ مATH کی کتاب کیسے فتح کریں |
| Fix the login bug in the FYP app | en | ✓ Identify affected login functionality |
| Fix the login bug in the FYP app | ur | ✓ بزنس کے کیس میں دیکھنا |
| Pay the electricity bill | en | ✓ Open online billing portal |
| Pay the electricity bill | ur | ✓ فواتیہ کا نام لیں |
| Prepare slides for the SE presentation | en | ✓ Identify presentation topic |
| Prepare slides for the SE presentation | ur | ✓ میزبان کی معلومات جوہری کریں |
| Read chapter 7 of the OB book | en | ✗ open OB book |
| Read chapter 7 of the OB book | ur | ✗ کتاب کا میزаж 7 کو پڑھنے کا ترتیب دے |
| Apply for the HEC scholarship | en | ✓ research HEC scholarship requirements |
| Apply for the HEC scholarship | ur | ✓ د معلومات کو جمع کریں |
| Clean my room | en | ✗ Remove clothes from floor |
| Clean my room | ur | ✓ پاک کرنا |
| Practice DSA problems on LeetCode | en | ✗ log in to LeetCode |
| Practice DSA problems on LeetCode | ur | ✗ LeetCode پر دسٹوں کی سوالات کیسے بیان کریں |
