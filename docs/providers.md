# Hosted LLM providers

Ollama (local) stays the default. Hosted providers are used only when a job's chain is configured
(`LLM_PROVIDERS_CHAT`, `LLM_PROVIDERS_DOCS`, `LLM_PROVIDERS_VISION`; see `docs/rollout.md`), in the order of the
`chains` in `backend/config/provider-order.json`.

## Decisions (29 Oct 2026)

- **Cloud fallback only with `CLOUD_FALLBACK=on` (default off).** Chat chain: Ollama → Deploy GLM with few-shot
  (tier B, masked) → Groq gpt-oss-20b → rules; documents: Ollama → Groq gpt-oss-120b. Masking does not remove what a
  message is about; the trade-off is spelled out in `docs/rollout.md` → Cloud fallback.
- Few-shot is a per-provider setting (`fewShot` in `config/provider-order.json`): on for Deploy GLM, off for Ollama.

- **Ollama `qwen2.5:7b` stays the primary and the reference** for chat and documents.
- Fallback chains (used only when the env names them): **chat** = Ollama → Groq `openai/gpt-oss-20b` (tier A) →
  Deploy `zai-org/glm-5.3-flash` (tier B, masked text only, never leads); **documents** = Ollama → Groq
  `openai/gpt-oss-120b`.
- **No tier B embeddings**: `nomic-embed-text` with the hashed fallback stays (revisit with Bedrock embeddings).
  **No hosted vision**: `DOC_VISION` stays off.
- No more providers. Cerebras, Gemini and OpenRouter stay benchmarked and documented only; Together is skipped until a
  new key is confirmed (the configured one returns HTTP 401).
- English only until after the FYP evaluation (10 Nov 2026): benchmarks skip Roman Urdu and Urdu. Static facts (endpoints, key variable names, tiers, limits) are in
`backend/config/providers.json`; candidate models in `backend/config/provider-candidates.json` (from the live model
lists, `npx tsx scripts/list-models.ts`). Checked **28 Oct 2026**.

## Privacy tiers

- **Tier A**: the provider's own terms say inputs/outputs are not used for training, and data stays in an acceptable
  jurisdiction (the US with standard terms counts here).
- **Tier B**: may train, unclear, or not verified.
- **Rules (enforced in `backend/src/ai/chains.ts`)**: every non-Ollama provider receives masked text only
  (`maskForProvider`: CNIC/phone numbers, other 5+ digit runs, e-mails, links, names after a cue such as "call",
  "with", "Dr", "bhai"). Tier B never receives images and never leads a chain unless named in
  `LLM_TIER_B_LEAD_APPROVED` (your written approval). Logs: provider, model, latency, status, token counts only.

| Provider | Tier | Evidence (official pages) |
|---|---|---|
| Ollama | local | Runs on this machine. |
| Groq | **A** | Services Agreement §4.2: "Groq is not permitted to use Inputs or Outputs for training or fine-tuning any AI Model Services or other models" unless the customer allows it ([services agreement](https://console.groq.com/docs/legal/services-agreement), last modified 22 Jun 2026). "By default, Groq does not retain customer data for inference requests"; logs up to 30 days for abuse/troubleshooting, ZDR available; "All customer data is retained in Google Cloud Platform (GCP) buckets located in the United States" ([your data](https://console.groq.com/docs/your-data)). |
| Cerebras | **A** | "the foregoing does not grant Cerebras the right to use Service Content for the purpose of training or fine-tuning models" ([terms](https://www.cerebras.ai/terms-of-service), 27 Aug 2024). "We do not retain inputs and outputs associated with our training, inference and chatbot Services"; data "may be stored and processed in the United States and other countries" ([privacy](https://www.cerebras.ai/privacy-policy)). |
| Together | A (on paper) | "We do not use any data collected from you to train our models without your explicit opt-in and consent" ([privacy](https://www.together.ai/privacy), 17 Dec 2025). **The configured key is rejected (HTTP 401)**, so Together is not usable. |
| Gemini (free tier) | **B** | Unpaid services: "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop" its products; "human reviewers may read, annotate, and process your API input and output" ([Gemini API terms](https://ai.google.dev/gemini-api/terms), 28 Apr 2026). Storage location not stated for unpaid use. |
| OpenRouter `:free` | **B** | Each upstream provider has its own policy; "Wherever possible, OpenRouter works with providers to ensure that prompts will not be trained on, but there are exceptions"; "There are separate settings for paid and free models" ([provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)). Free tier, 50 free-model requests a day, data regions "global" (GET /api/v1/key). |
| Deploy (deploy.com) | **B** | Castle Global, Inc. (dba Deploy), San Francisco. The [privacy policy](https://deploy.com/privacy) (23 Oct 2026) does not mention API prompts, model training or model providers; information "may be processed and stored in the United States or other countries". |
| AWS Bedrock | – | Disabled; not verified (no AWS access). |

### Not verified

- **OpenRouter account setting**: whether your account allows free-model providers that train on prompts is a
  setting on openrouter.ai (Settings → Privacy) that the API does not show. Until you confirm it is off, tier B.
- **Which upstream provider serves each `:free` model** and its retention: OpenRouter lists it per model page; not
  checked per request.
- **Groq Data Processing Addendum** and **Cerebras Data Processing Agreement**: referenced by their terms, not read
  (the public terms above already state no training).
- **Deploy**: no statement about prompts, training or sub-processors; whether it bills (no balance endpoint found).
- **Gemini free-tier billing**: the key works on the free tier; whether the Google Cloud project has billing enabled
  is not visible through the API. With billing enabled, paid terms (no training) would apply, but charges could too.
- **Bedrock**: everything (see `backend/scripts/test-bedrock.ts`).

## Masking: the provider mode

The unknown-message log masks every capitalised word that is not the first ("log" mode). For providers that would turn
"Operating Systems" and "KFC Gulberg" into "[name] [name]" and make documents unreadable, so providers get the
"provider" mode (names only after a cue). `LLM_MASK_NAMES=capitalised` switches providers to the log mode.

## Limits and spend

- Spend cap **$0** for every provider: free tiers only. An HTTP 402 or any reported cost turns the provider off for
  the rest of the day (falls through to the next). OpenRouter: only model ids ending in `:free`; 20 requests a minute,
  50 a day (free tier; read from GET /api/v1/key). `BEDROCK_DAILY_BUDGET_USD` (default 0) for when Bedrock is enabled.
- Per call 8 s (Ollama: what is left of the 15 s budget), one retry on network errors, breaker: 3 failures → 60 s off
  → one probe. `/health/ai` shows each provider's state (up / down / rate_limited / billing_blocked) and requests today,
  never keys.

## Embeddings without Ollama

`nomic-embed-text` runs in Ollama. Without Ollama, the app uses the hashed bag-of-words fallback (no dependency, works
offline, weaker: it only sees shared words). Hosted options, masked text only, measured by the benchmark: OpenRouter
`nvidia/nemotron-3.5-embed-8b:free` (59.5%) and Gemini `gemini-embedding-2` (61.8%, one run) beat both
`nomic-embed-text` (45.2%) and the hashed fallback (39.8%) on 28 Oct, but both are tier B: **not used** (decision,
29 Oct). Revisit with Bedrock embeddings once AWS access exists.

## Benchmark and scoring (`npx tsx scripts/bench-providers.ts`)

Same formula for every provider and job (`--rank`):

1. **Hard filters**: invalid-JSON rate ≤ 2%; some correct answers; on chat, every ranked entry scored the same
   messages. Ollama `qwen2.5:7b` is the reference: it is never dropped, and a filter it fails is shown as a flag.
   Tier rules (tier B never leads without approval, never gets images) are applied by `ai/chains.ts` on top.
2. **Accuracy**: mean over runs, with two measures of uncertainty: the run-to-run spread (max − min) and a **95%
   bootstrap interval over items** (each message or expected date scored as its mean over the runs, 2000 resamples,
   fixed seed; `scripts/bootstrap.ts`). In mean order, an entry whose interval overlaps any entry of the current group
   joins that group: **tied**. Only non-overlapping intervals rank.
3. **Ties** are broken by privacy tier (local, then A, then B), then p95 latency, then availability (failures + 429s).

A run in which more than half the calls were refused with HTTP 429 measured the free tier's quota, not the model:
it is listed under "Quota-bound runs" and not ranked.

Ranked: the **normal pass** (production pacing, 8 s per call) and the **few-shot condition** (`--fewshot`: the 5
nearest English bank rows from the app's own kNN, leave-one-out). Slow, retry and diagnostic passes are reported only.
`--rank` writes `docs/baselines/providers-<date>.md` and the `ranking` part of `backend/config/provider-order.json`;
it never changes the `chains`.
