# Provider benchmark 2026-10-29

Raw: `providers-2026-10-29.json`. English only. Accuracy = mean over runs; spread = max - min over runs; 95% CI = bootstrap over items (messages or expected dates, 2000 resamples, fixed seed). Masked text for every hosted provider. Ranked: normal pass and the few-shot condition; other passes are reported only.

## chat

| entry | tier | runs | n | accuracy (mean, min-max) | 95% CI | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ollama/qwen2.5:7b [fewshot] | local | 3 | 33 | 60.6% (60.6%-60.6%) | 45.5%-78.8% | en-untuned: 17/28 / 17/28 / 17/28; en-bank(tuned): 3/5 / 3/5 / 3/5 | 6264 | 0.0% | 0.0% | 0 | 0 | 0 | – | few-shot: nomic-embed-text
| deploy/zai-org/glm-5.3-flash [fewshot] | B | 3 | 33 | 57.6% (57.6%-57.6%) | 39.4%-75.8% | en-untuned: 15/28 / 15/28 / 15/28; en-bank(tuned): 4/5 / 4/5 / 4/5 | 4141 | 0.0% | 0.0% | 3 | 0 | 106337 | – | few-shot: nomic-embed-text
| ollama/qwen2.5:7b [clean-latency] | local | 1 | 33 | 57.6% (57.6%-57.6%) | 42.4%-75.8% | en-untuned: 16/28; en-bank(tuned): 3/5 | 5594 | 0.0% | 0.0% | 0 | 0 | 0 | – |
| ollama/qwen2.5:7b | local | 3 | 33 | 57.6% (54.5%-60.6%) | 41.4%-74.7% | en-untuned: 15/28 / 16/28 / 17/28; en-bank(tuned): 3/5 / 3/5 / 3/5 | 5594 | 0.0% | 0.0% | 0 | 0 | 0 | – | p95 from the clean-latency run (5594 ms; with other jobs on the machine: 6398 ms)
| ollama/qwen2.5:14b | local | 3 | 33 | 56.6% (54.5%-57.6%) | 39.4%-72.7% | en-untuned: 15/28 / 16/28 / 16/28; en-bank(tuned): 3/5 / 3/5 / 3/5 | 5781 | 0.0% | 0.0% | 2 | 0 | 0 | – |
| deploy/deepseek-ai/deepseek-v4.1-flash-1017 | B | 3 | 33 | 52.5% (48.5%-54.5%) | 35.4%-69.7% | en-untuned: 13/28 / 15/28 / 15/28; en-bank(tuned): 3/5 / 3/5 / 3/5 | 5136 | 0.0% | 0.0% | 6 | 0 | 87322 | – |
| groq/openai/gpt-oss-20b | A | 2 | 33 | 43.9% (36.4%-51.5%) | 28.8%-59.1% | en-untuned: 14/28 / 10/28; en-bank(tuned): 3/5 / 2/5 | 1719 | 0.8% | 0.0% | 8 | 6 | 55469 | 600 |
| deploy/zai-org/glm-5.3-flash | B | 3 | 33 | 42.4% (36.4%-45.5%) | 27.3%-57.6% | en-untuned: 11/28 / 11/28 / 10/28; en-bank(tuned): 4/5 / 4/5 / 2/5 | 8003 | 0.0% | 0.0% | 21 | 0 | 85572 | – |
| groq/openai/gpt-oss-120b | A | 2 | 33 | 34.8% (27.3%-42.4%) | 21.2%-50.0% | en-untuned: 12/28 / 7/28; en-bank(tuned): 2/5 / 2/5 | 1446 | 0.0% | 0.0% | 18 | 18 | 42852 | 567 |

Ranking (group = entries whose intervals overlap: tied):

1. [group 1] ollama/qwen2.5:7b: 57.6% (CI 41.4%-74.7%), tier local, p95 5594 ms
2. [group 1] ollama/qwen2.5:14b: 56.6% (CI 39.4%-72.7%), tier local, p95 5781 ms
3. [group 1] ollama/qwen2.5:7b [fewshot]: 60.6% (CI 45.5%-78.8%), tier local, p95 6264 ms
4. [group 1] groq/openai/gpt-oss-120b: 34.8% (CI 21.2%-50.0%), tier A, p95 1446 ms
5. [group 1] groq/openai/gpt-oss-20b: 43.9% (CI 28.8%-59.1%), tier A, p95 1719 ms
6. [group 1] deploy/zai-org/glm-5.3-flash [fewshot]: 57.6% (CI 39.4%-75.8%), tier B, p95 4141 ms
7. [group 1] deploy/deepseek-ai/deepseek-v4.1-flash-1017: 52.5% (CI 35.4%-69.7%), tier B, p95 5136 ms
8. [group 1] deploy/zai-org/glm-5.3-flash: 42.4% (CI 27.3%-57.6%), tier B, p95 8003 ms

Ties: ollama/qwen2.5:7b = ollama/qwen2.5:14b = ollama/qwen2.5:7b [fewshot] = groq/openai/gpt-oss-120b = groq/openai/gpt-oss-20b = deploy/zai-org/glm-5.3-flash [fewshot] = deploy/deepseek-ai/deepseek-v4.1-flash-1017 = deploy/zai-org/glm-5.3-flash (tie broken by tier, then p95, then failures + 429s)
Reference flags: none
Excluded: none

## docs

| entry | tier | runs | n | accuracy (mean, min-max) | 95% CI | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ollama/qwen2.5:7b | local | 3 | 67 | 76.1% (76.1%-76.1%) | 65.7%-85.1% | single: 51/67 / 51/67 / 51/67; long: 0/67 / 0/67 / 0/67 | 57149 | 3.2% | 0.0% | 2 | 0 | 0 | – | precision 96.2% (51/53)

Ranking (group = entries whose intervals overlap: tied):

1. [group 1] ollama/qwen2.5:7b: 76.1% (CI 65.7%-85.1%), tier local, p95 57149 ms

Ties: none
Reference flags: ollama/qwen2.5:7b: invalid JSON 3.2%
Excluded: none

## vision

| entry | tier | runs | n | accuracy (mean, min-max) | 95% CI | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

Ranking (group = entries whose intervals overlap: tied):


Ties: none
Reference flags: none
Excluded: none

## embed

| entry | tier | runs | n | accuracy (mean, min-max) | 95% CI | by set | p95 ms | invalid JSON | schema fail | failures | 429 | tokens | headroom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

Ranking (group = entries whose intervals overlap: tied):


Ties: none
Reference flags: none
Excluded: none

## Paired comparisons (chat, same messages)

Accuracy difference with a 95% paired bootstrap interval; an interval that excludes 0 is a real difference on this set.

| comparison | difference | 95% CI | verdict |
|---|---|---|---|
| 14b vs 7b | -1.0 pts | -16.2 to 14.1 | no clear difference |
| 7b few-shot vs 7b | +3.0 pts | -15.2 to 21.2 | no clear difference |
| GLM few-shot vs GLM | +15.2 pts | 7.1 to 24.2 | better |
| Groq 20b few-shot vs Groq 20b | – | – | not measured (no unthrottled runs) |
| Groq 20b vs Ollama 7b | -13.6 pts | -32.8 to 4.0 | no clear difference |
| GLM vs Ollama 7b | -15.2 pts | -34.3 to 4.0 | no clear difference |
| GLM few-shot vs Ollama 7b | +0.0 pts | -19.2 to 18.2 | no clear difference |
| DeepSeek vs Ollama 7b | -5.1 pts | -25.3 to 15.2 | no clear difference |

## Quota-bound runs (not ranked)

More than half the calls refused with HTTP 429 (free-tier tokens per minute or per day):

- groq/openai/gpt-oss-20b chat run 3: 24/47 calls 429
- groq/openai/gpt-oss-120b chat run 3: 33/33 calls 429
- groq/openai/gpt-oss-120b docs run 1: 30/31 calls 429
- groq/openai/gpt-oss-20b [fewshot] chat run 1: 32/35 calls 429
- groq/openai/gpt-oss-20b [fewshot] chat run 2: 33/33 calls 429
- groq/openai/gpt-oss-20b [fewshot] chat run 3: 33/33 calls 429
