/**
 * Environment bindings for the Thought Capture Worker.
 */
export interface Env {
  // D1 database binding
  DB: D1Database;

  // Queue producer bindings
  CLASSIFICATION_QUEUE: Queue<ClassificationMessage>;
  DIGEST_DELIVERY_QUEUE: Queue<DigestDeliveryMessage>;

  // Secrets (set via `wrangler secret put`)
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  OPENAI_API_KEY: string;

  // Vars (defined in wrangler.jsonc vars)
  THOUGHT_CAPTURE_V1_ENABLED: string;
  ENABLED_USER_IDS: string;
}

/**
 * Message payload for the classification queue.
 */
export interface ClassificationMessage {
  thoughtId: string;
  userId: string;
}

/**
 * Message payload for the digest delivery queue.
 */
export interface DigestDeliveryMessage {
  userId: string;
  periodStart: string;
  periodEnd: string;
}
