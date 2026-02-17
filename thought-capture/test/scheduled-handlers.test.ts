import { env } from "cloudflare:test";

import {
  scheduleDigests,
  purgeExpiredThoughts,
  catchUpUnclassified,
  computeDigestPeriod,
} from "../src/scheduled-handlers";
import type { ClassificationMessage, DigestDeliveryMessage, Env } from "../src/types";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("scheduled handlers", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("scheduleDigests", () => {
    it("enqueues digest delivery for due users", async () => {
      const queueMessages: DigestDeliveryMessage[] = [];
      const queueSend = vi.fn(async (msg: DigestDeliveryMessage) => {
        queueMessages.push(msg);
      });

      // Create a user whose digest is due right now
      // Use a timezone where we can control what day/time it is
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const weekdayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const currentDay = weekdayMap[parts.find((p) => p.type === "weekday")!.value];
      const currentHour = parseInt(parts.find((p) => p.type === "hour")!.value);
      const currentMinute = parseInt(parts.find((p) => p.type === "minute")!.value);

      await env.DB
        .prepare(
          `INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'UTC', 1, ?, ?)`
        )
        .bind(
          "U_DUE",
          currentDay,
          currentHour,
          currentMinute,
          now.toISOString(),
          now.toISOString()
        )
        .run();

      const testEnv = buildTestEnv({
        DIGEST_DELIVERY_QUEUE: { send: queueSend } as unknown as Queue<DigestDeliveryMessage>,
      });

      await scheduleDigests(testEnv);

      expect(queueSend).toHaveBeenCalledTimes(1);
      expect(queueMessages[0].userId).toBe("U_DUE");
      expect(queueMessages[0].periodStart).toBeDefined();
      expect(queueMessages[0].periodEnd).toBeDefined();
    });

    it("skips users who already have a delivery for this period", async () => {
      const queueSend = vi.fn(async (_msg: DigestDeliveryMessage) => {});

      const frozenNow = new Date();
      // Freeze Date so scheduleDigests() computes the same periodStart
      vi.stubGlobal("Date", class extends Date {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(frozenNow.getTime());
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            super(...(args as [any]));
          }
        }
        static now() { return frozenNow.getTime(); }
      });

      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const parts = formatter.formatToParts(frozenNow);
      const weekdayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const currentDay = weekdayMap[parts.find((p) => p.type === "weekday")!.value];
      const currentHour = parseInt(parts.find((p) => p.type === "hour")!.value);
      const currentMinute = parseInt(parts.find((p) => p.type === "minute")!.value);

      // Insert user prefs
      await env.DB
        .prepare(
          `INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'UTC', 1, ?, ?)`
        )
        .bind("U_ALREADY", currentDay, currentHour, currentMinute, frozenNow.toISOString(), frozenNow.toISOString())
        .run();

      // Insert existing delivery for this period
      const { periodStart, periodEnd } = computeDigestPeriod(frozenNow);
      await env.DB
        .prepare(
          `INSERT INTO digest_deliveries (id, slack_user_id, delivered_at, item_count, snoozed_item_count, period_start, period_end)
           VALUES (?, ?, ?, 0, 0, ?, ?)`
        )
        .bind(crypto.randomUUID(), "U_ALREADY", frozenNow.toISOString(), periodStart, periodEnd)
        .run();

      const testEnv = buildTestEnv({
        DIGEST_DELIVERY_QUEUE: { send: queueSend } as unknown as Queue<DigestDeliveryMessage>,
      });

      await scheduleDigests(testEnv);

      expect(queueSend).not.toHaveBeenCalled();
    });

    it("does nothing when feature is disabled", async () => {
      const queueSend = vi.fn(async (_msg: DigestDeliveryMessage) => {});

      const testEnv = buildTestEnv({
        THOUGHT_CAPTURE_V1_ENABLED: "false",
        DIGEST_DELIVERY_QUEUE: { send: queueSend } as unknown as Queue<DigestDeliveryMessage>,
      });

      await scheduleDigests(testEnv);

      expect(queueSend).not.toHaveBeenCalled();
    });
  });

  describe("purgeExpiredThoughts", () => {
    it("purges text for thoughts older than 90 days and deletes records older than 180 days", async () => {
      const now = Date.now();
      const day91Ago = new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString();
      const day181Ago = new Date(now - 181 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();

      // Recent thought — should not be affected
      await insertThought("t-recent", "U1", recent, "recent text", "open");
      // 91-day-old thought — text should be purged
      await insertThought("t-91", "U1", day91Ago, "old text", "open");
      // 91-day-old acted_on — text purged but row preserved
      await insertThought("t-91-acted", "U1", day91Ago, "acted text", "acted_on");
      // 181-day-old noise — should be deleted entirely
      await insertThought("t-181", "U1", day181Ago, null, "open");
      // 181-day-old acted_on — row preserved (not deleted)
      await insertThought("t-181-acted", "U1", day181Ago, null, "acted_on");

      // Insert old analytics event
      await env.DB
        .prepare(
          `INSERT INTO analytics_events (id, event_type, slack_user_id, properties, created_at)
           VALUES (?, 'test', 'U1', '{}', ?)`
        )
        .bind("ae-old", day181Ago)
        .run();

      const testEnv = buildTestEnv();
      await purgeExpiredThoughts(testEnv);

      // Recent thought unchanged
      const recentThought = await env.DB.prepare(
        `SELECT text, text_purged_at FROM thoughts WHERE id = 't-recent'`
      ).first<{ text: string | null; text_purged_at: string | null }>();
      expect(recentThought?.text).toBe("recent text");
      expect(recentThought?.text_purged_at).toBeNull();

      // 91-day-old text purged
      const oldThought = await env.DB.prepare(
        `SELECT text, text_purged_at FROM thoughts WHERE id = 't-91'`
      ).first<{ text: string | null; text_purged_at: string | null }>();
      expect(oldThought?.text).toBeNull();
      expect(oldThought?.text_purged_at).not.toBeNull();

      // 91-day-old acted_on text also purged
      const actedThought = await env.DB.prepare(
        `SELECT text, text_purged_at FROM thoughts WHERE id = 't-91-acted'`
      ).first<{ text: string | null; text_purged_at: string | null }>();
      expect(actedThought?.text).toBeNull();

      // 181-day-old open is deleted
      const deletedThought = await env.DB.prepare(
        `SELECT id FROM thoughts WHERE id = 't-181'`
      ).first();
      expect(deletedThought).toBeNull();

      // 181-day-old acted_on is preserved
      const preservedThought = await env.DB.prepare(
        `SELECT id FROM thoughts WHERE id = 't-181-acted'`
      ).first();
      expect(preservedThought).not.toBeNull();

      // Old analytics event deleted
      const oldAnalytics = await env.DB.prepare(
        `SELECT id FROM analytics_events WHERE id = 'ae-old'`
      ).first();
      expect(oldAnalytics).toBeNull();
    });

    it("does nothing when feature is disabled", async () => {
      await insertThought("t-test", "U1", new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), "text", "open");

      const testEnv = buildTestEnv({ THOUGHT_CAPTURE_V1_ENABLED: "false" });
      await purgeExpiredThoughts(testEnv);

      // Thought should still have text
      const thought = await env.DB.prepare(
        `SELECT text FROM thoughts WHERE id = 't-test'`
      ).first<{ text: string | null }>();
      expect(thought?.text).toBe("text");
    });
  });

  describe("catchUpUnclassified", () => {
    it("re-enqueues stale unclassified thoughts", async () => {
      const queueMessages: ClassificationMessage[] = [];
      const queueSend = vi.fn(async (msg: ClassificationMessage) => {
        queueMessages.push(msg);
      });

      // Thought created 10 minutes ago, still unclassified
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await insertThought("t-stale", "U1", tenMinAgo, "stale thought", "open", "unclassified");

      // Thought created 2 hours ago (too old, should not be picked up)
      const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
      await insertThought("t-too-old", "U1", twoHoursAgo, "too old thought", "open", "unclassified");

      // Thought created 1 minute ago (too recent, should not be picked up)
      const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
      await insertThought("t-fresh", "U1", oneMinAgo, "fresh thought", "open", "unclassified");

      // Already classified thought (should not be picked up)
      await insertThought("t-classified", "U1", tenMinAgo, "classified thought", "open", "action_required");

      const testEnv = buildTestEnv({
        CLASSIFICATION_QUEUE: { send: queueSend } as unknown as Queue<ClassificationMessage>,
      });

      await catchUpUnclassified(testEnv);

      expect(queueSend).toHaveBeenCalledTimes(1);
      expect(queueMessages[0]).toEqual({
        thoughtId: "t-stale",
        userId: "U1",
      });
    });

    it("does nothing when no stale thoughts exist", async () => {
      const queueSend = vi.fn(async (_msg: ClassificationMessage) => {});

      const testEnv = buildTestEnv({
        CLASSIFICATION_QUEUE: { send: queueSend } as unknown as Queue<ClassificationMessage>,
      });

      await catchUpUnclassified(testEnv);

      expect(queueSend).not.toHaveBeenCalled();
    });
  });

  describe("computeDigestPeriod", () => {
    it("returns a 7-day period ending at now", () => {
      const now = new Date("2026-02-16T09:00:00.000Z");
      const { periodStart, periodEnd } = computeDigestPeriod(now);

      expect(periodEnd).toBe("2026-02-16T09:00:00.000Z");
      expect(periodStart).toBe("2026-02-09T09:00:00.000Z");
    });
  });
});

async function insertThought(
  id: string,
  userId: string,
  createdAt: string,
  text: string | null,
  status: string,
  classification: string = "action_required"
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'llm', ?, ?)`
    )
    .bind(id, userId, `ts-${id}`, text, classification, status, createdAt)
    .run();
}
