/**
 * AnalyticsRepository — append-only analytics event logging.
 */

export interface AnalyticsEvent {
  id: string;
  event_type: string;
  slack_user_id: string;
  properties: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

export class AnalyticsRepository {
  /**
   * Append an analytics event row.
   */
  async logEvent(
    db: D1Database,
    type: string,
    userId: string,
    properties: Record<string, unknown> = {}
  ): Promise<AnalyticsEvent> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const serializedProperties = JSON.stringify(properties);

    await db
      .prepare(
        `INSERT INTO analytics_events (id, event_type, slack_user_id, properties, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, type, userId, serializedProperties, createdAt)
      .run();

    return {
      id,
      event_type: type,
      slack_user_id: userId,
      properties: serializedProperties,
      created_at: createdAt,
    };
  }

  async countEventsSince(
    db: D1Database,
    type: string,
    userId: string,
    since: string
  ): Promise<number> {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM analytics_events
         WHERE event_type = ?
           AND slack_user_id = ?
           AND created_at >= ?`
      )
      .bind(type, userId, since)
      .first<CountRow>();

    return Number(row?.count ?? 0);
  }

  async hasDigestEngagementForMessage(
    db: D1Database,
    userId: string,
    digestMessageTs: string
  ): Promise<boolean> {
    const token = `\"digest_message_ts\":\"${escapeLikePattern(
      digestMessageTs
    )}\"`;

    const row = await db
      .prepare(
        `SELECT 1
          FROM analytics_events
          WHERE event_type = 'digest.engagement'
            AND slack_user_id = ?
            AND properties LIKE ? ESCAPE '\\'
          LIMIT 1`
      )
      .bind(userId, `%${token}%`)
      .first();

    return row !== null;
  }
}

function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}
