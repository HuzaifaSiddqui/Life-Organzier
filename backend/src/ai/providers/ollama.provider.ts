import { Priority } from "@prisma/client";
import { z } from "zod";
import { buildTaskExtractionPrompt } from "../taskExtractionPrompt.js";
import type { SemanticTaskExtraction, TaskUnderstandingProvider } from "./provider.interface.js";

const responseSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  priority: z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
});

function extractJsonObject(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Ollama returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizePriority(value: string | undefined): Priority {
  const normalized = (value ?? "MEDIUM").toUpperCase();
  return Object.values(Priority).includes(normalized as Priority)
    ? (normalized as Priority)
    : Priority.MEDIUM;
}

export class OllamaProvider implements TaskUnderstandingProvider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    private readonly model = process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    private readonly timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30000),
  ) {}

  async extractTask(input: string): Promise<SemanticTaskExtraction | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt: buildTaskExtractionPrompt(input),
          stream: false,
          format: "json",
          options: { temperature: 0.1 },
        }),
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);

      const body = (await response.json()) as { response?: string };
      const parsed = responseSchema.parse(extractJsonObject(body.response ?? ""));
      return {
        title: parsed.title.trim(),
        description: parsed.description?.trim() || null,
        category: parsed.category?.trim() || null,
        priority: normalizePriority(parsed.priority),
        confidence: Math.round(parsed.confidence ?? 0),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}