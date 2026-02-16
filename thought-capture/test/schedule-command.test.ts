import { env } from "cloudflare:test";

import {
  handleScheduleCommand,
  parseScheduleCommandText,
} from "../src/schedule-command";
import { resetDatabase } from "./helpers/db";
import { buildTestEnv } from "./helpers/slack";

describe("parseScheduleCommandText", () => {
  it("parses valid day and time values", () => {
    expect(parseScheduleCommandText("schedule monday 9:00")).toEqual({
      digestDay: 1,
      digestHour: 9,
      digestMinute: 0,
    });
    expect(parseScheduleCommandText("schedule Friday 14:30")).toEqual({
      digestDay: 5,
      digestHour: 14,
      digestMinute: 30,
    });
    expect(parseScheduleCommandText("schedule sunday 0:00")).toEqual({
      digestDay: 0,
      digestHour: 0,
      digestMinute: 0,
    });
  });

  it("rejects invalid schedule formats", () => {
    expect(parseScheduleCommandText("schedule funday 25:00")).toBeNull();
    expect(parseScheduleCommandText("schedule monday")).toBeNull();
    expect(parseScheduleCommandText("")).toBeNull();
  });
});

describe("handleScheduleCommand", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates digest schedule in D1 for valid input", async () => {
    stubTimezoneFetch("America/Los_Angeles");

    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
    });
    const body = new URLSearchParams({
      command: "/thoughtcapture",
      text: "schedule friday 14:30",
      user_id: "U_ENABLED",
    }).toString();

    const response = await handleScheduleCommand(body, testEnv);
    const responseJson = (await response.json()) as {
      response_type: string;
      text: string;
    };

    expect(response.status).toBe(200);
    expect(responseJson.response_type).toBe("ephemeral");
    expect(responseJson.text).toContain("Friday");
    expect(responseJson.text).toContain("2:30 PM");
    expect(responseJson.text).toContain("America/Los_Angeles");

    const prefs = await env.DB.prepare(
      `SELECT digest_day, digest_hour, digest_minute, timezone
       FROM user_prefs
       WHERE slack_user_id = ?`
    )
      .bind("U_ENABLED")
      .first<{
        digest_day: number;
        digest_hour: number;
        digest_minute: number;
        timezone: string;
      }>();

    expect(prefs).toEqual({
      digest_day: 5,
      digest_hour: 14,
      digest_minute: 30,
      timezone: "America/Los_Angeles",
    });
  });

  it("returns usage help for invalid command input", async () => {
    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
    });
    const body = new URLSearchParams({
      command: "/thoughtcapture",
      text: "schedule monday",
      user_id: "U_ENABLED",
    }).toString();

    const response = await handleScheduleCommand(body, testEnv);
    const responseJson = (await response.json()) as { text: string };

    expect(response.status).toBe(200);
    expect(responseJson.text).toContain("Usage:");
  });

  it("rejects non-allowlisted users", async () => {
    const testEnv = buildTestEnv({
      ENABLED_USER_IDS: "U_ENABLED",
    });
    const body = new URLSearchParams({
      command: "/thoughtcapture",
      text: "schedule monday 9:00",
      user_id: "U_OTHER",
    }).toString();

    const response = await handleScheduleCommand(body, testEnv);
    const responseJson = (await response.json()) as { text: string };

    expect(response.status).toBe(200);
    expect(responseJson.text).toContain("private beta");

    const prefsCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM user_prefs WHERE slack_user_id = ?`
    )
      .bind("U_OTHER")
      .first<{ count: number }>();

    expect(Number(prefsCount?.count ?? 0)).toBe(0);
  });
});

function stubTimezoneFetch(timezone: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: "U_ENABLED",
            tz: timezone,
            tz_label: "Test",
            tz_offset: 0,
          },
        }),
        { status: 200 }
      );
    })
  );
}
