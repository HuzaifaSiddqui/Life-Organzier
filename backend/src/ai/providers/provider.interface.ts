import type { Priority } from "@prisma/client";

export type SemanticTaskExtraction = {
  title: string;
  description: string | null;
  category: string | null;
  priority: Priority;
  confidence: number;
};

export interface TaskUnderstandingProvider {
  readonly name: string;
  extractTask(input: string): Promise<SemanticTaskExtraction | null>;
}