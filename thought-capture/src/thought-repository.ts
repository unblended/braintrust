/**
 * ThoughtRepository — CRUD + query operations for the thoughts table.
 * All methods accept the D1 database binding as the first argument.
 * UUIDs generated via crypto.randomUUID(). Timestamps via new Date().toISOString().
 */

export interface Thought {
  id: string;
  slack_user_id: string;
  slack_message_ts: string;
  text: string | null;
  classification: "unclassified" | "action_required" | "reference" | "noise";
  classification_source: "pending" | "llm" | "user_override";
  classification_model: string | null;
  classification_latency_ms: number | null;
  status: "open" | "acted_on" | "snoozed" | "dismissed";
  snooze_until: string | null;
  created_at: string;
  classified_at: string | null;
  status_changed_at: string | null;
  text_purged_at: string | null;
  bot_reply_ts: string | null;
}

export interface InsertThoughtParams {
  slackUserId: string;
  slackMessageTs: string;
  text: string;
}

const UNCLASSIFIED_DIGEST_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export class ThoughtRepository {
  /**
   * Insert a new thought. Idempotent via ON CONFLICT (slack_message_ts) DO NOTHING.
   * Returns the thought if inserted, null if duplicate.
   */
  async insert(db: D1Database, params: InsertThoughtParams): Promise<Thought | null> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const result = await db
      .prepare(
        `INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
         VALUES (?, ?, ?, ?, 'unclassified', 'pending', 'open', ?)
         ON CONFLICT (slack_message_ts) DO NOTHING`
      )
      .bind(id, params.slackUserId, params.slackMessageTs, params.text, now)
      .run();

    if (result.meta.changes === 0) {
      return null; // Duplicate — silently dropped
    }

    return {
      id,
      slack_user_id: params.slackUserId,
      slack_message_ts: params.slackMessageTs,
      text: params.text,
      classification: "unclassified",
      classification_source: "pending",
      classification_model: null,
      classification_latency_ms: null,
      status: "open",
      snooze_until: null,
      created_at: now,
      classified_at: null,
      status_changed_at: null,
      text_purged_at: null,
      bot_reply_ts: null,
    };
  }

  /**
   * Find thoughts by user within a time period.
   */
  async findByUserAndPeriod(
    db: D1Database,
    userId: string,
    start: string,
    end: string
  ): Promise<Thought[]> {
    const result = await db
      .prepare(
        `SELECT * FROM thoughts
         WHERE slack_user_id = ?
           AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`
      )
      .bind(userId, start, end)
      .all<Thought>();

    return result.results;
  }

  /**
   * Find a thought by its Slack message timestamp.
   */
  async findByMessageTs(db: D1Database, ts: string): Promise<Thought | null> {
    const result = await db
      .prepare(`SELECT * FROM thoughts WHERE slack_message_ts = ?`)
      .bind(ts)
      .first<Thought>();

    return result ?? null;
  }

  /**
   * Count thoughts for a user since a timestamp.
   * Used for per-user rate limiting.
   */
  async countByUserSince(
    db: D1Database,
    userId: string,
    since: string
  ): Promise<number> {
    const result = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM thoughts
         WHERE slack_user_id = ?
           AND created_at > ?`
      )
      .bind(userId, since)
      .first<{ count: number }>();

    return Number(result?.count ?? 0);
  }

  /**
   * Find a thought by the bot's reply message timestamp.
   * Used for emoji reaction override lookup.
   */
  async findByBotReplyTs(db: D1Database, ts: string): Promise<Thought | null> {
    const result = await db
      .prepare(`SELECT * FROM thoughts WHERE bot_reply_ts = ?`)
      .bind(ts)
      .first<Thought>();

    return result ?? null;
  }

  /**
   * Find a thought by ID.
   */
  async findById(db: D1Database, id: string): Promise<Thought | null> {
    const result = await db
      .prepare(`SELECT * FROM thoughts WHERE id = ?`)
      .bind(id)
      .first<Thought>();

    return result ?? null;
  }

  /**
   * Find the most recent thought by a user (within 24 hours), excluding a specific message.
   * Used for text override to find what thought to reclassify.
   */
  async findMostRecentByUser(
    db: D1Database,
    userId: string,
    excludeMessageTs: string
  ): Promise<Thought | null> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await db
      .prepare(
        `SELECT * FROM thoughts
         WHERE slack_user_id = ?
           AND created_at > ?
           AND slack_message_ts != ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(userId, cutoff, excludeMessageTs)
      .first<Thought>();

    return result ?? null;
  }

  /**
   * Update classification. Uses optimistic concurrency guard:
   * only updates if classification is still 'unclassified'.
   * Returns true if updated, false if already classified.
   */
  async updateClassification(
    db: D1Database,
    id: string,
    classification: "action_required" | "reference" | "noise",
    source: "llm" | "user_override",
    model: string | null,
    latencyMs: number | null
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `UPDATE thoughts
         SET classification = ?, classification_source = ?,
             classification_model = ?, classification_latency_ms = ?,
             classified_at = ?
         WHERE id = ? AND classification = 'unclassified'`
      )
      .bind(classification, source, model, latencyMs, now, id)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Force update classification (for user overrides — no guard on current value).
   */
  async overrideClassification(
    db: D1Database,
    id: string,
    classification: "action_required" | "reference" | "noise"
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `UPDATE thoughts
          SET classification = ?, classification_source = 'user_override',
              classified_at = ?, status_changed_at = ?
          WHERE id = ?`
      )
      .bind(classification, now, now, id)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Store the bot's reply message timestamp for emoji reaction override lookup.
   */
  async updateBotReplyTs(
    db: D1Database,
    id: string,
    botReplyTs: string
  ): Promise<void> {
    await db
      .prepare(`UPDATE thoughts SET bot_reply_ts = ? WHERE id = ?`)
      .bind(botReplyTs, id)
      .run();
  }

  /**
   * Update thought status (acted_on, snoozed, dismissed).
   */
  async updateStatus(
    db: D1Database,
    id: string,
    status: "acted_on" | "snoozed" | "dismissed",
    snoozeUntil?: string
  ): Promise<boolean> {
    const now = new Date().toISOString();

    if (status === "snoozed" && snoozeUntil) {
      const result = await db
        .prepare(
          `UPDATE thoughts
           SET status = ?, snooze_until = ?, status_changed_at = ?
           WHERE id = ?
             AND status NOT IN ('acted_on', 'dismissed')`
        )
        .bind(status, snoozeUntil, now, id)
        .run();
      return (result.meta.changes ?? 0) > 0;
    }

    const result = await db
      .prepare(
        `UPDATE thoughts
         SET status = ?, status_changed_at = ?
         WHERE id = ?
           AND status NOT IN ('acted_on', 'dismissed')`
      )
      .bind(status, now, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Get action items for digest: action_required + snoozed-due + unclassified.
   */
  async findDigestItems(
    db: D1Database,
    userId: string,
    periodStart: string,
    periodEnd: string,
    now: string
  ): Promise<Thought[]> {
    // Snoozed items intentionally have no created_at bounds.
    // Once due, they should re-appear regardless of original capture time.
    const unclassifiedLookbackStart = new Date(
      new Date(now).getTime() - UNCLASSIFIED_DIGEST_LOOKBACK_MS
    ).toISOString();

    const result = await db
      .prepare(
        `SELECT * FROM thoughts
         WHERE slack_user_id = ?
           AND (
             (classification = 'action_required' AND status = 'open'
              AND created_at >= ? AND created_at < ?)
             OR (status = 'snoozed' AND snooze_until <= ?)
             OR (classification = 'unclassified' AND status = 'open'
                 AND created_at >= ? AND created_at < ?)
            )
         ORDER BY created_at ASC`
      )
      .bind(
        userId,
        periodStart,
        periodEnd,
        now,
        unclassifiedLookbackStart,
        periodEnd
      )
      .all<Thought>();

    return result.results;
  }

  /**
   * Get thought counts by classification for a user in a period (for empty-week summary).
   */
  async countByClassification(
    db: D1Database,
    userId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<Record<string, number>> {
    const result = await db
      .prepare(
        `SELECT classification, COUNT(*) as count FROM thoughts
         WHERE slack_user_id = ?
           AND created_at >= ? AND created_at < ?
         GROUP BY classification`
      )
      .bind(userId, periodStart, periodEnd)
      .all<{ classification: string; count: number }>();

    const counts: Record<string, number> = {};
    for (const row of result.results) {
      counts[row.classification] = row.count;
    }
    return counts;
  }

  /**
   * Purge expired thought text (90 days) and hard-delete old records (180 days).
   * Preserves acted_on metadata.
   */
  async purgeExpiredText(
    db: D1Database,
    cutoff90: string,
    cutoff180: string
  ): Promise<{ textsPurged: number; recordsDeleted: number }> {
    const now = new Date().toISOString();

    // Purge text for thoughts older than 90 days
    const purgeResult = await db
      .prepare(
        `UPDATE thoughts
         SET text = NULL, text_purged_at = ?
         WHERE created_at < ?
           AND text IS NOT NULL`
      )
      .bind(now, cutoff90)
      .run();

    // Hard-delete thoughts older than 180 days that are not acted_on
    const deleteResult = await db
      .prepare(
        `DELETE FROM thoughts
         WHERE created_at < ?
           AND status != 'acted_on'`
      )
      .bind(cutoff180)
      .run();

    return {
      textsPurged: purgeResult.meta.changes ?? 0,
      recordsDeleted: deleteResult.meta.changes ?? 0,
    };
  }

  /**
   * Find stale unclassified thoughts for catch-up cron.
   * Older than 5 minutes but younger than 1 hour.
   */
  async findStaleUnclassified(
    db: D1Database,
    fiveMinAgo: string,
    oneHourAgo: string
  ): Promise<Array<{ id: string; slack_user_id: string }>> {
    const result = await db
      .prepare(
        `SELECT id, slack_user_id FROM thoughts
         WHERE classification = 'unclassified'
           AND created_at < ?
           AND created_at > ?`
      )
      .bind(fiveMinAgo, oneHourAgo)
      .all<{ id: string; slack_user_id: string }>();

    return result.results;
  }
}
