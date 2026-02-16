const FIVE_MINUTES_IN_SECONDS = 60 * 5;

export class SlackVerifier {
  private signingSecret: string;

  constructor(signingSecret: string) {
    this.signingSecret = signingSecret;
  }

  async verifyRequest(headers: Headers, body: string): Promise<boolean> {
    const timestamp = headers.get("x-slack-request-timestamp");
    const signature = headers.get("x-slack-signature");

    if (!timestamp || !signature) {
      return false;
    }

    return this.verify(timestamp, body, signature);
  }

  async verify(
    timestamp: string,
    body: string,
    signature: string
  ): Promise<boolean> {
    const parsedTimestamp = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(parsedTimestamp)) {
      return false;
    }

    const fiveMinAgo = Math.floor(Date.now() / 1000) - FIVE_MINUTES_IN_SECONDS;
    if (parsedTimestamp < fiveMinAgo) {
      return false;
    }

    const baseString = `v0:${timestamp}:${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(baseString)
    );
    const computed = `v0=${toHex(sig)}`;

    // Timing-safe comparison via double-HMAC.
    const encoder = new TextEncoder();
    const [hmacComputed, hmacExpected] = await Promise.all([
      crypto.subtle.sign("HMAC", key, encoder.encode(computed)),
      crypto.subtle.sign("HMAC", key, encoder.encode(signature)),
    ]);

    const a = new Uint8Array(hmacComputed);
    const b = new Uint8Array(hmacExpected);
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i += 1) {
      result |= a[i] ^ b[i];
    }

    return result === 0;
  }
}

function toHex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
