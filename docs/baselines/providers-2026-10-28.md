# Provider benchmark 2026-10-28

Raw: `providers-2026-10-28.json`. Accuracy is the mean over runs, spread = max - min. Masked text for every hosted provider.

## chat

| provider / model | tier | runs | accuracy (mean, min-max) | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ollama / qwen2.5:7b | local | 3 | 61.0% (60.0%-62.9%) | en-untuned: 17/28 / 16/28 / 16/28; en-bank(tuned): 3/5 / 3/5 / 3/5; ru-bank(tuned): 2/2 / 2/2 / 2/2 | 2629 | 0.0% | 0.0% | 0 | 0 | 0 | – |
| ollama / qwen2.5:7b [first20] | local | 3 | 60.0% (55.0%-65.0%) | en-untuned: 11/20 / 12/20 / 13/20 | 1840 | 0.0% | 0.0% | 0 | 0 | 0 | – |
| deploy / zai-org/glm-5.3-flash | B | 3 | 57.1% (57.1%-57.1%) | en-untuned: 14/28 / 14/28 / 14/28; en-bank(tuned): 4/5 / 4/5 / 4/5; ru-bank(tuned): 2/2 / 2/2 / 2/2 | 4210 | 0.0% | 0.0% | 2 | 0 | 108425 | – |
| deploy / deepseek-ai/deepseek-v4.1-flash-1017 | B | 3 | 54.3% (51.4%-57.1%) | en-untuned: 13/28 / 14/28 / 15/28; en-bank(tuned): 3/5 / 3/5 / 3/5; ru-bank(tuned): 2/2 / 2/2 / 2/2 | 7162 | 0.0% | 0.0% | 6 | 0 | 90789 | – |
| groq / openai/gpt-oss-20b [slow-1024] | A | 3 | 51.7% (50.0%-55.0%) | en-untuned: 11/20 / 10/20 / 10/20 | 1819 | 1.7% | 0.0% | 2 | 0 | 58002 | 639 |
| groq / openai/gpt-oss-20b [slow] | A | 3 | 50.0% (50.0%-50.0%) | en-untuned: 10/20 / 10/20 / 10/20 | 3116 | 0.0% | 0.0% | 0 | 0 | 57802 | 789 |
| groq / openai/gpt-oss-120b | A | 3 | 43.8% (42.9%-45.7%) | en-untuned: 12/28 / 11/28 / 11/28; en-bank(tuned): 2/5 / 2/5 / 2/5; ru-bank(tuned): 2/2 / 2/2 / 2/2 | 2079 | 0.0% | 0.0% | 15 | 1 | 78249 | 824 |
| groq / openai/gpt-oss-120b [slow] | A | 3 | 43.3% (40.0%-45.0%) | en-untuned: 9/20 / 9/20 / 8/20 | 2319 | 5.5% | 0.0% | 7 | 0 | 51254 | 700 |
| groq / openai/gpt-oss-120b [slow-1024] | A | 3 | 43.3% (40.0%-45.0%) | en-untuned: 9/20 / 9/20 / 8/20 | 1604 | 0.0% | 0.0% | 0 | 0 | 55650 | 549 |
| groq / openai/gpt-oss-20b | A | 3 | 39.0% (31.4%-48.6%) | en-untuned: 13/28 / 9/28 / 8/28; en-bank(tuned): 2/5 / 2/5 / 2/5; ru-bank(tuned): 2/2 / 2/2 / 1/2 | 2403 | 0.0% | 0.0% | 27 | 19 | 74988 | 833 |
| groq / qwen/qwen3.8-27b [slow] | A | 3 | 28.3% (20.0%-35.0%) | en-untuned: 7/20 / 6/20 / 4/20 | 697 | 55.8% | 0.0% | 43 | 0 | 18407 | 879 |
| groq / qwen/qwen3.8-27b | A | 3 | 26.7% (22.9%-31.4%) | en-untuned: 6/28 / 8/28 / 5/28; en-bank(tuned): 2/5 / 2/5 / 2/5; ru-bank(tuned): 1/2 / 1/2 / 1/2 | 870 | 0.0% | 0.0% | 84 | 0 | 22142 | 898 |
| cerebras / gpt-oss-120b [slow] | A | 1 | 10.0% (10.0%-10.0%) | en-untuned: 2/20 | 1734 | 0.0% | 0.0% | 13 | 12 | 8440 | – |
| cerebras / gpt-oss-120b | A | 1 | 8.6% (8.6%-8.6%) | en-untuned: 0/28; en-bank(tuned): 2/5; ru-bank(tuned): 1/2 | 4861 | 2.7% | 0.0% | 32 | 31 | 2328 | – |
| gemini / gemini-3.5-flash-lite | B | 2 | 0.0% (0.0%-0.0%) | en-untuned: 0/20 / 0/20 | 8666 | 0.0% | 0.0% | 40 | 0 | 0 | – |
| openrouter / google/gemma-4-26b-a4b-it:free | B | 1 | 0.0% (0.0%-0.0%) | en-untuned: 0/10 | 4888 | 0.0% | 0.0% | 10 | 10 | 442 | – |

Order: ollama/qwen2.5:7b → deploy/zai-org/glm-5.3-flash → groq/openai/gpt-oss-20b → deploy/deepseek-ai/deepseek-v4.1-flash-1017 → groq/openai/gpt-oss-120b → cerebras/gpt-oss-120b
Ties: groq/openai/gpt-oss-20b = deploy/deepseek-ai/deepseek-v4.1-flash-1017
Excluded: groq/qwen/qwen3.8-27b (invalid JSON 55.8%); gemini/gemini-3.5-flash-lite (failed / no correct answers); openrouter/google/gemma-4-26b-a4b-it:free (failed / no correct answers)

## docs

| provider / model | tier | runs | accuracy (mean, min-max) | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ollama / qwen2.5:7b | local | 3 | 36.2% (35.9%-36.6%) | single: 51/71 / 52/71 / 51/71; long: 0/71 / 0/71 / 0/71 | 48214 | 4.0% | 0.0% | 1 | 0 | 0 | – | precision 96.2% (51/53)
| groq / openai/gpt-oss-120b | A | 3 | 25.1% (21.8%-29.6%) | single: 42/71 / 31/71 / 34/71; long: 0/71 / 0/71 / 0/71 | 3830 | 1.0% | 0.0% | 15 | 12 | 51518 | 759 | precision 95.5% (42/44)
| deploy / zai-org/glm-5.3-flash | B | 3 | 22.8% (19.0%-25.4%) | single: 27/71 / 36/71 / 34/71; long: 0/71 / 0/71 / 0/71 | 8001 | 0.0% | 0.0% | 13 | 0 | 61613 | – | precision 75.0% (27/36)
| deploy / deepseek-ai/deepseek-v4.1-flash-1017 | B | 3 | 22.3% (18.3%-25.4%) | single: 26/71 / 33/71 / 36/71; long: 0/71 / 0/71 / 0/71 | 8004 | 0.0% | 0.0% | 37 | 0 | 39838 | – | precision 96.3% (26/27)
| groq / openai/gpt-oss-120b [slow] | A | 3 | 18.6% (17.4%-20.0%) | single: 23/44 / 20/44 / 21/44; long: 0/71 / 0/71 / 0/71 | 2491 | 5.0% | 0.0% | 3 | 0 | 35039 | 642 | precision 88.5% (23/26)
| openrouter / thinkingmachines/inkling:free | B | 1 | 0.0% (0.0%-0.0%) | single: 0/14; long: 0/71 | 870 | 0.0% | 0.0% | 8 | 0 | 0 | – | precision 100.0% (0/0)

Order: deploy/zai-org/glm-5.3-flash → deploy/deepseek-ai/deepseek-v4.1-flash-1017
Ties: deploy/zai-org/glm-5.3-flash = deploy/deepseek-ai/deepseek-v4.1-flash-1017
Excluded: ollama/qwen2.5:7b (invalid JSON 4.0%); groq/openai/gpt-oss-120b (invalid JSON 5.0%); openrouter/thinkingmachines/inkling:free (failed / no correct answers)

## vision

| provider / model | tier | runs | accuracy (mean, min-max) | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini / gemini-3.5-flash-lite | B | 3 | 0.0% (0.0%-0.0%) |  | 8013 | 0.0% | 0.0% | 16 | 0 | 0 | – | synthetic images only
| gemini / gemini-3.8-flash | B | 3 | 0.0% (0.0%-0.0%) |  | 8005 | 0.0% | 0.0% | 16 | 4 | 0 | – | synthetic images only
| openrouter / google/gemma-4-26b-a4b-it:free | B | 1 | 0.0% (0.0%-0.0%) |  | 1244 | 0.0% | 0.0% | 5 | 5 | 0 | – | synthetic images only

Order: (none)
Ties: none
Excluded: gemini/gemini-3.5-flash-lite (failed / no correct answers); gemini/gemini-3.8-flash (failed / no correct answers); openrouter/google/gemma-4-26b-a4b-it:free (failed / no correct answers)

## embed

| provider / model | tier | runs | accuracy (mean, min-max) | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini / gemini-embedding-2 | B | 1 | 61.8% (61.8%-61.8%) | en: 125/201; ru: 35/58 | 150117 | 0.0% | 0.0% | 2 | 0 | 0 | – | masked bank text
| openrouter / nvidia/nemotron-3.5-embed-8b:free | B | 1 | 59.5% (59.5%-59.5%) | en: 115/201; ru: 39/58 | 9477 | 0.0% | 0.0% | 0 | 0 | 0 | – | masked bank text
| ollama / nomic-embed-text | local | 1 | 45.2% (45.2%-45.2%) | en: 98/201; ru: 19/58 | 3384 | 0.0% | 0.0% | 0 | 0 | 0 | – | local (nomic-embed-text), unmasked
| hash / bag-of-words | local | 1 | 39.8% (39.8%-39.8%) | en: 86/201; ru: 17/58 | 30 | 0.0% | 0.0% | 0 | 0 | 0 | – | local hashed vectors
