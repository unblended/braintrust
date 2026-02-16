import { handleClassificationBatch } from "./classification-queue-consumer";
import { handleDigestDeliveryBatch } from "./digest-queue-consumer";
import { getHealthStatus, jsonResponse } from "./health";
import { logError, logWarn } from "./logging";
import { handleScheduleCommand } from "./schedule-command";
import { scheduleDigests, purgeExpiredThoughts, catchUpUnclassified } from "./scheduled-handlers";
import { handleSlackEvents } from "./slack-events-route";
import { handleSlackInteractions } from "./slack-interactions-handler";
import { SlackVerifier } from "./slack-verifier";
import type { Env, ClassificationMessage, DigestDeliveryMessage } from "./types";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return await getHealthStatus(env);
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (!url.pathname.startsWith("/slack/")) {
        return new Response("Not found", { status: 404 });
      }

      const body = await request.text();
      const verifier = new SlackVerifier(env.SLACK_SIGNING_SECRET);
      const isValidSignature = await verifier.verifyRequest(request.headers, body);
      if (!isValidSignature) {
        return jsonResponse({ error: "Invalid Slack signature" }, 401);
      }

      switch (url.pathname) {
        case "/slack/events":
          return handleSlackEvents(body, env, ctx);
        case "/slack/interactions":
          return handleSlackInteractions(body, env, ctx);
        case "/slack/commands":
          return handleScheduleCommand(body, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      logError("worker.fetch_error", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },

  async queue(
    batch: MessageBatch<ClassificationMessage | DigestDeliveryMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (batch.queue) {
      case "thought-classification":
        await handleClassificationBatch(
          batch as MessageBatch<ClassificationMessage>,
          env
        );
        break;
      case "digest-delivery":
        await handleDigestDeliveryBatch(
          batch as MessageBatch<DigestDeliveryMessage>,
          env
        );
        break;
      default:
        logWarn("queue.unknown", { queue: batch.queue });
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (event.cron) {
      case "*/15 * * * *":
        await scheduleDigests(env);
        break;
      case "0 3 * * *":
        await purgeExpiredThoughts(env);
        break;
      case "*/5 * * * *":
        await catchUpUnclassified(env);
        break;
      default:
        logWarn("cron.unknown", { cron: event.cron });
    }
  },
};

export type { Env, ClassificationMessage, DigestDeliveryMessage };
