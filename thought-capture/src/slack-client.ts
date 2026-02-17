/**
 * Thin Slack Web API client for Cloudflare Workers.
 *
 * Decision: Using raw fetch() wrapper instead of @slack/web-api.
 * The @slack/web-api package imports Node.js-specific modules (node:https, node:fs)
 * that are not available in the Cloudflare Workers runtime. This fallback client
 * implements the 5 Slack API methods we need using the standard fetch() API.
 *
 * See: docs/adr/0003-deployment-architecture.md
 */

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_SLACK_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "request_timeout",
  "service_unavailable",
  "temporarily_unavailable",
]);

export interface SlackPostMessageResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackUserInfoResponse {
  ok: boolean;
  user?: {
    id: string;
    tz: string;
    tz_label: string;
    tz_offset: number;
  };
  error?: string;
}

export interface SlackConversationOpenResponse {
  ok: boolean;
  channel?: {
    id: string;
  };
  error?: string;
}

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export class SlackClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Post a message to a channel or DM.
   */
  async postMessage(params: {
    channel: string;
    text?: string;
    blocks?: unknown[];
  }): Promise<SlackPostMessageResponse> {
    return this.callApi<SlackPostMessageResponse>("chat.postMessage", params);
  }

  /**
   * Update an existing message.
   */
  async updateMessage(params: {
    channel: string;
    ts: string;
    text?: string;
    blocks?: unknown[];
  }): Promise<SlackPostMessageResponse> {
    return this.callApi<SlackPostMessageResponse>("chat.update", params);
  }

  /**
   * Add a reaction emoji to a message.
   */
  async addReaction(params: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<SlackApiResponse> {
    return this.callApi<SlackApiResponse>("reactions.add", params);
  }

  /**
   * Open a DM conversation with a user.
   */
  async openConversation(params: {
    users: string;
  }): Promise<SlackConversationOpenResponse> {
    return this.callApi<SlackConversationOpenResponse>(
      "conversations.open",
      params
    );
  }

  /**
   * Get user info (including timezone).
   */
  async getUserInfo(params: {
    user: string;
  }): Promise<SlackUserInfoResponse> {
    return this.callApi<SlackUserInfoResponse>("users.info", params);
  }

  private async callApi<T extends SlackApiResponse>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
      });

      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      if (!response.ok) {
        if (attempt < MAX_RETRIES && RETRYABLE_HTTP_STATUSES.has(response.status)) {
          await sleep(getRetryDelayMs(attempt, retryAfterMs));
          continue;
        }

        throw new Error(`Slack API ${method} failed: HTTP ${response.status}`);
      }

      const data = (await response.json()) as T;
      if (!data.ok) {
        if (
          attempt < MAX_RETRIES &&
          data.error &&
          RETRYABLE_SLACK_ERRORS.has(data.error)
        ) {
          await sleep(getRetryDelayMs(attempt, retryAfterMs));
          continue;
        }

        throw new Error(`Slack API ${method} error: ${data.error}`);
      }

      return data;
    }

    throw new Error(`Slack API ${method} failed after retries`);
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

function getRetryDelayMs(
  attempt: number,
  retryAfterMs: number | null
): number {
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const backoffMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const jitterFactor = 0.75 + Math.random() * 0.5;
  const jitteredBackoffMs = Math.round(backoffMs * jitterFactor);
  return Math.min(jitteredBackoffMs, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
