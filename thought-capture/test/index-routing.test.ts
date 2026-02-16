import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";

import worker from "../src/index";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv, createSignedSlackRequest } from "./helpers/slack";

describe("worker fetch routing", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves /health with aggregate D1 stats", async () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(
      `INSERT INTO thoughts (
        id,
        slack_user_id,
        slack_message_ts,
        text,
        classification,
        classification_source,
        status,
        created_at,
        classified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "health-thought-1",
        "U_HEALTH",
        "1708010000.000001",
        "health thought",
        "action_required",
        "llm",
        "open",
        twoDaysAgo,
        twoDaysAgo
      )
      .run();

    await insertAnalyticsEvent("ae-captured-1", "thought.captured", "U_HEALTH", twoDaysAgo);
    await insertAnalyticsEvent("ae-captured-2", "thought.captured", "U_OTHER", oneDayAgo);
    await insertAnalyticsEvent("ae-captured-old", "thought.captured", "U_OLD", fifteenDaysAgo);

    await insertAnalyticsEvent("ae-classified-1", "thought.classified", "U_HEALTH", twoDaysAgo);
    await insertAnalyticsEvent("ae-classified-2", "thought.classified", "U_HEALTH", oneDayAgo);
    await insertAnalyticsEvent("ae-override-1", "thought.override", "U_HEALTH", oneDayAgo);

    await insertAnalyticsEvent("ae-digest-sent-1", "digest.sent", "U_HEALTH", twoDaysAgo);
    await insertAnalyticsEvent("ae-digest-sent-2", "digest.sent", "U_HEALTH", oneDayAgo);
    await insertAnalyticsEvent("ae-digest-engagement-1", "digest.engagement", "U_HEALTH", oneDayAgo);

    const response = await worker.fetch(
      new Request("https://example.com/health", { method: "GET" }),
      buildTestEnv(),
      createExecutionContext()
    );

    const body = (await response.json()) as {
      status: string;
      timestamp: string;
      metrics: {
        total_thoughts: number;
        classifications: {
          action_required: number;
        };
        active_users_14d: number;
        override_rate_7d: number;
        digest_engagement_rate_7d: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toMatch(/Z$/);
    expect(body.metrics.total_thoughts).toBe(1);
    expect(body.metrics.classifications.action_required).toBe(1);
    expect(body.metrics.active_users_14d).toBe(2);
    expect(body.metrics.override_rate_7d).toBeCloseTo(0.5, 5);
    expect(body.metrics.digest_engagement_rate_7d).toBeCloseTo(0.5, 5);
  });

  it("handles Slack URL verification challenge", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });
    const request = await createSignedSlackRequest("/slack/events", body);

    const response = await worker.fetch(
      request,
      buildTestEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge: "challenge-token",
    });
  });

  it("rejects invalid signatures", async () => {
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature": "v0=invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
    });

    const response = await worker.fetch(
      request,
      buildTestEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(401);
  });

  it("rejects non-allowlisted users through feature flags", async () => {
    const sentMessages: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/chat.postMessage")) {
          const payload = JSON.parse(String(init?.body ?? "{}")) as {
            text?: string;
          };
          sentMessages.push(payload.text ?? "");
        }

        return new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1.1" }), {
          status: 200,
        });
      })
    );

    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        user: "U_BLOCKED",
        text: "this should be rejected",
        ts: "1708013000.000001",
        channel: "D_BLOCKED",
      },
    });

    const request = await createSignedSlackRequest("/slack/events", body);
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      request,
      buildTestEnv({ ENABLED_USER_IDS: "U_ENABLED" }),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sentMessages).toEqual([
      "Thought Capture is currently in private beta. You're not yet on the list - stay tuned!",
    ]);

    const thoughtsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM thoughts WHERE slack_user_id = ?`
    )
      .bind("U_BLOCKED")
      .first<{ count: number }>();

    expect(Number(thoughtsCount?.count ?? 0)).toBe(0);
  });
});

async function insertAnalyticsEvent(
  id: string,
  eventType: string,
  userId: string,
  createdAt: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analytics_events (id, event_type, slack_user_id, properties, created_at)
     VALUES (?, ?, ?, '{}', ?)`
  )
    .bind(id, eventType, userId, createdAt)
    .run();
}
