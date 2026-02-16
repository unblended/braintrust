import { env } from "cloudflare:test";

import { AnalyticsRepository } from "../src/analytics-repository";
import { resetDatabase } from "./helpers/db";

const repository = new AnalyticsRepository();

describe("AnalyticsRepository", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it("logs append-only analytics events with JSON properties", async () => {
    const first = await repository.logEvent(
      env.DB,
      "thought.override",
      "U_ANALYTICS",
      {
        from: "noise",
        to: "action_required",
      }
    );

    const second = await repository.logEvent(
      env.DB,
      "digest.sent",
      "U_ANALYTICS",
      {
        item_count: 3,
      }
    );

    const rows = await env.DB.prepare(
      `SELECT * FROM analytics_events WHERE slack_user_id = ? ORDER BY created_at ASC`
    )
      .bind("U_ANALYTICS")
      .all<{
        id: string;
        event_type: string;
        properties: string;
        created_at: string;
      }>();

    expect(rows.results).toHaveLength(2);

    expect(rows.results[0]?.id).toBe(first.id);
    expect(rows.results[0]?.event_type).toBe("thought.override");
    expect(JSON.parse(rows.results[0]?.properties ?? "{}")).toEqual({
      from: "noise",
      to: "action_required",
    });
    expect(rows.results[0]?.created_at).toMatch(/Z$/);

    expect(rows.results[1]?.id).toBe(second.id);
    expect(rows.results[1]?.event_type).toBe("digest.sent");
    expect(JSON.parse(rows.results[1]?.properties ?? "{}")).toEqual({
      item_count: 3,
    });
  });

  it("counts events by type and user within a time window", async () => {
    const thirtyMinutesAgo = new Date(
      Date.now() - 30 * 60 * 1000
    ).toISOString();

    await repository.logEvent(env.DB, "thought.override", "U_WINDOW", {
      source: "text",
    });
    await repository.logEvent(env.DB, "thought.override", "U_WINDOW", {
      source: "emoji",
    });
    await repository.logEvent(env.DB, "thought.override", "U_OTHER", {
      source: "text",
    });
    await repository.logEvent(env.DB, "digest.sent", "U_WINDOW", {
      item_count: 1,
    });

    const count = await repository.countEventsSince(
      env.DB,
      "thought.override",
      "U_WINDOW",
      thirtyMinutesAgo
    );

    expect(count).toBe(2);
  });

  it("detects digest engagement events by digest message timestamp", async () => {
    await repository.logEvent(env.DB, "digest.engagement", "U_DIGEST", {
      digest_message_ts: "1708099999.111111",
      time_to_first_interaction_ms: 1200,
    });

    await repository.logEvent(env.DB, "digest.engagement", "U_DIGEST", {
      digest_message_ts: "1708099999.222222",
      time_to_first_interaction_ms: 900,
    });

    await env.DB.prepare(
      `INSERT INTO analytics_events (id, event_type, slack_user_id, properties, created_at)
       VALUES (?, 'digest.engagement', ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        "U_DIGEST",
        "not-json",
        new Date().toISOString()
      )
      .run();

    const found = await repository.hasDigestEngagementForMessage(
      env.DB,
      "U_DIGEST",
      "1708099999.111111"
    );
    const missing = await repository.hasDigestEngagementForMessage(
      env.DB,
      "U_DIGEST",
      "1708099999.333333"
    );

    expect(found).toBe(true);
    expect(missing).toBe(false);
  });
});
