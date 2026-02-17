export interface InsertDigestDeliveryParams {
  id: string;
  userId: string;
  deliveredAt: string;
  itemCount: number;
  snoozedItemCount: number;
  slackMessageTs: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface DigestDelivery {
  id: string;
  slack_user_id: string;
  delivered_at: string;
  item_count: number;
  snoozed_item_count: number;
  slack_message_ts: string | null;
  period_start: string;
  period_end: string;
}

export class DigestDeliveryRepository {
  async hasDeliveryForPeriod(
    db: D1Database,
    userId: string,
    periodStart: string
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `SELECT 1 FROM digest_deliveries
         WHERE slack_user_id = ? AND period_start = ?`
      )
      .bind(userId, periodStart)
      .first();

    return result !== null;
  }

  async insert(
    db: D1Database,
    params: InsertDigestDeliveryParams
  ): Promise<boolean> {
    const result = await db
      .prepare(
        `INSERT INTO digest_deliveries (id, slack_user_id, delivered_at, item_count, snoozed_item_count, slack_message_ts, period_start, period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slack_user_id, period_start) DO NOTHING`
      )
      .bind(
        params.id,
        params.userId,
        params.deliveredAt,
        params.itemCount,
        params.snoozedItemCount,
        params.slackMessageTs,
        params.periodStart,
        params.periodEnd
      )
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async findBySlackMessageTs(
    db: D1Database,
    userId: string,
    slackMessageTs: string
  ): Promise<DigestDelivery | null> {
    const result = await db
      .prepare(
        `SELECT * FROM digest_deliveries
         WHERE slack_user_id = ?
           AND slack_message_ts = ?
         ORDER BY delivered_at DESC
         LIMIT 1`
      )
      .bind(userId, slackMessageTs)
      .first<DigestDelivery>();

    return result ?? null;
  }
}
