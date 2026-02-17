import { env } from "cloudflare:test";

import { handleDirectMessage, type SlackMessageEvent } from "../src/slack-event-handlers";
import type { ClassificationMessage, Env } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("handleDirectMessage", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("captures a DM, creates prefs, welcomes first-time users, and enqueues classification", async () => {
    const sentMessages: string[] = [];
    const reactions: Array<{ channel: string; timestamp: string; name: string }> = [];
    const queueSend = vi.fn(async (_message: ClassificationMessage) => {
      return;
    });

    stubSlackFetch({ sentMessages, reactions, timezone: "America/Los_Angeles" });

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
      CLASSIFICATION_QUEUE: {
        send: queueSend,
      } as Queue<ClassificationMessage>,
    });

    await handleDirectMessage(
      {
        type: "message",
        channel_type: "im",
        user: "U_ENABLED",
        text: "Write RFC for worker queue retries",
        ts: "1708012345.123456",
        channel: "D_ENABLED",
      },
      testEnv
    );

    const thought = await env.DB.prepare(
      `SELECT * FROM thoughts WHERE slack_message_ts = ?`
    )
      .bind("1708012345.123456")
      .first<{
        id: string;
        classification: string;
        classification_source: string;
        text: string;
      }>();

    expect(thought).not.toBeNull();
    expect(thought?.classification).toBe("unclassified");
    expect(thought?.classification_source).toBe("pending");

    const prefs = await env.DB.prepare(
      `SELECT * FROM user_prefs WHERE slack_user_id = ?`
    )
      .bind("U_ENABLED")
      .first<{ timezone: string; welcomed: number }>();

    expect(prefs?.timezone).toBe("America/Los_Angeles");
    expect(prefs?.welcomed).toBe(1);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Welcome to Thought Capture");

    expect(reactions).toEqual([
      {
        channel: "D_ENABLED",
        timestamp: "1708012345.123456",
        name: "white_check_mark",
      },
    ]);

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0]?.[0]).toEqual({
      thoughtId: thought?.id,
      userId: "U_ENABLED",
    });

    const analytics = await env.DB.prepare(
      `SELECT properties FROM analytics_events WHERE event_type = 'thought.captured'`
    ).first<{ properties: string }>();

    expect(JSON.parse(analytics?.properties ?? "{}")).toMatchObject({
      thought_id: thought?.id,
      text_length: "Write RFC for worker queue retries".length,
    });
  });

  it("silently drops duplicate message timestamps", async () => {
    const queueSend = vi.fn(async (_message: ClassificationMessage) => {
      return;
    });

    stubSlackFetch({
      sentMessages: [],
      reactions: [],
      timezone: "America/New_York",
    });

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
      CLASSIFICATION_QUEUE: {
        send: queueSend,
      } as Queue<ClassificationMessage>,
    });

    const event = baseMessageEvent();

    await handleDirectMessage(event, testEnv);
    await handleDirectMessage(event, testEnv);

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM thoughts WHERE slack_message_ts = ?`
    )
      .bind(event.ts)
      .first<{ count: number }>();

    expect(Number(row?.count ?? 0)).toBe(1);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it("replies to non-text messages and skips persistence", async () => {
    const sentMessages: string[] = [];
    const queueSend = vi.fn(async (_message: ClassificationMessage) => {
      return;
    });

    stubSlackFetch({
      sentMessages,
      reactions: [],
      timezone: "America/New_York",
    });

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
      CLASSIFICATION_QUEUE: {
        send: queueSend,
      } as Queue<ClassificationMessage>,
    });

    await handleDirectMessage(
      {
        ...baseMessageEvent(),
        subtype: "file_share",
        text: undefined,
      },
      testEnv
    );

    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM thoughts`).first<{
      count: number;
    }>();

    expect(Number(row?.count ?? 0)).toBe(0);
    expect(queueSend).not.toHaveBeenCalled();
    expect(sentMessages).toEqual([
      "I can only capture text thoughts right now. Try typing it out!",
    ]);
  });

  it("enforces a per-user rate limit of 60 thoughts per hour", async () => {
    const sentMessages: string[] = [];
    const queueSend = vi.fn(async (_message: ClassificationMessage) => {
      return;
    });

    stubSlackFetch({
      sentMessages,
      reactions: [],
      timezone: "America/New_York",
    });

    const nowIso = new Date().toISOString();
    for (let i = 0; i < 60; i += 1) {
      await env.DB.prepare(
        `INSERT INTO thoughts (
          id, slack_user_id, slack_message_ts, text,
          classification, classification_source, status, created_at
        ) VALUES (?, ?, ?, ?, 'unclassified', 'pending', 'open', ?)`
      )
        .bind(
          `thought-${i}`,
          "U_ENABLED",
          `1708012${i}.123456`,
          `existing thought ${i}`,
          nowIso
        )
        .run();
    }

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
      CLASSIFICATION_QUEUE: {
        send: queueSend,
      } as Queue<ClassificationMessage>,
    });

    await handleDirectMessage(baseMessageEvent(), testEnv);

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM thoughts WHERE slack_user_id = ?`
    )
      .bind("U_ENABLED")
      .first<{ count: number }>();

    expect(Number(countRow?.count ?? 0)).toBe(60);
    expect(queueSend).not.toHaveBeenCalled();
    expect(sentMessages).toContain(
      "You're capturing thoughts faster than I can keep up! Please wait a bit."
    );
  });

  it("truncates thought text to 4000 characters", async () => {
    const sentMessages: string[] = [];
    const queueSend = vi.fn(async (_message: ClassificationMessage) => {
      return;
    });

    stubSlackFetch({
      sentMessages,
      reactions: [],
      timezone: "America/New_York",
    });

    const longText = "x".repeat(4500);
    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
      CLASSIFICATION_QUEUE: {
        send: queueSend,
      } as Queue<ClassificationMessage>,
    });

    await handleDirectMessage(
      {
        ...baseMessageEvent(),
        ts: "1708012999.123456",
        text: longText,
      },
      testEnv
    );

    const row = await env.DB.prepare(
      `SELECT text FROM thoughts WHERE slack_message_ts = ?`
    )
      .bind("1708012999.123456")
      .first<{ text: string }>();

    expect(row?.text.length).toBe(4000);
    expect(sentMessages.some((message) => message.includes("4,000"))).toBe(true);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });
});

function baseMessageEvent(): SlackMessageEvent {
  return {
    type: "message",
    channel_type: "im",
    user: "U_ENABLED",
    text: "capture this thought",
    ts: "1708012000.123456",
    channel: "D_ENABLED",
  };
}

function stubSlackFetch(options: {
  sentMessages: string[];
  reactions: Array<{ channel: string; timestamp: string; name: string }>;
  timezone: string;
}): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = parseJsonBody(init?.body);

    if (url.endsWith("/users.info")) {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: body.user,
            tz: options.timezone,
            tz_label: "Test",
            tz_offset: 0,
          },
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/chat.postMessage")) {
      options.sentMessages.push(String(body.text ?? ""));
      return new Response(
        JSON.stringify({
          ok: true,
          ts: `${Date.now()}.000001`,
          channel: body.channel,
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/reactions.add")) {
      options.reactions.push({
        channel: String(body.channel),
        timestamp: String(body.timestamp),
        name: String(body.name),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: false, error: "not_mocked" }), {
      status: 500,
    });
  });

  vi.stubGlobal("fetch", fetchMock);
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
}
