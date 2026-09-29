import { GeminiProvider } from "./providers/gemini.provider.js";
import { OllamaProvider } from "./providers/ollama.provider.js";
import type { SemanticTaskExtraction, TaskUnderstandingProvider } from "./providers/provider.interface.js";

export class AiService {
  private readonly primaryProvider: TaskUnderstandingProvider | null;
  private readonly fallbackProvider: TaskUnderstandingProvider | null;

  constructor(provider?: TaskUnderstandingProvider) {
    if (provider) {
      this.primaryProvider = provider;
      this.fallbackProvider = null;
      return;
    }

    if (process.env.AI_ENABLED?.toLowerCase() === "false") {
      this.primaryProvider = null;
      this.fallbackProvider = null;
      return;
    }

    const providerName = (process.env.AI_PROVIDER ?? "ollama").toLowerCase();

    if (providerName === "gemini") {
      this.primaryProvider = new GeminiProvider();
      this.fallbackProvider = new OllamaProvider();
    } else if (providerName === "ollama") {
      this.primaryProvider = new OllamaProvider();
      this.fallbackProvider = null;
    } else {
      this.primaryProvider = null;
      this.fallbackProvider = null;
    }
  }

  async extractTask(input: string): Promise<SemanticTaskExtraction | null> {
    if (!this.primaryProvider) return null;

    try {
      const result = await this.primaryProvider.extractTask(input);
      if (result) return result;
    } catch (error) {
      console.warn(`Primary AI provider (${this.primaryProvider.name}) unavailable:`, error instanceof Error ? error.message : error);
    }

    if (this.fallbackProvider) {
      try {
        console.info(`Attempting fallback AI provider (${this.fallbackProvider.name})...`);
        const fallbackResult = await this.fallbackProvider.extractTask(input);
        if (fallbackResult) return fallbackResult;
      } catch (fallbackError) {
        console.warn(`Fallback AI provider (${this.fallbackProvider.name}) unavailable:`, fallbackError instanceof Error ? fallbackError.message : fallbackError);
      }
    }

    return null;
  }
}