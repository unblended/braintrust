import { env, createExecutionContext } from "cloudflare:test";

import worker from "../src/index";
import type { ClassificationMessage, DigestDeliveryMessage } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("worker queue/scheduled dispatch", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["digest-delivery", "digest-delivery-staging", "digest-delivery-production"])(
    "dispatches %s queue messages",
    async (queueName) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
        return;
      });

      const ackFn = vi.fn();
      const retryFn = vi.fn();
      const testEnv = buildTestEnv({
        DIGEST_DELIVERY_QUEUE_NAME: queueName,
      });

      await worker.queue(
        {
          queue: queueName,
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
        testEnv,
        createExecutionContext()
      );

      // The delivery will fail (no real Slack API),
      // so the consumer should call retry() and log the error
      expect(retryFn).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("digest.delivery_failed")
      );
    }
  );

  it.each([
    "thought-classification",
    "thought-classification-staging",
    "thought-classification-production",
  ])("dispatches %s queue messages", async (queueName) => {
    const ackFn = vi.fn();
    const retryFn = vi.fn();
    const testEnv = buildTestEnv({
      CLASSIFICATION_QUEUE_NAME: queueName,
    });

    await worker.queue(
      {
        queue: queueName,
        messages: [
          {
            id: "msg-classify-1",
            body: {
              thoughtId: "missing-thought",
              userId: "U1",
            },
            ack: ackFn,
            retry: retryFn,
          },
        ],
      } as unknown as MessageBatch<ClassificationMessage>,
      testEnv,
      createExecutionContext()
    );

    // Missing thought is treated as idempotent/no-op and should ack.
    expect(ackFn).toHaveBeenCalled();
    expect(retryFn).not.toHaveBeenCalled();
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
