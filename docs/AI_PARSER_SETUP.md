# Hybrid AI Parser Setup

The Life Organizer parser uses a **multi-provider hybrid architecture**:
1. **Google Gemini API** (Cloud provider for evaluation/production).
2. **Ollama + Qwen 2.5:7b** (Local provider for daily development without using API limits).
3. **Deterministic Rule Parser** (Automatic offline fallback).

---

## 1. Development Mode (Ollama - Default)

To run locally without API keys:

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Pull the model:
   ```bash
   ollama pull qwen2.5:7b
   ```
3. Start the Ollama daemon:
   ```bash
   ollama serve
   ```
4. Set in `backend/.env`:
   ```env
   AI_ENABLED=true
   AI_PROVIDER=ollama
   OLLAMA_URL=http://127.0.0.1:11434
   OLLAMA_MODEL=qwen2.5:7b
   OLLAMA_TIMEOUT_MS=30000
   ```

---

## 2. Evaluation / Production Mode (Google Gemini API)

When you are ready for evaluation or cloud testing:

1. Set in `backend/.env`:
   ```env
   AI_ENABLED=true
   AI_PROVIDER=gemini
   GEMINI_API_KEY="your-gemini-api-key"
   GEMINI_MODEL=gemini-1.5-flash
   GEMINI_TIMEOUT_MS=15000
   ```
2. When `AI_PROVIDER=gemini` is active, if the Gemini API is unreachable or rate-limited, it automatically falls back to **Ollama** (if running), and then to the **Deterministic Rule Parser**.

---

## 3. Pure Offline / Rule Parser Mode

To run without any AI models:
```env
AI_ENABLED=true
AI_PROVIDER=rules
```
Or set `AI_ENABLED=false`. All date/time calculations, priority rules, and category detections will function deterministically.