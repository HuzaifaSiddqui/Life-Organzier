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
  if (start < 0 || end <= start) throw new Error("Gemini returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizePriority(value: string | undefined): Priority {
  const normalized = (value ?? "MEDIUM").toUpperCase();
  return Object.values(Priority).includes(normalized as Priority)
    ? (normalized as Priority)
    : Priority.MEDIUM;
}

export class GeminiProvider implements TaskUnderstandingProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY,
    private readonly model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    private readonly timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 15000),
  ) {}

  async extractTask(input: string): Promise<SemanticTaskExtraction | null> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        this.model,
      )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: buildTaskExtractionPrompt(input) }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                title: { type: "STRING" },
                description: { type: "STRING", nullable: true },
                category: { type: "STRING", nullable: true },
                priority: {
                  type: "STRING",
                  enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
                },
                confidence: { type: "INTEGER" },
              },
              required: ["title", "description", "category", "priority", "confidence"],
            },
            temperature: 0.1,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Gemini API error (HTTP ${response.status}): ${errText}`);
      }

      const body = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const rawText = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("Gemini returned empty response");

      const parsed = responseSchema.parse(extractJsonObject(rawText));
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