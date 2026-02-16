import { env } from "cloudflare:test";

import { ThoughtRepository } from "../src/thought-repository";
import { resetDatabase } from "./helpers/db";

const repository = new ThoughtRepository();

describe("ThoughtRepository", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it("inserts thoughts idempotently by slack_message_ts", async () => {
    const inserted = await repository.insert(env.DB, {
      slackUserId: "U123",
      slackMessageTs: "1708012345.123456",
      text: "first thought",
    });

    expect(inserted).not.toBeNull();

    const duplicate = await repository.insert(env.DB, {
      slackUserId: "U123",
      slackMessageTs: "1708012345.123456",
      text: "duplicate thought",
    });

    expect(duplicate).toBeNull();

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM thoughts WHERE slack_message_ts = ?`
    )
      .bind("1708012345.123456")
      .first<{ count: number }>();

    expect(Number(row?.count ?? 0)).toBe(1);
  });

  it("stores and finds thoughts by bot reply timestamp", async () => {
    const inserted = await repository.insert(env.DB, {
      slackUserId: "U234",
      slackMessageTs: "1708013000.222222",
      text: "needs follow-up",
    });

    expect(inserted).not.toBeNull();
    if (!inserted) {
      return;
    }

    await repository.updateBotReplyTs(env.DB, inserted.id, "1708013010.333333");

    const found = await repository.findByBotReplyTs(env.DB, "1708013010.333333");

    expect(found?.id).toBe(inserted.id);
    expect(found?.slack_user_id).toBe("U234");
  });

  it("updates status to snoozed with snooze_until", async () => {
    const inserted = await repository.insert(env.DB, {
      slackUserId: "U345",
      slackMessageTs: "1708013500.444444",
      text: "snooze this",
    });

    expect(inserted).not.toBeNull();
    if (!inserted) {
      return;
    }

    const snoozeUntil = "2026-03-01T10:00:00.000Z";
    const updated = await repository.updateStatus(
      env.DB,
      inserted.id,
      "snoozed",
      snoozeUntil
    );

    expect(updated).toBe(true);

    const row = await repository.findById(env.DB, inserted.id);
    expect(row?.status).toBe("snoozed");
    expect(row?.snooze_until).toBe(snoozeUntil);
    expect(row?.status_changed_at).not.toBeNull();
  });

  it("does not transition from terminal statuses", async () => {
    await insertThoughtRow({
      id: "terminal-thought",
      userId: "U_TERMINAL",
      ts: "1708013550.444444",
      text: "already acted on",
      classification: "action_required",
      status: "acted_on",
      createdAt: "2026-01-05T10:00:00.000Z",
    });

    const transitioned = await repository.updateStatus(
      env.DB,
      "terminal-thought",
      "snoozed",
      "2026-01-12T10:00:00.000Z"
    );

    expect(transitioned).toBe(false);

    const row = await repository.findById(env.DB, "terminal-thought");
    expect(row?.status).toBe("acted_on");
    expect(row?.snooze_until).toBeNull();
  });

  it("purges 90-day text and deletes 180-day non-acted_on rows", async () => {
    const now = Date.now();
    const ninetyOneDaysAgo = new Date(
      now - 91 * 24 * 60 * 60 * 1000
    ).toISOString();
    const oneEightyOneDaysAgo = new Date(
      now - 181 * 24 * 60 * 60 * 1000
    ).toISOString();

    await insertThoughtRow({
      id: "purge-target",
      userId: "U456",
      ts: "1708013600.555555",
      text: "text to purge",
      classification: "reference",
      status: "open",
      createdAt: ninetyOneDaysAgo,
    });

    await insertThoughtRow({
      id: "delete-target",
      userId: "U456",
      ts: "1708013700.666666",
      text: "text to delete",
      classification: "noise",
      status: "dismissed",
      createdAt: oneEightyOneDaysAgo,
    });

    await insertThoughtRow({
      id: "acted-on-kept",
      userId: "U456",
      ts: "1708013800.777777",
      text: "acted on keep metadata",
      classification: "action_required",
      status: "acted_on",
      createdAt: oneEightyOneDaysAgo,
    });

    const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff180 = new Date(
      now - 180 * 24 * 60 * 60 * 1000
    ).toISOString();

    const result = await repository.purgeExpiredText(env.DB, cutoff90, cutoff180);

    // Purge runs before delete, so all three inserted rows have text cleared.
    expect(result.textsPurged).toBe(3);
    expect(result.recordsDeleted).toBe(1);

    const purged = await repository.findById(env.DB, "purge-target");
    expect(purged?.text).toBeNull();
    expect(purged?.text_purged_at).not.toBeNull();

    const deleted = await repository.findById(env.DB, "delete-target");
    expect(deleted).toBeNull();

    const actedOnKept = await repository.findById(env.DB, "acted-on-kept");
    expect(actedOnKept).not.toBeNull();
    expect(actedOnKept?.text).toBeNull();
    expect(actedOnKept?.status).toBe("acted_on");
  });

  it("finds thoughts by user and period in ascending created order", async () => {
    await insertThoughtRow({
      id: "period-in-1",
      userId: "U_PERIOD",
      ts: "1708014000.111111",
      text: "inside one",
      classification: "unclassified",
      status: "open",
      createdAt: "2026-01-05T09:00:00.000Z",
    });
    await insertThoughtRow({
      id: "period-in-2",
      userId: "U_PERIOD",
      ts: "1708014100.111111",
      text: "inside two",
      classification: "action_required",
      status: "open",
      createdAt: "2026-01-05T11:00:00.000Z",
    });
    await insertThoughtRow({
      id: "period-out-user",
      userId: "U_OTHER",
      ts: "1708014200.111111",
      text: "other user",
      classification: "reference",
      status: "open",
      createdAt: "2026-01-05T10:00:00.000Z",
    });
    await insertThoughtRow({
      id: "period-out-time",
      userId: "U_PERIOD",
      ts: "1708014300.111111",
      text: "outside time",
      classification: "noise",
      status: "dismissed",
      createdAt: "2026-01-06T00:00:00.000Z",
    });

    const results = await repository.findByUserAndPeriod(
      env.DB,
      "U_PERIOD",
      "2026-01-05T08:00:00.000Z",
      "2026-01-05T12:00:00.000Z"
    );

    expect(results.map((row) => row.id)).toEqual(["period-in-1", "period-in-2"]);
  });

  it("finds by message timestamp and returns null when missing", async () => {
    await insertThoughtRow({
      id: "by-ts",
      userId: "U_TS",
      ts: "1708014400.111111",
      text: "lookup by ts",
      classification: "unclassified",
      status: "open",
      createdAt: "2026-01-05T10:00:00.000Z",
    });

    const found = await repository.findByMessageTs(env.DB, "1708014400.111111");
    const missing = await repository.findByMessageTs(env.DB, "1708014400.999999");

    expect(found?.id).toBe("by-ts");
    expect(missing).toBeNull();
  });

  it("counts thoughts by user since a timestamp", async () => {
    await insertThoughtRow({
      id: "count-since-old",
      userId: "U_COUNT_SINCE",
      ts: "1708014410.111111",
      text: "old",
      classification: "reference",
      status: "open",
      createdAt: "2026-01-05T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "count-since-new-1",
      userId: "U_COUNT_SINCE",
      ts: "1708014420.111111",
      text: "new 1",
      classification: "reference",
      status: "open",
      createdAt: "2026-01-05T10:00:00.000Z",
    });
    await insertThoughtRow({
      id: "count-since-new-2",
      userId: "U_COUNT_SINCE",
      ts: "1708014430.111111",
      text: "new 2",
      classification: "noise",
      status: "dismissed",
      createdAt: "2026-01-05T11:00:00.000Z",
    });
    await insertThoughtRow({
      id: "count-since-other-user",
      userId: "U_OTHER",
      ts: "1708014440.111111",
      text: "other user",
      classification: "noise",
      status: "open",
      createdAt: "2026-01-05T11:00:00.000Z",
    });

    const count = await repository.countByUserSince(
      env.DB,
      "U_COUNT_SINCE",
      "2026-01-05T09:30:00.000Z"
    );

    expect(count).toBe(2);
  });

  it("finds most recent thought by user within 24h and excludes message ts", async () => {
    const now = Date.now();
    const old = new Date(now - 26 * 60 * 60 * 1000).toISOString();
    const recentOne = new Date(now - 60 * 60 * 1000).toISOString();
    const recentTwo = new Date(now - 30 * 60 * 1000).toISOString();

    await insertThoughtRow({
      id: "recent-old",
      userId: "U_RECENT",
      ts: "1708014500.111111",
      text: "too old",
      classification: "reference",
      status: "open",
      createdAt: old,
    });
    await insertThoughtRow({
      id: "recent-1",
      userId: "U_RECENT",
      ts: "1708014600.111111",
      text: "recent 1",
      classification: "reference",
      status: "open",
      createdAt: recentOne,
    });
    await insertThoughtRow({
      id: "recent-2",
      userId: "U_RECENT",
      ts: "1708014700.111111",
      text: "recent 2",
      classification: "reference",
      status: "open",
      createdAt: recentTwo,
    });

    const found = await repository.findMostRecentByUser(
      env.DB,
      "U_RECENT",
      "1708014700.111111"
    );

    expect(found?.id).toBe("recent-1");
  });

  it("updates classification once and enforces optimistic concurrency guard", async () => {
    const inserted = await repository.insert(env.DB, {
      slackUserId: "U_CLASSIFY",
      slackMessageTs: "1708014800.111111",
      text: "classify once",
    });

    expect(inserted).not.toBeNull();
    if (!inserted) {
      return;
    }

    const first = await repository.updateClassification(
      env.DB,
      inserted.id,
      "action_required",
      "llm",
      "gpt-4o-mini",
      1200
    );
    const second = await repository.updateClassification(
      env.DB,
      inserted.id,
      "noise",
      "llm",
      "gpt-4o-mini",
      1400
    );

    expect(first).toBe(true);
    expect(second).toBe(false);

    const stored = await repository.findById(env.DB, inserted.id);
    expect(stored?.classification).toBe("action_required");
    expect(stored?.classification_source).toBe("llm");
    expect(stored?.classification_model).toBe("gpt-4o-mini");
    expect(stored?.classified_at).not.toBeNull();
  });

  it("overrides classification and marks source as user_override", async () => {
    const inserted = await repository.insert(env.DB, {
      slackUserId: "U_OVERRIDE",
      slackMessageTs: "1708014900.111111",
      text: "override me",
    });

    expect(inserted).not.toBeNull();
    if (!inserted) {
      return;
    }

    const classified = await repository.updateClassification(
      env.DB,
      inserted.id,
      "reference",
      "llm",
      "gpt-4o-mini",
      900
    );
    expect(classified).toBe(true);

    const updated = await repository.overrideClassification(
      env.DB,
      inserted.id,
      "action_required"
    );
    expect(updated).toBe(true);

    const stored = await repository.findById(env.DB, inserted.id);
    expect(stored?.classification).toBe("action_required");
    expect(stored?.classification_source).toBe("user_override");
    expect(stored?.classified_at).not.toBeNull();
    expect(stored?.status_changed_at).not.toBeNull();
  });

  it("finds digest items from action, snoozed-due, and unclassified buckets", async () => {
    const now = "2026-02-01T12:00:00.000Z";
    const periodStart = "2026-01-26T00:00:00.000Z";
    const periodEnd = "2026-02-02T00:00:00.000Z";

    await insertThoughtRow({
      id: "digest-action",
      userId: "U_DIGEST",
      ts: "1708015000.111111",
      text: "action item",
      classification: "action_required",
      status: "open",
      createdAt: "2026-01-30T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-action-outside",
      userId: "U_DIGEST",
      ts: "1708015100.111111",
      text: "outside period",
      classification: "action_required",
      status: "open",
      createdAt: "2026-02-05T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-snoozed-due",
      userId: "U_DIGEST",
      ts: "1708015200.111111",
      text: "snoozed due",
      classification: "reference",
      status: "snoozed",
      snoozeUntil: "2026-02-01T11:59:00.000Z",
      createdAt: "2026-01-20T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-snoozed-future",
      userId: "U_DIGEST",
      ts: "1708015300.111111",
      text: "snoozed future",
      classification: "reference",
      status: "snoozed",
      snoozeUntil: "2026-02-01T12:01:00.000Z",
      createdAt: "2026-01-20T09:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-unclassified",
      userId: "U_DIGEST",
      ts: "1708015400.111111",
      text: "needs review",
      classification: "unclassified",
      status: "open",
      createdAt: "2026-01-29T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-unclassified-old",
      userId: "U_DIGEST",
      ts: "1708015450.111111",
      text: "old unclassified",
      classification: "unclassified",
      status: "open",
      createdAt: "2025-11-15T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-unclassified-future",
      userId: "U_DIGEST",
      ts: "1708015460.111111",
      text: "future unclassified",
      classification: "unclassified",
      status: "open",
      createdAt: "2026-02-05T08:00:00.000Z",
    });
    await insertThoughtRow({
      id: "digest-ignore-reference",
      userId: "U_DIGEST",
      ts: "1708015500.111111",
      text: "reference",
      classification: "reference",
      status: "open",
      createdAt: "2026-01-29T09:00:00.000Z",
    });

    const results = await repository.findDigestItems(
      env.DB,
      "U_DIGEST",
      periodStart,
      periodEnd,
      now
    );

    expect(results.map((row) => row.id)).toEqual([
      "digest-snoozed-due",
      "digest-unclassified",
      "digest-action",
    ]);
  });

  it("counts thoughts by classification for a user in a period", async () => {
    await insertThoughtRow({
      id: "count-a1",
      userId: "U_COUNT",
      ts: "1708015600.111111",
      text: "a1",
      classification: "action_required",
      status: "open",
      createdAt: "2026-01-10T10:00:00.000Z",
    });
    await insertThoughtRow({
      id: "count-a2",
      userId: "U_COUNT",
      ts: "1708015700.111111",
      text: "a2",
      classification: "action_required",
      status: "open",
      createdAt: "2026-01-10T10:05:00.000Z",
    });
    await insertThoughtRow({
      id: "count-r",
      userId: "U_COUNT",
      ts: "1708015800.111111",
      text: "r",
      classification: "reference",
      status: "open",
      createdAt: "2026-01-10T10:10:00.000Z",
    });
    await insertThoughtRow({
      id: "count-n",
      userId: "U_COUNT",
      ts: "1708015900.111111",
      text: "n",
      classification: "noise",
      status: "dismissed",
      createdAt: "2026-01-10T10:15:00.000Z",
    });
    await insertThoughtRow({
      id: "count-outside",
      userId: "U_COUNT",
      ts: "1708016000.111111",
      text: "outside",
      classification: "noise",
      status: "dismissed",
      createdAt: "2026-01-12T10:15:00.000Z",
    });

    const counts = await repository.countByClassification(
      env.DB,
      "U_COUNT",
      "2026-01-10T00:00:00.000Z",
      "2026-01-11T00:00:00.000Z"
    );

    expect(counts.action_required).toBe(2);
    expect(counts.reference).toBe(1);
    expect(counts.noise).toBe(1);
    expect(counts.unclassified).toBeUndefined();
  });

  it("finds stale unclassified thoughts between 5 minutes and 1 hour", async () => {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const twoMinutesAgo = new Date(now - 2 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

    await insertThoughtRow({
      id: "stale-match",
      userId: "U_STALE",
      ts: "1708016100.111111",
      text: "stale",
      classification: "unclassified",
      status: "open",
      createdAt: tenMinutesAgo,
    });
    await insertThoughtRow({
      id: "stale-too-new",
      userId: "U_STALE",
      ts: "1708016200.111111",
      text: "too new",
      classification: "unclassified",
      status: "open",
      createdAt: twoMinutesAgo,
    });
    await insertThoughtRow({
      id: "stale-too-old",
      userId: "U_STALE",
      ts: "1708016300.111111",
      text: "too old",
      classification: "unclassified",
      status: "open",
      createdAt: twoHoursAgo,
    });
    await insertThoughtRow({
      id: "stale-classified",
      userId: "U_STALE",
      ts: "1708016400.111111",
      text: "classified",
      classification: "reference",
      status: "open",
      createdAt: tenMinutesAgo,
    });

    const stale = await repository.findStaleUnclassified(
      env.DB,
      new Date(now - 5 * 60 * 1000).toISOString(),
      new Date(now - 60 * 60 * 1000).toISOString()
    );

    expect(stale).toEqual([
      {
        id: "stale-match",
        slack_user_id: "U_STALE",
      },
    ]);
  });
});

async function insertThoughtRow(params: {
  id: string;
  userId: string;
  ts: string;
  text: string;
  classification: "unclassified" | "action_required" | "reference" | "noise";
  classificationSource?: "pending" | "llm" | "user_override";
  status: "open" | "acted_on" | "snoozed" | "dismissed";
  snoozeUntil?: string | null;
  createdAt: string;
}): Promise<void> {
  const classificationSource = params.classificationSource ?? "pending";
  const snoozeUntil = params.snoozeUntil ?? null;

  await env.DB.prepare(
    `INSERT INTO thoughts (
      id, slack_user_id, slack_message_ts, text,
      classification, classification_source, status, snooze_until, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.id,
      params.userId,
      params.ts,
      params.text,
      params.classification,
      classificationSource,
      params.status,
      snoozeUntil,
      params.createdAt
    )
    .run();
}
