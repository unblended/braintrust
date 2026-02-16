import { AnalyticsRepository } from "./analytics-repository";
import {
  type Classification,
  isClassification,
  toClassificationLabel,
} from "./classification";
import {
  checkUserAccess,
  getAccessRejectionMessage,
} from "./feature-flags";
import { logError, logInfo, logWarn } from "./logging";
import { SlackClient } from "./slack-client";
import { ThoughtRepository } from "./thought-repository";
import { fetchTimezone } from "./timezone-utils";
import type { Env } from "./types";
import { UserPrefsRepository, type UserPrefs } from "./user-prefs-repository";

const CLASSIFICATION_OVERRIDE_REGEX =
  /^reclassify\s+as\s+(action|reference|noise)$/i;

const REACTION_TO_CLASSIFICATION: Record<string, Classification> = {
  pushpin: "action_required",
  file_folder: "reference",
  wastebasket: "noise",
};

const MAX_THOUGHTS_PER_HOUR = 60;
const MAX_THOUGHT_LENGTH = 4000;
const MAX_OVERRIDES_PER_HOUR = 60;
const OVERRIDE_WINDOW_MS = 60 * 60 * 1000;
const OVERRIDE_RATE_LIMIT_MESSAGE =
  "You're reclassifying thoughts faster than I can keep up! Please wait a bit.";

export interface SlackEventHandlerDependencies {
  thoughtRepository: ThoughtRepository;
  userPrefsRepository: UserPrefsRepository;
  analyticsRepository: AnalyticsRepository;
  createSlackClient: (token: string) => SlackClient;
}

export function createSlackEventHandlerDependencies(): SlackEventHandlerDependencies {
  return {
    thoughtRepository: new ThoughtRepository(),
    userPrefsRepository: new UserPrefsRepository(),
    analyticsRepository: new AnalyticsRepository(),
    createSlackClient: (token: string) => new SlackClient(token),
  };
}

export interface SlackMessageEvent {
  type: "message";
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  channel: string;
  bot_id?: string;
  subtype?: string;
}

export interface SlackReactionAddedEvent {
  type: "reaction_added";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
}

export function isClassificationOverrideText(text: string): boolean {
  return CLASSIFICATION_OVERRIDE_REGEX.test(text.trim());
}

export async function handleDirectMessage(
  event: SlackMessageEvent,
  env: Env,
  deps: SlackEventHandlerDependencies = createSlackEventHandlerDependencies()
): Promise<void> {
  if (event.bot_id) {
    return;
  }

  const userId = event.user;
  if (!userId) {
    logWarn("thought.message_missing_user", { slack_message_ts: event.ts });
    return;
  }

  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);
  const access = checkUserAccess(env, userId);
  if (!access.allowed) {
    await slackClient.postMessage({
      channel: event.channel,
      text: getAccessRejectionMessage(access.reason!),
    });
    return;
  }

  if (!isPlainTextMessage(event)) {
    await slackClient.postMessage({
      channel: event.channel,
      text: "I can only capture text thoughts right now. Try typing it out!",
    });
    return;
  }

  const existing = await deps.thoughtRepository.findByMessageTs(env.DB, event.ts);
  if (existing) {
    return;
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const thoughtsLastHour = await deps.thoughtRepository.countByUserSince(
    env.DB,
    userId,
    oneHourAgo
  );
  if (thoughtsLastHour >= MAX_THOUGHTS_PER_HOUR) {
    await slackClient.postMessage({
      channel: event.channel,
      text: "You're capturing thoughts faster than I can keep up! Please wait a bit.",
    });
    return;
  }

  const prefs = await getOrCreateUserPrefs(env, slackClient, userId, deps);
  if (prefs.welcomed === 0) {
    await slackClient.postMessage({
      channel: event.channel,
      text: "Welcome to Thought Capture! Send me quick text thoughts anytime.",
      blocks: buildWelcomeBlocks(),
    });

    await deps.userPrefsRepository.upsert(env.DB, {
      slackUserId: userId,
      digestDay: prefs.digest_day,
      digestHour: prefs.digest_hour,
      digestMinute: prefs.digest_minute,
      timezone: prefs.timezone,
      welcomed: 1,
    });
  }

  let text = event.text!.trim();
  if (text.length > MAX_THOUGHT_LENGTH) {
    text = text.slice(0, MAX_THOUGHT_LENGTH);
    await slackClient.postMessage({
      channel: event.channel,
      text: "Your thought was a bit long - I captured the first 4,000 characters.",
    });
  }

  const inserted = await deps.thoughtRepository.insert(env.DB, {
    slackUserId: userId,
    slackMessageTs: event.ts,
    text,
  });

  if (!inserted) {
    return;
  }

  try {
    await slackClient.addReaction({
      channel: event.channel,
      timestamp: event.ts,
      name: "white_check_mark",
    });
  } catch (error) {
    logWarn("thought.checkmark_failed", {
      thought_id: inserted.id,
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await env.CLASSIFICATION_QUEUE.send({
    thoughtId: inserted.id,
    userId,
  });

  try {
    await deps.analyticsRepository.logEvent(env.DB, "thought.captured", userId, {
      thought_id: inserted.id,
      text_length: text.length,
    });
  } catch (error) {
    logWarn("thought.analytics_failed", {
      thought_id: inserted.id,
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo("thought.ingested", {
    thought_id: inserted.id,
    user_id: userId,
    text_length: text.length,
  });
}

export async function handleClassificationOverride(
  event: SlackMessageEvent,
  env: Env,
  deps: SlackEventHandlerDependencies = createSlackEventHandlerDependencies()
): Promise<void> {
  if (event.bot_id) {
    return;
  }

  const userId = event.user;
  if (!userId) {
    return;
  }

  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);
  const access = checkUserAccess(env, userId);
  if (!access.allowed) {
    await slackClient.postMessage({
      channel: event.channel,
      text: getAccessRejectionMessage(access.reason!),
    });
    return;
  }

  const targetClassification = parseClassificationOverride(event.text ?? "");
  if (!targetClassification) {
    return;
  }

  const thought = await deps.thoughtRepository.findMostRecentByUser(
    env.DB,
    userId,
    event.ts
  );
  if (!thought) {
    await slackClient.postMessage({
      channel: event.channel,
      text: "I couldn't find a recent thought to reclassify. Send a new thought first!",
    });
    return;
  }

  if (!isClassification(thought.classification)) {
    logWarn("thought.override_invalid_current", {
      thought_id: thought.id,
      user_id: userId,
      classification: thought.classification,
    });
    return;
  }

  const previousClassification = thought.classification;
  if (previousClassification === targetClassification) {
    await slackClient.postMessage({
      channel: event.channel,
      text: `Already classified as ${toClassificationLabel(targetClassification)} — no change needed.`,
    });
    return;
  }

  const rateLimit = await getOverrideRateLimitState(
    env,
    userId,
    deps.analyticsRepository
  );
  if (rateLimit.limited) {
    logWarn("thought.override_rate_limited", {
      user_id: userId,
      source: "text",
      overrides_last_hour: rateLimit.count,
      max_overrides_per_hour: MAX_OVERRIDES_PER_HOUR,
    });

    await slackClient.postMessage({
      channel: event.channel,
      text: OVERRIDE_RATE_LIMIT_MESSAGE,
    });
    return;
  }

  await deps.thoughtRepository.overrideClassification(
    env.DB,
    thought.id,
    targetClassification
  );

  await deps.analyticsRepository.logEvent(env.DB, "thought.override", userId, {
    thought_id: thought.id,
    from_category: previousClassification,
    to_category: targetClassification,
    source: "text",
  });

  logInfo("thought.overridden", {
    thought_id: thought.id,
    user_id: userId,
    from: previousClassification,
    to: targetClassification,
  });

  await slackClient.postMessage({
    channel: event.channel,
    text: `Updated! Reclassified as ${toClassificationLabel(targetClassification)} (was ${toClassificationLabel(previousClassification)}).`,
  });
}

export async function handleReactionOverride(
  event: SlackReactionAddedEvent,
  env: Env,
  deps: SlackEventHandlerDependencies = createSlackEventHandlerDependencies()
): Promise<void> {
  const userId = event.user;
  const itemTs = event.item?.ts;
  const channel = event.item?.channel;
  const reaction = event.reaction;

  if (!userId || !itemTs || !channel || !reaction) {
    return;
  }

  const targetClassification = REACTION_TO_CLASSIFICATION[reaction];
  if (!targetClassification) {
    return;
  }

  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);
  const access = checkUserAccess(env, userId);
  if (!access.allowed) {
    return;
  }

  const thoughtByReply = await deps.thoughtRepository.findByBotReplyTs(
    env.DB,
    itemTs
  );
  const thought =
    thoughtByReply ??
    (await deps.thoughtRepository.findByMessageTs(env.DB, itemTs));

  if (!thought) {
    return;
  }

  if (thought.slack_user_id !== userId) {
    return;
  }

  if (!isClassification(thought.classification)) {
    return;
  }

  const previousClassification = thought.classification;
  if (previousClassification === targetClassification) {
    return;
  }

  const rateLimit = await getOverrideRateLimitState(
    env,
    userId,
    deps.analyticsRepository
  );
  if (rateLimit.limited) {
    logWarn("thought.override_rate_limited", {
      user_id: userId,
      source: "emoji",
      overrides_last_hour: rateLimit.count,
      max_overrides_per_hour: MAX_OVERRIDES_PER_HOUR,
      reaction,
    });

    await slackClient.postMessage({
      channel,
      text: OVERRIDE_RATE_LIMIT_MESSAGE,
    });
    return;
  }

  await deps.thoughtRepository.overrideClassification(
    env.DB,
    thought.id,
    targetClassification
  );

  await deps.analyticsRepository.logEvent(env.DB, "thought.override", userId, {
    thought_id: thought.id,
    from_category: previousClassification,
    to_category: targetClassification,
    source: "emoji",
    reaction,
  });

  logInfo("thought.overridden", {
    thought_id: thought.id,
    user_id: userId,
    from: previousClassification,
    to: targetClassification,
    via: "emoji",
  });

  await slackClient.postMessage({
    channel,
    text: `Updated! Reclassified as ${toClassificationLabel(targetClassification)} (was ${toClassificationLabel(previousClassification)}).`,
  });
}

export async function runSafely(
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logError(label, error);
  }
}

function isPlainTextMessage(event: SlackMessageEvent): boolean {
  if (event.subtype) {
    return false;
  }

  return typeof event.text === "string" && event.text.trim().length > 0;
}

function parseClassificationOverride(text: string): Classification | null {
  const match = CLASSIFICATION_OVERRIDE_REGEX.exec(text.trim());
  if (!match) {
    return null;
  }

  const token = match[1].toLowerCase();
  if (token === "action") {
    return "action_required";
  }

  if (token === "reference") {
    return "reference";
  }

  if (token === "noise") {
    return "noise";
  }

  return null;
}

function buildWelcomeBlocks(): unknown[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Welcome to Thought Capture!" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "I help you capture fleeting thoughts and turn them into action. Here's how it works:",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Capture* — Send me a quick text DM anytime. I'll save it and classify it as Action Required, Reference, or Noise.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: '*Digest* — Each week, I\'ll send you a digest of your action items with buttons to act on, snooze, or dismiss each one.',
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: '*Override* — Reply "reclassify as action/reference/noise" or react with :pushpin: :file_folder: :wastebasket: to change a classification.',
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Schedule* — Use `/thoughtcapture schedule <day> <HH:MM>` to change when your digest arrives.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Go ahead — send me your first thought!_",
      },
    },
  ];
}

async function getOrCreateUserPrefs(
  env: Env,
  slackClient: SlackClient,
  userId: string,
  deps: SlackEventHandlerDependencies
): Promise<UserPrefs> {
  const existing = await deps.userPrefsRepository.findByUserId(env.DB, userId);
  if (existing) {
    return existing;
  }

  const timezone = await fetchTimezone(slackClient, userId);
  return deps.userPrefsRepository.upsert(env.DB, {
    slackUserId: userId,
    digestDay: 1,
    digestHour: 9,
    digestMinute: 0,
    timezone,
    welcomed: 0,
  });
}

async function getOverrideRateLimitState(
  env: Env,
  userId: string,
  analyticsRepository: AnalyticsRepository
): Promise<{ limited: boolean; count: number }> {
  const oneHourAgo = new Date(Date.now() - OVERRIDE_WINDOW_MS).toISOString();
  const count = await analyticsRepository.countEventsSince(
    env.DB,
    "thought.override",
    userId,
    oneHourAgo
  );

  return {
    limited: count >= MAX_OVERRIDES_PER_HOUR,
    count,
  };
}
