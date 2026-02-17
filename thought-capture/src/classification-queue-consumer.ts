import { AnalyticsRepository } from "./analytics-repository";
import {
  ClassificationService,
  type ClassificationResult,
} from "./classification-service";
import {
  type Classification,
  toClassificationLabel,
} from "./classification";
import { logError, logInfo, logWarn } from "./logging";
import { SlackClient } from "./slack-client";
import { ThoughtRepository } from "./thought-repository";
import type { ClassificationMessage, Env } from "./types";

export interface ClassificationQueueDependencies {
  thoughtRepository: ThoughtRepository;
  analyticsRepository: AnalyticsRepository;
  createClassificationService: (apiKey: string) => ClassificationService;
  createSlackClient: (token: string) => SlackClient;
}

export function createClassificationQueueDependencies(): ClassificationQueueDependencies {
  return {
    thoughtRepository: new ThoughtRepository(),
    analyticsRepository: new AnalyticsRepository(),
    createClassificationService: (apiKey: string) =>
      new ClassificationService(apiKey),
    createSlackClient: (token: string) => new SlackClient(token),
  };
}

export async function handleClassificationBatch(
  batch: MessageBatch<ClassificationMessage>,
  env: Env,
  deps: ClassificationQueueDependencies = createClassificationQueueDependencies()
): Promise<void> {
  const classificationService = deps.createClassificationService(
    env.OPENAI_API_KEY
  );
  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);

  for (const message of batch.messages) {
    try {
      await classifyThoughtMessage(
        message.body,
        env,
        deps,
        classificationService,
        slackClient
      );
      message.ack();
    } catch (error) {
      logError("thought.classification_failed", error, {
        thought_id: message.body.thoughtId,
        user_id: message.body.userId,
      });
      message.retry();
    }
  }
}

async function classifyThoughtMessage(
  payload: ClassificationMessage,
  env: Env,
  deps: ClassificationQueueDependencies,
  classificationService: ClassificationService,
  slackClient: SlackClient
): Promise<void> {
  const thought = await deps.thoughtRepository.findById(env.DB, payload.thoughtId);
  if (!thought) {
    logWarn("thought.classification_missing", {
      thought_id: payload.thoughtId,
      user_id: payload.userId,
    });
    return;
  }

  if (!thought.text) {
    logWarn("thought.classification_text_missing", {
      thought_id: payload.thoughtId,
      user_id: payload.userId,
    });
    return;
  }

  if (thought.classification !== "unclassified") {
    logInfo("thought.classification_already_set", {
      thought_id: payload.thoughtId,
      user_id: payload.userId,
      classification: thought.classification,
    });
    return;
  }

  const classificationResult = await classificationService.classify(thought.text);
  if (classificationResult.usedFallback) {
    logWarn("thought.classification_fallback", {
      thought_id: thought.id,
      user_id: payload.userId,
    });
  }

  const latencyMs = Math.max(
    0,
    Date.now() - new Date(thought.created_at).getTime()
  );
  const updated = await deps.thoughtRepository.updateClassification(
    env.DB,
    thought.id,
    classificationResult.classification,
    "llm",
    classificationResult.model,
    latencyMs
  );

  if (!updated) {
    return;
  }

  const conversation = await slackClient.openConversation({ users: payload.userId });
  const channel = conversation.channel?.id;
  if (!channel) {
    throw new Error(`Failed to open Slack conversation for user ${payload.userId}`);
  }

  const reply = await slackClient.postMessage({
    channel,
    text: buildClassificationReply(classificationResult),
  });

  if (reply.ts) {
    await deps.thoughtRepository.updateBotReplyTs(env.DB, thought.id, reply.ts);
  }

  try {
    await deps.analyticsRepository.logEvent(
      env.DB,
      "thought.classified",
      payload.userId,
      {
        thought_id: thought.id,
        category: classificationResult.classification,
        classification: classificationResult.classification,
        latency_ms: latencyMs,
        model_version: classificationResult.model,
        model: classificationResult.model,
      }
    );
  } catch (error) {
    logWarn("thought.classification_analytics_failed", {
      thought_id: thought.id,
      user_id: payload.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo("thought.classified", {
    thought_id: thought.id,
    user_id: payload.userId,
    classification: classificationResult.classification,
    latency_ms: latencyMs,
    model: classificationResult.model,
  });
}

function buildClassificationReply(result: ClassificationResult): string {
  const alternatives = getAlternativeOverrides(result.classification);
  return `Got it - classified as ${toClassificationLabel(result.classification)}\n\nReply "reclassify as ${alternatives[0]}" or "reclassify as ${alternatives[1]}" to change.`;
}

function getAlternativeOverrides(
  classification: Classification
): [string, string] {
  switch (classification) {
    case "action_required":
      return ["reference", "noise"];
    case "reference":
      return ["action", "noise"];
    case "noise":
      return ["action", "reference"];
  }
}
