import { jsonResponse } from "./health";
import {
  handleClassificationOverride,
  handleDirectMessage,
  handleReactionOverride,
  isClassificationOverrideText,
  runSafely,
  type SlackMessageEvent,
  type SlackReactionAddedEvent,
} from "./slack-event-handlers";
import type { Env } from "./types";

interface UrlVerificationPayload {
  type: "url_verification";
  challenge: string;
}

interface EventCallbackPayload {
  type: "event_callback";
  event: SlackMessageEvent | SlackReactionAddedEvent;
}

type SlackEventsPayload = UrlVerificationPayload | EventCallbackPayload;

export async function handleSlackEvents(
  rawBody: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let payload: SlackEventsPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventsPayload;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  if (isUrlVerificationPayload(payload)) {
    return jsonResponse({ challenge: payload.challenge });
  }

  const event = payload.event;

  if (isMessageImEvent(event)) {
    const isOverride =
      typeof event.text === "string" && isClassificationOverrideText(event.text);

    if (isOverride) {
      ctx.waitUntil(
        runSafely("thought.classification_override_failed", () =>
          handleClassificationOverride(event, env)
        )
      );
    } else {
      ctx.waitUntil(
        runSafely("thought.direct_message_failed", () =>
          handleDirectMessage(event, env)
        )
      );
    }

    return new Response("OK", { status: 200 });
  }

  if (isReactionAddedEvent(event)) {
    ctx.waitUntil(
      runSafely("thought.reaction_override_failed", () =>
        handleReactionOverride(event, env)
      )
    );
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}

function isUrlVerificationPayload(
  payload: SlackEventsPayload
): payload is UrlVerificationPayload {
  return payload.type === "url_verification";
}

function isMessageImEvent(
  event: SlackMessageEvent | SlackReactionAddedEvent
): event is SlackMessageEvent {
  return event.type === "message" && event.channel_type === "im";
}

function isReactionAddedEvent(
  event: SlackMessageEvent | SlackReactionAddedEvent
): event is SlackReactionAddedEvent {
  return event.type === "reaction_added";
}
