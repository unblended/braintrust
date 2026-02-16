import OpenAI from "openai";

import { type Classification, isClassification } from "./classification";

const CLASSIFICATION_MODEL = "gpt-4o-mini";
const CLASSIFICATION_TIMEOUT_MS = 25_000;

const CLASSIFIER_SYSTEM_PROMPT = `You are a thought classifier for a staff engineer's personal capture system.
Classify the following thought into exactly one category.

Categories:
- action_required: The thought describes something the user should DO - write a doc,
  follow up with someone, investigate a problem, propose a change, file a bug, etc.
- reference: The thought is an observation, insight, or piece of information worth
  remembering but doesn't require immediate action - a pattern noticed, a fact learned,
  a link to revisit.
- noise: The thought is ephemeral, context-dependent, already resolved, or too vague
  to be useful later - "meeting went long," "ugh builds are slow today," "need coffee."

Respond with ONLY the category name (action_required, reference, or noise). Nothing else.`;

export interface ClassificationResult {
  classification: Classification;
  model: string;
  usedFallback: boolean;
}

export class ClassificationService {
  private client: OpenAI;

  constructor(apiKey: string, client?: OpenAI) {
    this.client =
      client ??
      new OpenAI({
        apiKey,
        maxRetries: 0,
        fetch: (...args) => fetch(...args),
      });
  }

  async classify(thoughtText: string): Promise<ClassificationResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLASSIFICATION_TIMEOUT_MS);

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: CLASSIFICATION_MODEL,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: CLASSIFIER_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: thoughtText,
            },
          ],
        },
        {
          signal: controller.signal,
        }
      );

      const responseText =
        completion.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
      if (isClassification(responseText)) {
        return {
          classification: responseText,
          model: completion.model ?? CLASSIFICATION_MODEL,
          usedFallback: false,
        };
      }

      return {
        classification: "action_required",
        model: completion.model ?? CLASSIFICATION_MODEL,
        usedFallback: true,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Classification timed out after ${CLASSIFICATION_TIMEOUT_MS}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "APIUserAbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("aborted");
}
