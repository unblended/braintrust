import { env, createExecutionContext } from "cloudflare:test";

import worker from "../src/index";
import type { DigestDeliveryMessage } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("worker queue/scheduled dispatch", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches digest-delivery queue messages", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });

    const ackFn = vi.fn();
    const retryFn = vi.fn();

    await worker.queue(
      {
        queue: "digest-delivery",
        messages: [
          {
            id: "msg-1",
            body: {
              userId: "U1",
              periodStart: "2026-01-01T00:00:00.000Z",
              periodEnd: "2026-01-08T00:00:00.000Z",
            },
            ack: ackFn,
            retry: retryFn,
          },
        ],
      } as unknown as MessageBatch<DigestDeliveryMessage>,
      buildTestEnv(),
      createExecutionContext()
    );

    // The delivery will fail (no real Slack API),
    // so the consumer should call retry() and log the error
    expect(retryFn).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("digest.delivery_failed")
    );
  });

  it("dispatches the digest scheduler cron", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      return;
    });

    await worker.scheduled(
      {
        cron: "*/15 * * * *",
      } as ScheduledEvent,
      buildTestEnv(),
      createExecutionContext()
    );

    // With no users, scheduler should log "no users due" or "complete" with 0
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("digest.scheduler")
    );
  });
});
