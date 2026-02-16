/**
 * handleDigestButtonAction — processes "Acted on", "Snooze", "Dismiss" button taps
 * from digest Block Kit messages via POST /slack/interactions.
 */

import { AnalyticsRepository } from "./analytics-repository";
import { buildStatusText, replaceActionsWithStatus, type DigestBlock } from "./digest-service";
import { DigestDeliveryRepository } from "./digest-delivery-repository";
import { logError, logInfo, logWarn } from "./logging";
import { SlackClient } from "./slack-client";
import { ThoughtRepository } from "./thought-repository";
import type { Env } from "./types";

const ACTION_TO_STATUS: Record<string, "acted_on" | "snoozed" | "dismissed"> = {
  thought_acted_on: "acted_on",
  thought_snooze: "snoozed",
  thought_dismiss: "dismissed",
};

const ACTION_TO_ANALYTICS_EVENT: Record<string, string> = {
  thought_acted_on: "digest.item.acted_on",
  thought_snooze: "digest.item.snoozed",
  thought_dismiss: "digest.item.dismissed",
};

const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GENERIC_INTERACTION_ERROR = "Something went wrong. Please try again.";

export interface DigestButtonActionResult {
  ok: boolean;
  userMessage?: string;
}

export interface SlackBlockAction {
  action_id: string;
  block_id: string;
  value: string;
}

export interface SlackInteractionPayload {
  type: string;
  user: { id: string };
  actions: SlackBlockAction[];
  response_url?: string;
  message?: {
    ts: string;
    blocks?: DigestBlock[];
  };
  channel?: { id: string };
  container?: { channel_id: string; message_ts: string };
}

export async function handleDigestButtonAction(
  payload: SlackInteractionPayload,
  env: Env
): Promise<DigestButtonActionResult> {
  const thoughtRepository = new ThoughtRepository();
  const analyticsRepository = new AnalyticsRepository();
  const digestDeliveryRepository = new DigestDeliveryRepository();

  const userId = payload.user.id;
  const action = payload.actions?.[0];
  if (!action) {
    logWarn("digest.button_no_action", { user_id: userId });
    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }

  const status = ACTION_TO_STATUS[action.action_id];
  if (!status) {
    logWarn("digest.button_unknown_action", {
      user_id: userId,
      action_id: action.action_id,
    });
    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }

  const thoughtId = action.value;
  if (!thoughtId) {
    logWarn("digest.button_no_thought_id", {
      user_id: userId,
      action_id: action.action_id,
    });
    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }

  const thought = await thoughtRepository.findById(env.DB, thoughtId);
  if (!thought) {
    logWarn("digest.button_thought_not_found", {
      user_id: userId,
      thought_id: thoughtId,
    });
    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }

  // Verify the interacting user owns this thought
  if (thought.slack_user_id !== userId) {
    logWarn("digest.button_user_mismatch", {
      user_id: userId,
      thought_owner: thought.slack_user_id,
      thought_id: thoughtId,
    });
    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }

  // Compute snooze_until for snooze action
  let snoozeUntil: string | undefined;
  if (status === "snoozed") {
    snoozeUntil = new Date(Date.now() + SNOOZE_DURATION_MS).toISOString();
  }

  // Update thought status in D1 (terminal state guard is in repository)
  const updated = await thoughtRepository.updateStatus(
    env.DB,
    thoughtId,
    status,
    snoozeUntil
  );

  const channelId =
    payload.channel?.id ?? payload.container?.channel_id;
  const messageTs =
    payload.message?.ts ?? payload.container?.message_ts;

  // Log analytics event regardless of whether update succeeded (idempotent tap)
  try {
    await analyticsRepository.logEvent(
      env.DB,
      ACTION_TO_ANALYTICS_EVENT[action.action_id],
      userId,
      {
        thought_id: thoughtId,
        action: action.action_id,
      }
    );
  } catch (error) {
    logWarn("digest.button_analytics_failed", {
      thought_id: thoughtId,
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo("digest.button_tapped", {
    thought_id: thoughtId,
    user_id: userId,
    action: action.action_id,
    status,
    updated,
  });

  await logDigestEngagementIfFirstInteraction(
    analyticsRepository,
    digestDeliveryRepository,
    env,
    userId,
    thoughtId,
    action.action_id,
    messageTs
  );

  // Update the Slack message to replace buttons with status text
  if (channelId && messageTs && payload.message?.blocks) {
    const statusText = buildStatusText(status, snoozeUntil);
    const updatedBlocks = replaceActionsWithStatus(
      payload.message.blocks,
      thoughtId,
      statusText
    );

    const slackClient = new SlackClient(env.SLACK_BOT_TOKEN);
    try {
      await slackClient.updateMessage({
        channel: channelId,
        ts: messageTs,
        blocks: updatedBlocks,
        text: "Digest updated",
      });
    } catch (error) {
      logError("digest.button_message_update_failed", error, {
        thought_id: thoughtId,
        user_id: userId,
        channel_id: channelId,
        message_ts: messageTs,
      });
    }
  }

  return { ok: true };
}

async function logDigestEngagementIfFirstInteraction(
  analyticsRepository: AnalyticsRepository,
  digestDeliveryRepository: DigestDeliveryRepository,
  env: Env,
  userId: string,
  thoughtId: string,
  actionId: string,
  messageTs: string | undefined
): Promise<void> {
  if (!messageTs) {
    return;
  }

  try {
    const alreadyTracked = await analyticsRepository.hasDigestEngagementForMessage(
      env.DB,
      userId,
      messageTs
    );
    if (alreadyTracked) {
      return;
    }

    const delivery = await digestDeliveryRepository.findBySlackMessageTs(
      env.DB,
      userId,
      messageTs
    );
    if (!delivery) {
      logWarn("digest.engagement_delivery_missing", {
        user_id: userId,
        thought_id: thoughtId,
        digest_message_ts: messageTs,
      });
      return;
    }

    const deliveredAtMs = new Date(delivery.delivered_at).getTime();
    const timeToFirstInteractionMs = Number.isNaN(deliveredAtMs)
      ? 0
      : Math.max(0, Date.now() - deliveredAtMs);

    await analyticsRepository.logEvent(env.DB, "digest.engagement", userId, {
      delivery_id: delivery.id,
      digest_message_ts: messageTs,
      period_start: delivery.period_start,
      period_end: delivery.period_end,
      time_to_first_interaction_ms: timeToFirstInteractionMs,
      first_action: actionId,
    });
  } catch (error) {
    logWarn("digest.engagement_analytics_failed", {
      user_id: userId,
      thought_id: thoughtId,
      digest_message_ts: messageTs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
