import { env } from "cloudflare:test";

import { handleClassificationBatch } from "../src/classification-queue-consumer";
import { AnalyticsRepository } from "../src/analytics-repository";
import { ClassificationService } from "../src/classification-service";
import { SlackClient } from "../src/slack-client";
import { ThoughtRepository } from "../src/thought-repository";
import type { ClassificationMessage } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("handleClassificationBatch", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("classifies thoughts, updates D1, posts Slack reply, and stores bot_reply_ts", async () => {
    await insertThought({
      id: "thought-queue-1",
      userId: "U_ENABLED",
      ts: "1708011111.000001",
      text: "This can wait for reference",
    });

    stubQueueFetch({ classification: "reference" });

    const batch = createMockBatch([
      {
        thoughtId: "thought-queue-1",
        userId: "U_ENABLED",
      },
    ]);

    await handleClassificationBatch(
      batch,
      buildTestEnv()
    );

    const thought = await env.DB.prepare(
      `SELECT classification, classification_source, bot_reply_ts
       FROM thoughts
       WHERE id = ?`
    )
      .bind("thought-queue-1")
      .first<{
        classification: string;
        classification_source: string;
        bot_reply_ts: string | null;
      }>();

    expect(thought?.classification).toBe("reference");
    expect(thought?.classification_source).toBe("llm");
    expect(thought?.bot_reply_ts).toBe("1708012222.000001");

    const analytics = await env.DB.prepare(
      `SELECT event_type, properties
       FROM analytics_events
       WHERE event_type = 'thought.classified'`
    ).first<{ event_type: string; properties: string }>();

    expect(analytics?.event_type).toBe("thought.classified");
    expect(JSON.parse(analytics?.properties ?? "{}")).toMatchObject({
      thought_id: "thought-queue-1",
      category: "reference",
      classification: "reference",
      model_version: "gpt-4o-mini-2024-07-18",
    });

    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._acked).toContain(0);
    expect(batchAny._retried).toHaveLength(0);
  });

  it("retries when classification fails", async () => {
    await insertThought({
      id: "thought-queue-fail",
      userId: "U_ENABLED",
      ts: "1708013333.000001",
      text: "This should trigger retry",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "openai down" }), {
          status: 500,
        });
      })
    );

    const batch = createMockBatch([
      {
        thoughtId: "thought-queue-fail",
        userId: "U_ENABLED",
      },
    ]);

    await handleClassificationBatch(batch, buildTestEnv());

    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._retried).toContain(0);
    expect(batchAny._acked).toHaveLength(0);
  });

  it("skips already-classified thoughts without calling external APIs", async () => {
    await insertThought({
      id: "thought-queue-already-classified",
      userId: "U_ENABLED",
      ts: "1708014444.000001",
      text: "already classified",
      classification: "reference",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const batch = createMockBatch([
      {
        thoughtId: "thought-queue-already-classified",
        userId: "U_ENABLED",
      },
    ]);

    await handleClassificationBatch(
      batch,
      buildTestEnv()
    );

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.classified'`
    ).first<{ count: number }>();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(Number(analyticsCount?.count ?? 0)).toBe(0);

    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._acked).toContain(0);
    expect(batchAny._retried).toHaveLength(0);
  });

  it("acks without retry when analytics logging fails after classification", async () => {
    await insertThought({
      id: "thought-queue-analytics-fail",
      userId: "U_ENABLED",
      ts: "1708015555.000001",
      text: "classify but fail analytics",
    });

    stubQueueFetch({ classification: "reference" });

    const failingAnalyticsRepository = new AnalyticsRepository();
    vi.spyOn(failingAnalyticsRepository, "logEvent").mockRejectedValue(
      new Error("analytics unavailable")
    );

    const batch = createMockBatch([
      {
        thoughtId: "thought-queue-analytics-fail",
        userId: "U_ENABLED",
      },
    ]);

    await handleClassificationBatch(batch, buildTestEnv(), {
      thoughtRepository: new ThoughtRepository(),
      analyticsRepository: failingAnalyticsRepository,
      createClassificationService: (apiKey: string) =>
        new ClassificationService(apiKey),
      createSlackClient: (token: string) => new SlackClient(token),
    });

    const thought = await env.DB.prepare(
      `SELECT classification, bot_reply_ts FROM thoughts WHERE id = ?`
    )
      .bind("thought-queue-analytics-fail")
      .first<{ classification: string; bot_reply_ts: string | null }>();

    const analyticsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM analytics_events WHERE event_type = 'thought.classified'`
    ).first<{ count: number }>();

    expect(thought?.classification).toBe("reference");
    expect(thought?.bot_reply_ts).toBe("1708012222.000001");
    expect(Number(analyticsCount?.count ?? 0)).toBe(0);

    const batchAny = batch as unknown as { _acked: number[]; _retried: number[] };
    expect(batchAny._acked).toContain(0);
    expect(batchAny._retried).toHaveLength(0);
  });
});

function createMockBatch(
  messages: ClassificationMessage[]
): MessageBatch<ClassificationMessage> {
  const acked: number[] = [];
  const retried: number[] = [];

  return {
    queue: "thought-classification",
    messages: messages.map((body, idx) => ({
      id: `msg-${idx}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        acked.push(idx);
      },
      retry: () => {
        retried.push(idx);
      },
    })),
    ackAll: () => {
      return;
    },
    retryAll: () => {
      return;
    },
    _acked: acked,
    _retried: retried,
  } as unknown as MessageBatch<ClassificationMessage> & {
    _acked: number[];
    _retried: number[];
  };
}

async function insertThought(params: {
  id: string;
  userId: string;
  ts: string;
  text: string;
  classification?: "unclassified" | "action_required" | "reference" | "noise";
}): Promise<void> {
  const classification = params.classification ?? "unclassified";
  const classificationSource =
    classification === "unclassified" ? "pending" : "llm";

  await env.DB.prepare(
    `INSERT INTO thoughts (
      id,
      slack_user_id,
      slack_message_ts,
      text,
      classification,
      classification_source,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  )
    .bind(
      params.id,
      params.userId,
      params.ts,
      params.text,
      classification,
      classificationSource,
      new Date().toISOString()
    )
    .run();
}

function stubQueueFetch(options: { classification: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o-mini-2024-07-18",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: options.classification,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 1,
              total_tokens: 11,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      if (url.endsWith("/conversations.open")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channel: {
              id: "D_ENABLED",
            },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/chat.postMessage")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string;
        };
        expect(payload.text).toContain("classified as");

        return new Response(
          JSON.stringify({
            ok: true,
            ts: "1708012222.000001",
            channel: "D_ENABLED",
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
}
