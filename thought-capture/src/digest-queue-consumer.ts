/**
 * Digest Delivery Queue Consumer — processes per-user digest delivery messages.
 *
 * Each message contains { userId, periodStart, periodEnd }.
 * The consumer:
 * 1. Re-checks delivery idempotency
 * 2. Queries action items from D1
 * 3. Opens a DM channel with the user
 * 4. Builds and sends the digest via DigestService
 * 5. Records the delivery in digest_deliveries
 * 6. Logs analytics event
 */

import { AnalyticsRepository } from "./analytics-repository";
import { DigestDeliveryRepository } from "./digest-delivery-repository";
import { buildDigestPayload } from "./digest-service";
import { logError, logInfo, logWarn } from "./logging";
import { SlackClient } from "./slack-client";
import { ThoughtRepository } from "./thought-repository";
import type { DigestDeliveryMessage, Env } from "./types";
import { UserPrefsRepository } from "./user-prefs-repository";

export interface DigestDeliveryDependencies {
  thoughtRepository: ThoughtRepository;
  analyticsRepository: AnalyticsRepository;
  digestDeliveryRepository: DigestDeliveryRepository;
  userPrefsRepository: UserPrefsRepository;
  createSlackClient: (token: string) => SlackClient;
}

export function createDigestDeliveryDependencies(): DigestDeliveryDependencies {
  return {
    thoughtRepository: new ThoughtRepository(),
    analyticsRepository: new AnalyticsRepository(),
    digestDeliveryRepository: new DigestDeliveryRepository(),
    userPrefsRepository: new UserPrefsRepository(),
    createSlackClient: (token: string) => new SlackClient(token),
  };
}

export async function handleDigestDeliveryBatch(
  batch: MessageBatch<DigestDeliveryMessage>,
  env: Env,
  deps: DigestDeliveryDependencies = createDigestDeliveryDependencies()
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await deliverDigest(message.body, env, deps);
      message.ack();
    } catch (error) {
      logError("digest.delivery_failed", error, {
        user_id: message.body.userId,
        period_start: message.body.periodStart,
      });
      message.retry();
    }
  }
}

async function deliverDigest(
  msg: DigestDeliveryMessage,
  env: Env,
  deps: DigestDeliveryDependencies
): Promise<void> {
  const { userId, periodStart, periodEnd } = msg;
  const now = new Date().toISOString();

  // Re-check delivery idempotency
  const existingDelivery = await deps.digestDeliveryRepository.hasDeliveryForPeriod(
    env.DB,
    userId,
    periodStart
  );

  if (existingDelivery) {
    logInfo("digest.delivery_duplicate_skipped", {
      user_id: userId,
      period_start: periodStart,
    });
    return;
  }

  // Query digest items
  const items = await deps.thoughtRepository.findDigestItems(
    env.DB,
    userId,
    periodStart,
    periodEnd,
    now
  );

  // Get classification counts for empty-week message
  const classificationCounts = await deps.thoughtRepository.countByClassification(
    env.DB,
    userId,
    periodStart,
    periodEnd
  );

  const userPrefs = await deps.userPrefsRepository.findByUserId(env.DB, userId);
  const userTimezone = userPrefs?.timezone ?? "UTC";

  // Build digest payload
  const digestPayload = buildDigestPayload(
    items,
    classificationCounts,
    userTimezone
  );

  // Open DM channel with user
  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);
  const conversationResult = await slackClient.openConversation({
    users: userId,
  });

  if (!conversationResult.channel?.id) {
    throw new Error(`Failed to open DM channel for user ${userId}`);
  }

  const channelId = conversationResult.channel.id;

  // Send digest message
  const sendResult = await slackClient.postMessage({
    channel: channelId,
    text: digestPayload.text,
    blocks: digestPayload.blocks,
  });

  // Count snoozed items for delivery record
  const snoozedItemCount = items.filter((t) => t.status === "snoozed").length;

  // Record delivery in digest_deliveries
  const deliveryId = crypto.randomUUID();
  const inserted = await deps.digestDeliveryRepository.insert(env.DB, {
    id: deliveryId,
    userId,
    deliveredAt: now,
    itemCount: items.length,
    snoozedItemCount,
    slackMessageTs: sendResult.ts ?? null,
    periodStart,
    periodEnd,
  });

  if (!inserted) {
    logWarn("digest.delivery_duplicate_after_send", {
      user_id: userId,
      period_start: periodStart,
      slack_message_ts: sendResult.ts,
    });
    return;
  }

  // Log analytics event (best effort to avoid duplicate digest retries)
  try {
    await deps.analyticsRepository.logEvent(env.DB, "digest.sent", userId, {
      delivery_id: deliveryId,
      item_count: items.length,
      snoozed_item_count: snoozedItemCount,
      period_start: periodStart,
      period_end: periodEnd,
      slack_message_ts: sendResult.ts,
    });
  } catch (error) {
    logWarn("digest.analytics_failed", {
      user_id: userId,
      delivery_id: deliveryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo("digest.sent", {
    user_id: userId,
    delivery_id: deliveryId,
    item_count: items.length,
    snoozed_item_count: snoozedItemCount,
    slack_message_ts: sendResult.ts,
  });
}
