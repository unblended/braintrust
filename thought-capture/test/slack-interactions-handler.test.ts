import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";

import { handleSlackInteractions } from "../src/slack-interactions-handler";
import type { SlackInteractionPayload } from "../src/digest-button-handler";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("handleSlackInteractions", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns 400 for invalid payload", async () => {
    const response = await handleSlackInteractions(
      "payload=",
      buildTestEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when user is missing", async () => {
    const payload = {
      type: "block_actions",
      actions: [{ action_id: "thought_acted_on", block_id: "b1", value: "t1" }],
    };

    const response = await handleSlackInteractions(
      encodePayload(payload),
      buildTestEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(400);
  });

  it("returns access rejection message when feature is disabled", async () => {
    const payload = makePayload({ action_id: "thought_acted_on", value: "t1" });
    const response = await handleSlackInteractions(
      encodePayload(payload),
      buildTestEnv({ THOUGHT_CAPTURE_V1_ENABLED: "false" }),
      createExecutionContext()
    );

    const body = (await response.json()) as { response_type: string; text: string };
    expect(response.status).toBe(200);
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("temporarily unavailable");
  });

  it("returns generic ephemeral error for unknown action types", async () => {
    const payload = makePayload({ action_id: "unknown_action", value: "t1" });
    const response = await handleSlackInteractions(
      encodePayload(payload),
      buildTestEnv(),
      createExecutionContext()
    );

    const body = (await response.json()) as { response_type: string; text: string };
    expect(response.status).toBe(200);
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toBe("Something went wrong. Please try again.");
  });

  it("sends async ephemeral error via response_url when thought owner mismatches", async () => {
    await env.DB
      .prepare(
        `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
         VALUES (?, ?, ?, ?, 'action_required', 'llm', 'open', ?)`
      )
      .bind(
        "t-owner-mismatch",
        "U_OTHER",
        "1708011111.000001",
        "ownership check",
        new Date().toISOString()
      )
      .run();

    const responseUrlCalls: Array<{ text?: string; response_type?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string;
          response_type?: string;
        };
        responseUrlCalls.push(body);
        return new Response("ok", { status: 200 });
      })
    );

    const payload = makePayload(
      { action_id: "thought_acted_on", value: "t-owner-mismatch" },
      {
        userId: "U_ENABLED",
        responseUrl: "https://hooks.slack.com/actions/abc123",
      }
    );

    const ctx = createExecutionContext();
    const response = await handleSlackInteractions(
      encodePayload(payload),
      buildTestEnv({ ENABLED_USER_IDS: "U_ENABLED,U_OTHER" }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");

    await waitOnExecutionContext(ctx);

    expect(responseUrlCalls).toHaveLength(1);
    expect(responseUrlCalls[0].response_type).toBe("ephemeral");
    expect(responseUrlCalls[0].text).toBe(
      "Something went wrong. Please try again."
    );
  });
});

function encodePayload(payload: unknown): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function makePayload(
  action: { action_id: string; value: string },
  options: { userId?: string; responseUrl?: string } = {}
): SlackInteractionPayload {
  return {
    type: "block_actions",
    user: { id: options.userId ?? "U_ENABLED" },
    actions: [{ action_id: action.action_id, block_id: "actions_t1", value: action.value }],
    response_url: options.responseUrl,
    message: {
      ts: "1708099999.111111",
      blocks: [{ type: "actions", block_id: "actions_t1", elements: [] }],
    },
    channel: { id: "D_ENABLED" },
  };
}
