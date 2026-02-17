import { env } from "cloudflare:test";

import {
  handleClassificationOverride,
  handleReactionOverride,
  type SlackMessageEvent,
  type SlackReactionAddedEvent,
} from "../src/slack-event-handlers";
import type { Env } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("override handlers", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("handles text reclassification overrides", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-text-override",
      userId: "U_ENABLED",
      slackMessageTs: "1708012000.000001",
      classification: "noise",
      createdAt: new Date().toISOString(),
    });

    const testEnv = buildEnabledEnv();

    await handleClassificationOverride(
      {
        type: "message",
        channel_type: "im",
        user: "U_ENABLED",
        text: "reclassify as action",
        ts: "1708012999.000001",
        channel: "D_ENABLED",
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification, classification_source FROM thoughts WHERE id = ?`
    )
      .bind("thought-text-override")
      .first<{ classification: string; classification_source: string }>();

    expect(thought?.classification).toBe("action_required");
    expect(thought?.classification_source).toBe("user_override");

    const analytics = await env.DB.prepare(
      `SELECT event_type, properties FROM analytics_events WHERE event_type = 'thought.override'`
    ).first<{ event_type: string; properties: string }>();

    expect(analytics?.event_type).toBe("thought.override");
    expect(JSON.parse(analytics?.properties ?? "{}")).toMatchObject({
      from_category: "noise",
      to_category: "action_required",
      source: "text",
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Reclassified as Action Required");
  });

  it("handles emoji overrides using bot_reply_ts lookup first", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-emoji-override",
      userId: "U_ENABLED",
      slackMessageTs: "1708012100.000001",
      botReplyTs: "1708012200.000001",
      classification: "reference",
      createdAt: new Date().toISOString(),
    });

    const testEnv = buildEnabledEnv();

    await handleReactionOverride(
      {
        type: "reaction_added",
        user: "U_ENABLED",
        reaction: "wastebasket",
        item: {
          type: "message",
          channel: "D_ENABLED",
          ts: "1708012200.000001",
        },
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification, classification_source FROM thoughts WHERE id = ?`
    )
      .bind("thought-emoji-override")
      .first<{ classification: string; classification_source: string }>();

    expect(thought?.classification).toBe("noise");
    expect(thought?.classification_source).toBe("user_override");

    const analytics = await env.DB.prepare(
      `SELECT properties FROM analytics_events WHERE event_type = 'thought.override' ORDER BY created_at DESC LIMIT 1`
    ).first<{ properties: string }>();

    expect(JSON.parse(analytics?.properties ?? "{}")).toMatchObject({
      from_category: "reference",
      to_category: "noise",
      source: "emoji",
      reaction: "wastebasket",
    });

    expect(sentMessages[0]).toContain("Reclassified as Noise");
  });

  it("falls back to slack_message_ts for emoji overrides", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-emoji-fallback",
      userId: "U_ENABLED",
      slackMessageTs: "1708012300.000001",
      classification: "noise",
      createdAt: new Date().toISOString(),
    });

    const testEnv = buildEnabledEnv();

    await handleReactionOverride(
      {
        type: "reaction_added",
        user: "U_ENABLED",
        reaction: "pushpin",
        item: {
          type: "message",
          channel: "D_ENABLED",
          ts: "1708012300.000001",
        },
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification FROM thoughts WHERE id = ?`
    )
      .bind("thought-emoji-fallback")
      .first<{ classification: string }>();

    expect(thought?.classification).toBe("action_required");
    expect(sentMessages[0]).toContain("Action Required");
  });

  it("ignores emoji overrides from users who do not own the thought", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-owner-check",
      userId: "U_OWNER",
      slackMessageTs: "1708012400.000001",
      botReplyTs: "1708012500.000001",
      classification: "reference",
      createdAt: new Date().toISOString(),
    });

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_OWNER,U_OTHER",
    });

    await handleReactionOverride(
      {
        type: "reaction_added",
        user: "U_OTHER",
        reaction: "pushpin",
        item: {
          type: "message",
          channel: "D_OWNER",
          ts: "1708012500.000001",
        },
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification FROM thoughts WHERE id = ?`
    )
      .bind("thought-owner-check")
      .first<{ classification: string }>();

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.override'`
    ).first<{ count: number }>();

    expect(thought?.classification).toBe("reference");
    expect(Number(analyticsCount?.count ?? 0)).toBe(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("treats text override to the same category as an idempotent no-op", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-text-noop",
      userId: "U_ENABLED",
      slackMessageTs: "1708012600.000001",
      classification: "reference",
      createdAt: new Date().toISOString(),
    });

    const testEnv = buildEnabledEnv();

    await handleClassificationOverride(
      {
        type: "message",
        channel_type: "im",
        user: "U_ENABLED",
        text: "reclassify as reference",
        ts: "1708012699.000001",
        channel: "D_ENABLED",
      },
      testEnv
    );

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.override'`
    ).first<{ count: number }>();

    expect(Number(analyticsCount?.count ?? 0)).toBe(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Already classified as Reference");
  });

  it("rejects text overrides when per-user override rate limit is exceeded", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-text-rate-limit",
      userId: "U_ENABLED",
      slackMessageTs: "1708012700.000001",
      classification: "noise",
      createdAt: new Date().toISOString(),
    });
    await insertOverrideEvents("U_ENABLED", 60);

    const testEnv = buildEnabledEnv();

    await handleClassificationOverride(
      {
        type: "message",
        channel_type: "im",
        user: "U_ENABLED",
        text: "reclassify as action",
        ts: "1708012799.000001",
        channel: "D_ENABLED",
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification FROM thoughts WHERE id = ?`
    )
      .bind("thought-text-rate-limit")
      .first<{ classification: string }>();

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.override'`
    ).first<{ count: number }>();

    expect(thought?.classification).toBe("noise");
    expect(Number(analyticsCount?.count ?? 0)).toBe(60);
    expect(sentMessages).toContain(
      "You're reclassifying thoughts faster than I can keep up! Please wait a bit."
    );
  });

  it("rejects emoji overrides when per-user override rate limit is exceeded", async () => {
    const sentMessages: string[] = [];
    stubSlackPostMessage(sentMessages);

    await insertThoughtRow({
      id: "thought-emoji-rate-limit",
      userId: "U_ENABLED",
      slackMessageTs: "1708012800.000001",
      botReplyTs: "1708012801.000001",
      classification: "reference",
      createdAt: new Date().toISOString(),
    });
    await insertOverrideEvents("U_ENABLED", 60);

    const testEnv = buildEnabledEnv();

    await handleReactionOverride(
      {
        type: "reaction_added",
        user: "U_ENABLED",
        reaction: "wastebasket",
        item: {
          type: "message",
          channel: "D_ENABLED",
          ts: "1708012801.000001",
        },
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT classification FROM thoughts WHERE id = ?`
    )
      .bind("thought-emoji-rate-limit")
      .first<{ classification: string }>();

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.override'`
    ).first<{ count: number }>();

    expect(thought?.classification).toBe("reference");
    expect(Number(analyticsCount?.count ?? 0)).toBe(60);
    expect(sentMessages).toContain(
      "You're reclassifying thoughts faster than I can keep up! Please wait a bit."
    );
  });
});

function buildEnabledEnv(): Env {
  return buildTestEnv({
    ENABLED_USER_IDS: "U_ENABLED",
  });
}

function stubSlackPostMessage(sentMessages: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.endsWith("/chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        text?: string;
      };

      sentMessages.push(payload.text ?? "");

      return new Response(
        JSON.stringify({ ok: true, ts: `${Date.now()}.000001`, channel: "D_TEST" }),
        { status: 200 }
      );
    })
  );
}

async function insertThoughtRow(params: {
  id: string;
  userId: string;
  slackMessageTs: string;
  botReplyTs?: string;
  classification: "unclassified" | "action_required" | "reference" | "noise";
  createdAt: string;
}): Promise<void> {
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
      bot_reply_ts
    ) VALUES (?, ?, ?, ?, ?, 'llm', 'open', ?, ?)`
  )
    .bind(
      params.id,
      params.userId,
      params.slackMessageTs,
      "seed thought",
      params.classification,
      params.createdAt,
      params.botReplyTs ?? null
    )
    .run();
}

async function insertOverrideEvents(userId: string, count: number): Promise<void> {
  const now = new Date().toISOString();

  for (let i = 0; i < count; i += 1) {
    await env.DB.prepare(
      `INSERT INTO analytics_events (id, event_type, slack_user_id, properties, created_at)
       VALUES (?, 'thought.override', ?, '{}', ?)`
    )
      .bind(`override-${userId}-${i}`, userId, now)
      .run();
  }
}
