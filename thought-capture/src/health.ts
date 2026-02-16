import type { Env } from "./types";

interface ClassificationCountRow {
  classification: string;
  count: number;
}

interface CountRow {
  count: number;
}

interface OverrideRateRow {
  override_rate: number | null;
}

interface DigestEngagementRateRow {
  digest_engagement_rate: number | null;
}

export async function getHealthStatus(env: Env): Promise<Response> {
  const now = new Date();
  const sevenDaysAgo = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  const fourteenDaysAgo = new Date(
    now.getTime() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const [
    totalThoughtsRow,
    classificationCounts,
    activeUsersRow,
    overrideRateRow,
    digestEngagementRateRow,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM thoughts`).first<CountRow>(),
    env.DB.prepare(
      `SELECT classification, COUNT(*) AS count
       FROM thoughts
       GROUP BY classification`
    ).all<ClassificationCountRow>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT slack_user_id) AS count
       FROM analytics_events
       WHERE event_type = 'thought.captured'
         AND created_at >= ?`
    )
      .bind(fourteenDaysAgo)
      .first<CountRow>(),
    env.DB.prepare(
      // Spec allows override rate to be derived from either thoughts rows or
      // analytics events. We use analytics events so health metrics are based
      // on emitted business telemetry in the same window.
      `SELECT
         CASE
           WHEN classified_count = 0 THEN NULL
           ELSE CAST(overrides_count AS REAL) / CAST(classified_count AS REAL)
         END AS override_rate
       FROM (
         SELECT
           COALESCE(SUM(CASE WHEN event_type = 'thought.classified' THEN 1 ELSE 0 END), 0) AS classified_count,
           COALESCE(SUM(CASE WHEN event_type = 'thought.override' THEN 1 ELSE 0 END), 0) AS overrides_count
         FROM analytics_events
         WHERE created_at >= ?
       )`
    )
      .bind(sevenDaysAgo)
      .first<OverrideRateRow>(),
    env.DB.prepare(
      `SELECT
         CASE
           WHEN sent_count = 0 THEN NULL
           ELSE CAST(engagement_count AS REAL) / CAST(sent_count AS REAL)
         END AS digest_engagement_rate
       FROM (
         SELECT
           COALESCE(SUM(CASE WHEN event_type = 'digest.sent' THEN 1 ELSE 0 END), 0) AS sent_count,
           COALESCE(SUM(CASE WHEN event_type = 'digest.engagement' THEN 1 ELSE 0 END), 0) AS engagement_count
         FROM analytics_events
         WHERE created_at >= ?
       )`
    )
      .bind(sevenDaysAgo)
      .first<DigestEngagementRateRow>(),
  ]);

  const counts: Record<string, number> = {
    unclassified: 0,
    action_required: 0,
    reference: 0,
    noise: 0,
  };

  for (const row of classificationCounts.results) {
    counts[row.classification] = Number(row.count);
  }

  return jsonResponse({
    status: "ok",
    timestamp: now.toISOString(),
    metrics: {
      total_thoughts: Number(totalThoughtsRow?.count ?? 0),
      classifications: counts,
      active_users_14d: Number(activeUsersRow?.count ?? 0),
      override_rate_7d: Number(overrideRateRow?.override_rate ?? 0),
      digest_engagement_rate_7d: Number(
        digestEngagementRateRow?.digest_engagement_rate ?? 0
      ),
    },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
