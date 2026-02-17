import { env } from "cloudflare:test";

import { handleDigestButtonAction, type SlackInteractionPayload } from "../src/digest-button-handler";
import type { Env } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("handleDigestButtonAction", () => {
  const DIGEST_MESSAGE_TS = "1708099999.111111";

  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function insertThought(
    id: string,
    userId: string,
    options: { classification?: string; status?: string } = {}
  ): Promise<void> {
    await env.DB
      .prepare(
        `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'llm', ?, ?)`
      )
      .bind(
        id,
        userId,
        `170801${Date.now()}.000001`,
        "test thought",
        options.classification ?? "action_required",
        options.status ?? "open",
        new Date().toISOString()
      )
      .run();
  }

  async function insertDigestDelivery(
    userId: string,
    messageTs: string,
    deliveredAt: string
  ): Promise<void> {
    const periodEnd = deliveredAt;
    const periodStart = new Date(
      new Date(deliveredAt).getTime() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    await env.DB
      .prepare(
        `INSERT INTO digest_deliveries (id, slack_user_id, delivered_at, item_count, snoozed_item_count, slack_message_ts, period_start, period_end)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), userId, deliveredAt, messageTs, periodStart, periodEnd)
      .run();
  }

  function makePayload(
    action: string,
    thoughtId: string,
    userId: string = "U_ENABLED"
  ): SlackInteractionPayload {
    return {
      type: "block_actions",
      user: { id: userId },
      actions: [
        {
          action_id: action,
          block_id: `actions_${thoughtId}`,
          value: thoughtId,
        },
      ],
      message: {
        ts: DIGEST_MESSAGE_TS,
        blocks: [
          {
            type: "actions",
            block_id: `actions_${thoughtId}`,
            elements: [],
          },
        ],
      },
      channel: { id: "D_ENABLED" },
    };
  }

  function stubSlackUpdateFetch(updates: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/chat.update")) {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>;
          updates.push(String(body.text ?? ""));
          return new Response(
            JSON.stringify({ ok: true, ts: body.ts, channel: body.channel }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: false, error: "not_mocked" }), {
          status: 500,
        });
      })
    );
  }

  it("marks thought as acted_on", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-act", "U_ENABLED");
    await insertDigestDelivery(
      "U_ENABLED",
      DIGEST_MESSAGE_TS,
      new Date(Date.now() - 45 * 1000).toISOString()
    );
    const testEnv = buildTestEnv();

    await handleDigestButtonAction(makePayload("thought_acted_on", "t-act"), testEnv);

    const thought = await env.DB.prepare(
      `SELECT status, status_changed_at FROM thoughts WHERE id = ?`
    )
      .bind("t-act")
      .first<{ status: string; status_changed_at: string }>();

    expect(thought?.status).toBe("acted_on");
    expect(thought?.status_changed_at).not.toBeNull();

    // Verify analytics event logged
    const analytics = await env.DB.prepare(
      `SELECT * FROM analytics_events WHERE event_type = 'digest.item.acted_on'`
    ).first<{ slack_user_id: string }>();

    expect(analytics?.slack_user_id).toBe("U_ENABLED");

    const engagement = await env.DB.prepare(
      `SELECT properties FROM analytics_events WHERE event_type = 'digest.engagement'`
    ).first<{ properties: string }>();

    const engagementProps = JSON.parse(engagement?.properties ?? "{}");
    expect(engagementProps.digest_message_ts).toBe(DIGEST_MESSAGE_TS);
    expect(engagementProps.time_to_first_interaction_ms).toBeGreaterThanOrEqual(0);

    // Verify Slack message updated
    expect(updates).toHaveLength(1);
  });

  it("snoozes thought with 7-day snooze_until", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-snz", "U_ENABLED");
    const testEnv = buildTestEnv();

    const beforeMs = Date.now();
    await handleDigestButtonAction(makePayload("thought_snooze", "t-snz"), testEnv);
    const afterMs = Date.now();

    const thought = await env.DB.prepare(
      `SELECT status, snooze_until FROM thoughts WHERE id = ?`
    )
      .bind("t-snz")
      .first<{ status: string; snooze_until: string }>();

    expect(thought?.status).toBe("snoozed");
    expect(thought?.snooze_until).not.toBeNull();

    const snoozeMs = new Date(thought!.snooze_until).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(snoozeMs).toBeGreaterThanOrEqual(beforeMs + sevenDays - 1000);
    expect(snoozeMs).toBeLessThanOrEqual(afterMs + sevenDays + 1000);

    const analytics = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'digest.item.snoozed'`
    ).first<{ count: number }>();

    expect(Number(analytics?.count ?? 0)).toBe(1);
  });

  it("dismisses thought", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-dis", "U_ENABLED");
    const testEnv = buildTestEnv();

    await handleDigestButtonAction(makePayload("thought_dismiss", "t-dis"), testEnv);

    const thought = await env.DB.prepare(
      `SELECT status FROM thoughts WHERE id = ?`
    )
      .bind("t-dis")
      .first<{ status: string }>();

    expect(thought?.status).toBe("dismissed");

    const analytics = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'digest.item.dismissed'`
    ).first<{ count: number }>();

    expect(Number(analytics?.count ?? 0)).toBe(1);
  });

  it("does not update a thought in terminal state (idempotent re-tap)", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-term", "U_ENABLED", { status: "acted_on" });
    const testEnv = buildTestEnv();

    await handleDigestButtonAction(makePayload("thought_acted_on", "t-term"), testEnv);

    // Status should remain acted_on (terminal state guard in repository)
    const thought = await env.DB.prepare(
      `SELECT status FROM thoughts WHERE id = ?`
    )
      .bind("t-term")
      .first<{ status: string }>();

    expect(thought?.status).toBe("acted_on");
  });

  it("ignores action from a user who does not own the thought", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-other", "U_OTHER");
    const testEnv = buildTestEnv({ ENABLED_USER_IDS: "U_ENABLED,U_OTHER" });

    const result = await handleDigestButtonAction(
      makePayload("thought_acted_on", "t-other", "U_ENABLED"),
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT status FROM thoughts WHERE id = ?`
    )
      .bind("t-other")
      .first<{ status: string }>();

    // Should remain open — U_ENABLED doesn't own this thought
    expect(thought?.status).toBe("open");
    expect(updates).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.userMessage).toBe("Something went wrong. Please try again.");
  });

  it("keeps status update when Slack message update fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
          status: 200,
        });
      })
    );

    await insertThought("t-update-fails", "U_ENABLED");
    const testEnv = buildTestEnv();

    const result = await handleDigestButtonAction(
      makePayload("thought_acted_on", "t-update-fails"),
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT status FROM thoughts WHERE id = ?`
    )
      .bind("t-update-fails")
      .first<{ status: string }>();

    expect(result.ok).toBe(true);
    expect(thought?.status).toBe("acted_on");
  });

  it("logs digest.engagement only once per digest message", async () => {
    const updates: string[] = [];
    stubSlackUpdateFetch(updates);

    await insertThought("t-engage-once", "U_ENABLED");
    await insertDigestDelivery(
      "U_ENABLED",
      DIGEST_MESSAGE_TS,
      new Date(Date.now() - 60 * 1000).toISOString()
    );

    const testEnv = buildTestEnv();

    await handleDigestButtonAction(
      makePayload("thought_acted_on", "t-engage-once"),
      testEnv
    );
    await handleDigestButtonAction(
      makePayload("thought_dismiss", "t-engage-once"),
      testEnv
    );

    const engagementCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'digest.engagement'`
    ).first<{ count: number }>();

    expect(Number(engagementCount?.count ?? 0)).toBe(1);
  });
});
