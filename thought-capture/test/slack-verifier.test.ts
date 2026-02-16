import { SlackVerifier } from "../src/slack-verifier";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TIMESTAMP = "1531420618";
const BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const SIGNATURE =
  "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

describe("SlackVerifier", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies Slack's documented signature test vector", async () => {
    const verifier = new SlackVerifier(SIGNING_SECRET);

    vi.useFakeTimers();
    vi.setSystemTime(new Date((Number(TIMESTAMP) + 60) * 1000));

    const isValid = await verifier.verify(TIMESTAMP, BODY, SIGNATURE);

    expect(isValid).toBe(true);
  });

  it("rejects a tampered body with the same signature", async () => {
    const verifier = new SlackVerifier(SIGNING_SECRET);

    vi.useFakeTimers();
    vi.setSystemTime(new Date((Number(TIMESTAMP) + 60) * 1000));

    const isValid = await verifier.verify(
      TIMESTAMP,
      `${BODY}&extra=tampered`,
      SIGNATURE
    );

    expect(isValid).toBe(false);
  });

  it("rejects replayed requests older than five minutes", async () => {
    const verifier = new SlackVerifier(SIGNING_SECRET);

    vi.useFakeTimers();
    vi.setSystemTime(new Date((Number(TIMESTAMP) + 10 * 60) * 1000));

    const isValid = await verifier.verify(TIMESTAMP, BODY, SIGNATURE);

    expect(isValid).toBe(false);
  });

  it("rejects requests with missing signature headers", async () => {
    const verifier = new SlackVerifier(SIGNING_SECRET);
    const headers = new Headers();

    const isValid = await verifier.verifyRequest(headers, BODY);

    expect(isValid).toBe(false);
  });
});
