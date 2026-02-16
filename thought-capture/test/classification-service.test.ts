import { ClassificationService } from "../src/classification-service";

describe("ClassificationService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("parses valid model responses", async () => {
    stubOpenAiFetch("reference");
    const service = new ClassificationService("test-key");

    const result = await service.classify("Capture this for later");

    expect(result).toEqual({
      classification: "reference",
      model: "gpt-4o-mini-2024-07-18",
      usedFallback: false,
    });
  });

  it("falls back to action_required on invalid responses", async () => {
    stubOpenAiFetch("not-a-valid-classification");
    const service = new ClassificationService("test-key");

    const result = await service.classify("Maybe this is urgent");

    expect(result).toEqual({
      classification: "action_required",
      model: "gpt-4o-mini-2024-07-18",
      usedFallback: true,
    });
  });

  it("times out after 25 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );

    const service = new ClassificationService("test-key");
    const classificationPromise = service.classify("This call should time out");

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(classificationPromise).rejects.toThrow(
      "Classification timed out after 25000ms"
    );
  });
});

function stubOpenAiFetch(responseText: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
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
                content: responseText,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    })
  );
}
