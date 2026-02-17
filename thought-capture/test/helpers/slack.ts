import { env } from "cloudflare:test";

import type {
  ClassificationMessage,
  DigestDeliveryMessage,
  Env,
} from "../../src/types";

export const TEST_SIGNING_SECRET = "test-signing-secret";

export async function createSignedSlackRequest(
  path: string,
  body: string,
  options: {
    timestamp?: string;
    signingSecret?: string;
    method?: string;
  } = {}
): Promise<Request> {
  const timestamp =
    options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signingSecret = options.signingSecret ?? TEST_SIGNING_SECRET;
  const signature = await createSlackSignature(signingSecret, timestamp, body);

  return new Request(`https://example.com${path}`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

export async function createSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base)
  );
  return `v0=${toHex(signature)}`;
}

export function buildTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    CLASSIFICATION_QUEUE: createQueueStub<ClassificationMessage>(),
    DIGEST_DELIVERY_QUEUE: createQueueStub<DigestDeliveryMessage>(),
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: TEST_SIGNING_SECRET,
    OPENAI_API_KEY: "test-openai-key",
    THOUGHT_CAPTURE_V1_ENABLED: "true",
    ENABLED_USER_IDS: "U_ENABLED",
    CLASSIFICATION_QUEUE_NAME: "thought-classification",
    DIGEST_DELIVERY_QUEUE_NAME: "digest-delivery",
    ...overrides,
  };
}

function createQueueStub<T>(): Queue<T> {
  return {
    async send(_message: T): Promise<void> {
      return;
    },
  } as Queue<T>;
}

function toHex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
