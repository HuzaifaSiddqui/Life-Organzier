# Local model benchmark

Run: 2026-10-09T08:44:20.933Z · Ollama 0.34.3 · think:false · num_ctx 4096 · one run per item, warm model (load time excluded).

Inputs: `backend/tests/eval/assistant-eval.json` (42 chat messages, English + Roman Urdu; 10 first-step tasks × en/ur). Raw rows: `backend/tests/eval/results/model-benchmark-2026-10-09T08-44-20-816Z.csv`.

The LLM intent step is called **directly** (rules bypassed). In the app, rules answer most messages first and the LLM is only asked when they are unsure.

## Summary

| Model | Intent accuracy | Title accuracy | JSON valid | First step valid (en) | First step valid (ur) | Intent latency median / p90 | First-step latency median / p90 | Peak memory (VRAM) | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 93% | 93% | 100% | 90% | 80% | 1874 / 2219 ms | 1643 / 2251 ms | 4.7 GB (4.7 GB) | 0 |
| qwen3.5:9b | 93% | 53% | 100% | 90% | 100% | 7160 / 8975 ms | 3502 / 4505 ms | 5.6 GB (5.6 GB) | 0 |

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
| qwen3.5:9b | lectures every Monday and Wednesday at 9 | create_routine | provide_info |
| qwen3.5:9b | mazaq band karo | set_checkin_style | support |
| qwen3.5:9b | the thing for Friday | unclear | query_tasks |

## All first steps

✓ passes `validateFirstStep`, ✗ rejected.

| Task | Lang | qwen2.5:7b | qwen3.5:9b |
|---|---|---|---|
| Physics assignment | en | ✓ open physics textbook | ✓ Open your physics textbook |
| Physics assignment | ur | ✗ فیزیک کے وظífہ کا نظیفہ کریں | ✓ اپنا فزکس کا کام شروع کریں |
| Write the history essay | en | ✓ Research topic | ✓ Gather relevant historical sources |
| Write the history essay | ur | ✓ تاریخی مقالہ کے عنوان بنائیں | ✓ کتابوں سے مواد جمع کریں |
| Revise for the maths exam | en | ✓ review past exam papers | ✓ Open your math textbook now |
| Revise for the maths exam | ur | ✗ مATH کی کہانی کا نظر آیا | ✓ اپنے ریاضی کے نوٹس نکالیں |
| Fix the login bug in the FYP app | en | ✓ Identify affected login functionality | ✓ Reproduce the login issue locally |
| Fix the login bug in the FYP app | ur | ✓ فیلڈ کیس کیس کریں | ✓ کد میں غلطی تلاش کریں |
| Pay the electricity bill | en | ✓ Open online billing portal | ✓ Open your electricity provider website |
| Pay the electricity bill | ur | ✓ کیسے کریم کریں | ✓ برقی بل کا رسید نکالیں |
| Prepare slides for the SE presentation | en | ✓ Identify presentation topic | ✓ Gather all project requirements and goals |
| Prepare slides for the SE presentation | ur | ✓ میزبانی کی کیسے شروع کریں | ✓ پاور پوائنٹ کا نیا فائل بنائیں |
| Read chapter 7 of the OB book | en | ✗ open OB book | ✓ Open your OB book to chapter seven |
| Read chapter 7 of the OB book | ur | ✓ کتاب کا فہرستیہ کھولو | ✓ کتاب کا سہم کھولیں |
| Apply for the HEC scholarship | en | ✓ Gather required documents | ✗ Visit the HEC scholarship website |
| Apply for the HEC scholarship | ur | ✓ اطلاعات تیار کریں | ✓ ہی سی ایف کی ویب سائٹ پر جائیں |
| Clean my room | en | ✓ Remove clothes from floor | ✓ Pick up clothes from the floor |
| Clean my room | ur | ✓ پاک کرنا | ✓ اپنے کمرے کا دروازہ بند کریں |
| Practice DSA problems on LeetCode | en | ✓ Log in to LeetCode | ✓ Open LeetCode website and create account |
| Practice DSA problems on LeetCode | ur | ✓ لوگوں کے ذریعہ دیکھنا یا کھلاڑی بننا | ✓ لیکٹ کوڈ پر ایک مسئلہ منتخب کریں |
