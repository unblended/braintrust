import { env } from "cloudflare:test";

import {
  UserPrefsRepository,
  isDigestDue,
  type UserPrefs,
} from "../src/user-prefs-repository";
import { resetDatabase } from "./helpers/db";

const repository = new UserPrefsRepository();

describe("UserPrefsRepository", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it("upserts and fetches preferences by user id", async () => {
    const saved = await repository.upsert(env.DB, {
      slackUserId: "U_PREF_1",
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
      timezone: "America/New_York",
    });

    expect(saved.slack_user_id).toBe("U_PREF_1");
    expect(saved.digest_day).toBe(1);
    expect(saved.digest_hour).toBe(9);
    expect(saved.digest_minute).toBe(0);
    expect(saved.timezone).toBe("America/New_York");
    expect(saved.welcomed).toBe(0);
    expect(saved.created_at).toMatch(/Z$/);
    expect(saved.updated_at).toMatch(/Z$/);

    const fetched = await repository.findByUserId(env.DB, "U_PREF_1");

    expect(fetched).not.toBeNull();
    expect(fetched?.slack_user_id).toBe("U_PREF_1");
  });

  it("updates existing prefs while preserving created_at", async () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-01T00:00:00.000Z";

    await env.DB.prepare(
      `INSERT INTO user_prefs (
        slack_user_id, digest_day, digest_hour, digest_minute,
        timezone, welcomed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "U_PREF_2",
        1,
        9,
        0,
        "America/New_York",
        0,
        createdAt,
        updatedAt
      )
      .run();

    const saved = await repository.upsert(env.DB, {
      slackUserId: "U_PREF_2",
      digestDay: 2,
      digestHour: 11,
      digestMinute: 30,
      timezone: "America/Los_Angeles",
      welcomed: 1,
    });

    expect(saved.slack_user_id).toBe("U_PREF_2");
    expect(saved.created_at).toBe(createdAt);
    expect(saved.updated_at).not.toBe(updatedAt);
    expect(saved.digest_day).toBe(2);
    expect(saved.digest_hour).toBe(11);
    expect(saved.digest_minute).toBe(30);
    expect(saved.timezone).toBe("America/Los_Angeles");
    expect(saved.welcomed).toBe(1);
  });

  it("finds due users across timezones using isDigestDue", async () => {
    await repository.upsert(env.DB, {
      slackUserId: "U_NY",
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
      timezone: "America/New_York",
    });

    await repository.upsert(env.DB, {
      slackUserId: "U_LA",
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
      timezone: "America/Los_Angeles",
    });

    await repository.upsert(env.DB, {
      slackUserId: "U_LONDON",
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
      timezone: "Europe/London",
    });

    await repository.upsert(env.DB, {
      slackUserId: "U_TOKYO",
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
      timezone: "Asia/Tokyo",
    });

    const now = new Date("2026-01-05T14:07:00.000Z");
    const allPrefs = await repository.findAllPrefs(env.DB);

    const dueUserIds = allPrefs
      .filter((prefs) => isDigestDue(prefs, now))
      .map((prefs) => prefs.slack_user_id);

    expect(dueUserIds).toEqual(["U_NY"]);
  });
});

describe("isDigestDue", () => {
  it("returns true within the configured 15-minute window", () => {
    const prefs = digestPrefs({
      digest_day: 1,
      digest_hour: 10,
      digest_minute: 30,
      timezone: "UTC",
    });

    expect(isDigestDue(prefs, new Date("2026-01-05T10:30:00.000Z"))).toBe(true);
    expect(isDigestDue(prefs, new Date("2026-01-05T10:44:59.000Z"))).toBe(true);
  });

  it("returns false outside the configured window", () => {
    const prefs = digestPrefs({
      digest_day: 1,
      digest_hour: 10,
      digest_minute: 30,
      timezone: "UTC",
    });

    expect(isDigestDue(prefs, new Date("2026-01-05T10:29:00.000Z"))).toBe(false);
    expect(isDigestDue(prefs, new Date("2026-01-05T10:45:00.000Z"))).toBe(false);
  });

  it("supports digest windows that cross an hour boundary", () => {
    const prefs = digestPrefs({
      digest_day: 1,
      digest_hour: 23,
      digest_minute: 55,
      timezone: "UTC",
    });

    expect(isDigestDue(prefs, new Date("2026-01-05T23:59:00.000Z"))).toBe(true);
    expect(isDigestDue(prefs, new Date("2026-01-06T00:05:00.000Z"))).toBe(true);
    expect(isDigestDue(prefs, new Date("2026-01-06T00:10:00.000Z"))).toBe(false);
  });

  it("handles daylight saving offsets for America/New_York", () => {
    const prefs = digestPrefs({
      digest_day: 1,
      digest_hour: 9,
      digest_minute: 0,
      timezone: "America/New_York",
    });

    // Winter (EST, UTC-5)
    expect(isDigestDue(prefs, new Date("2026-01-05T14:05:00.000Z"))).toBe(true);

    // Summer (EDT, UTC-4)
    expect(isDigestDue(prefs, new Date("2026-06-01T13:05:00.000Z"))).toBe(true);
  });

  it("returns false when timezone is invalid", () => {
    const prefs = digestPrefs({
      digest_day: 1,
      digest_hour: 9,
      digest_minute: 0,
      timezone: "Not/A_Real_Timezone",
    });

    expect(isDigestDue(prefs, new Date("2026-01-05T14:05:00.000Z"))).toBe(false);
  });

  it("returns false when digest schedule fields are invalid", () => {
    const prefs = digestPrefs({
      digest_day: 7,
      digest_hour: 24,
      digest_minute: 60,
      timezone: "UTC",
    });

    expect(isDigestDue(prefs, new Date("2026-01-05T14:05:00.000Z"))).toBe(false);
  });
});

function digestPrefs(
  overrides: Pick<
    UserPrefs,
    "digest_day" | "digest_hour" | "digest_minute" | "timezone"
  >
): Pick<UserPrefs, "digest_day" | "digest_hour" | "digest_minute" | "timezone"> {
  return overrides;
}
