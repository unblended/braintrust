import { env } from "cloudflare:test";

import { handleDigestDeliveryBatch } from "../src/digest-queue-consumer";
import { AnalyticsRepository } from "../src/analytics-repository";
import { DigestDeliveryRepository } from "../src/digest-delivery-repository";
import { SlackClient } from "../src/slack-client";
import { ThoughtRepository } from "../src/thought-repository";
import type { DigestDeliveryMessage, Env } from "../src/types";
import { UserPrefsRepository } from "../src/user-prefs-repository";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("handleDigestDeliveryBatch", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubSlackFetch(options: {
    sentMessages: Array<{ channel: string; text: string; blocks?: unknown[] }>;
    channelId?: string;
  }): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;

        if (url.endsWith("/conversations.open")) {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: { id: options.channelId ?? "D_TEST" },
            }),
            { status: 200 }
          );
        }

        if (url.endsWith("/chat.postMessage")) {
          options.sentMessages.push({
            channel: body.channel as string,
            text: body.text as string,
            blocks: body.blocks as unknown[],
          });
          return new Response(
            JSON.stringify({
              ok: true,
              ts: "1708099999.222222",
              channel: body.channel,
            }),
            { status: 200 }
          );
        }

        return new Response(
          JSON.stringify({ ok: false, error: "not_mocked" }),
          { status: 500 }
        );
      })
    );
  }

  function createMockBatch(
    messages: DigestDeliveryMessage[]
  ): MessageBatch<DigestDeliveryMessage> {
    const acked: number[] = [];
    const retried: number[] = [];

    return {
      queue: "digest-delivery",
      messages: messages.map((body, idx) => ({
        id: `msg-${idx}`,
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: () => { acked.push(idx); },
        retry: () => { retried.push(idx); },
      })),
      ackAll: () => {},
      retryAll: () => {},
      _acked: acked,
      _retried: retried,
    } as unknown as MessageBatch<DigestDeliveryMessage> & {
      _acked: number[];
      _retried: number[];
    };
  }

  it("delivers digest with action items and records delivery", async () => {
    const sentMessages: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
    stubSlackFetch({ sentMessages });

    // Insert user prefs
    await env.DB
      .prepare(
        `INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
         VALUES (?, 1, 9, 0, 'UTC', 1, ?, ?)`
      )
      .bind("U_DIGEST", new Date().toISOString(), new Date().toISOString())
      .run();

    // Insert thoughts within the digest period
    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = now.toISOString();
    const midPeriod = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB
      .prepare(
        `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
         VALUES (?, ?, ?, ?, 'action_required', 'llm', 'open', ?)`
      )
      .bind("t-digest-1", "U_DIGEST", "ts-digest-1", "Review RFC", midPeriod)
      .run();

    const testEnv = buildTestEnv();
    const batch = createMockBatch([
      { userId: "U_DIGEST", periodStart, periodEnd },
    ]);

    await handleDigestDeliveryBatch(batch, testEnv);

    // Verify digest was sent
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].channel).toBe("D_TEST");

    // Verify delivery recorded
    const delivery = await env.DB.prepare(
      `SELECT * FROM digest_deliveries WHERE slack_user_id = ?`
    )
      .bind("U_DIGEST")
      .first<{
        item_count: number;
        slack_message_ts: string;
        period_start: string;
      }>();

    expect(delivery).not.toBeNull();
    expect(delivery?.item_count).toBe(1);
    expect(delivery?.slack_message_ts).toBe("1708099999.222222");
    expect(delivery?.period_start).toBe(periodStart);

    // Verify analytics event
    const analytics = await env.DB.prepare(
      `SELECT * FROM analytics_events WHERE event_type = 'digest.sent'`
    ).first<{ slack_user_id: string; properties: string }>();

    expect(analytics?.slack_user_id).toBe("U_DIGEST");
    expect(JSON.parse(analytics?.properties ?? "{}")).toMatchObject({
      item_count: 1,
      snoozed_item_count: 0,
      period_start: periodStart,
      period_end: periodEnd,
    });

    // Verify message was acked
    const batchAny = batch as unknown as { _acked: number[] };
    expect(batchAny._acked).toContain(0);
  });

  it("sends empty-week message when no action items", async () => {
    const sentMessages: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
    stubSlackFetch({ sentMessages });

    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = now.toISOString();

    const testEnv = buildTestEnv();
    const batch = createMockBatch([
      { userId: "U_EMPTY", periodStart, periodEnd },
    ]);

    await handleDigestDeliveryBatch(batch, testEnv);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("No Action Items");
  });

  it("skips delivery if already exists (idempotency)", async () => {
    const sentMessages: Array<{ channel: string; text: string }> = [];
    stubSlackFetch({ sentMessages });

    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = now.toISOString();

    // Insert existing delivery
    await env.DB
      .prepare(
        `INSERT INTO digest_deliveries (id, slack_user_id, delivered_at, item_count, snoozed_item_count, period_start, period_end)
         VALUES (?, ?, ?, 5, 0, ?, ?)`
      )
      .bind(crypto.randomUUID(), "U_ALREADY_DONE", now.toISOString(), periodStart, periodEnd)
      .run();

    const testEnv = buildTestEnv();
    const batch = createMockBatch([
      { userId: "U_ALREADY_DONE", periodStart, periodEnd },
    ]);

    await handleDigestDeliveryBatch(batch, testEnv);

    // No message should be sent
    expect(sentMessages).toHaveLength(0);

    // Message should still be acked (duplicate, not an error)
    const batchAny = batch as unknown as { _acked: number[] };
    expect(batchAny._acked).toContain(0);
  });

  it("retries on Slack API failure", async () => {
    // Stub fetch to fail
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/conversations.open")) {
          return new Response(
            JSON.stringify({ ok: true, channel: { id: "D_TEST" } }),
            { status: 200 }
          );
        }
        if (url.endsWith("/chat.postMessage")) {
          return new Response(
            JSON.stringify({ ok: false, error: "channel_not_found" }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: false }), { status: 500 });
      })
    );

    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = now.toISOString();

    const testEnv = buildTestEnv();
    const batch = createMockBatch([
      { userId: "U_FAIL", periodStart, periodEnd },
    ]);

    await handleDigestDeliveryBatch(batch, testEnv);

    // Message should be retried, not acked
    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._retried).toContain(0);
    expect(batchAny._acked).not.toContain(0);
  });

  it("acks delivery when analytics logging fails after send", async () => {
    const sentMessages: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
    stubSlackFetch({ sentMessages });

    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = now.toISOString();
    const createdAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    await env.DB
      .prepare(
        `INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
         VALUES (?, 1, 9, 0, 'UTC', 1, ?, ?)`
      )
      .bind("U_ANALYTICS_FAIL", now.toISOString(), now.toISOString())
      .run();

    await env.DB
      .prepare(
        `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
         VALUES (?, ?, ?, ?, 'action_required', 'llm', 'open', ?)`
      )
      .bind("t-analytics-fail", "U_ANALYTICS_FAIL", "ts-analytics-fail", "Finish hardening", createdAt)
      .run();

    const testEnv = buildTestEnv();
    const batch = createMockBatch([
      { userId: "U_ANALYTICS_FAIL", periodStart, periodEnd },
    ]);

    const failingAnalyticsRepository = new AnalyticsRepository();
    vi.spyOn(failingAnalyticsRepository, "logEvent").mockRejectedValue(
      new Error("analytics unavailable")
    );

    await handleDigestDeliveryBatch(batch, testEnv, {
      thoughtRepository: new ThoughtRepository(),
      analyticsRepository: failingAnalyticsRepository,
      digestDeliveryRepository: new DigestDeliveryRepository(),
      userPrefsRepository: new UserPrefsRepository(),
      createSlackClient: (token: string) => new SlackClient(token),
    });

    const deliveryCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM digest_deliveries WHERE slack_user_id = ?`
    )
      .bind("U_ANALYTICS_FAIL")
      .first<{ count: number }>();

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'digest.sent'`
    ).first<{ count: number }>();

    expect(sentMessages).toHaveLength(1);
    expect(Number(deliveryCount?.count ?? 0)).toBe(1);
    expect(Number(analyticsCount?.count ?? 0)).toBe(0);

    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._acked).toContain(0);
    expect(batchAny._retried).not.toContain(0);
  });
});
