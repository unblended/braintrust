import { SlackClient } from "../src/slack-client";

describe("SlackClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries on retryable HTTP failures and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 429,
          headers: { "Retry-After": "0" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, ts: "1708012222.000001", channel: "D_TEST" }),
          { status: 200 }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new SlackClient("xoxb-test-token");
    const result = await client.postMessage({
      channel: "D_TEST",
      text: "hello",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on retryable Slack API response errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 200,
          headers: { "Retry-After": "0" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: { id: "D_TEST" } }), {
          status: 200,
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new SlackClient("xoxb-test-token");
    const result = await client.openConversation({
      users: "U_TEST",
    });

    expect(result.ok).toBe(true);
    expect(result.channel?.id).toBe("D_TEST");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-retryable Slack API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      })
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new SlackClient("xoxb-test-token");

    await expect(
      client.postMessage({
        channel: "D_MISSING",
        text: "hello",
      })
    ).rejects.toThrow("Slack API chat.postMessage error: channel_not_found");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
