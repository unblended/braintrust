import crypto from "node:crypto";

function parseArgs(argv) {
  const options = {
    text: "we should write a migration runbook",
    user: process.env.LOCAL_SLACK_USER_ID || "U_LOCAL_TEST",
    channel: "D_LOCAL_TEST",
    ts: `${Math.floor(Date.now() / 1000)}.000001`,
    url: process.env.LOCAL_WORKER_URL || "http://127.0.0.1:8787/slack/events",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--text" && next) {
      options.text = next;
      i += 1;
    } else if (arg === "--user" && next) {
      options.user = next;
      i += 1;
    } else if (arg === "--channel" && next) {
      options.channel = next;
      i += 1;
    } else if (arg === "--ts" && next) {
      options.ts = next;
      i += 1;
    } else if (arg === "--url" && next) {
      options.url = next;
      i += 1;
    }
  }

  return options;
}

function signSlackBody(signingSecret, timestamp, rawBody) {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  return `v0=${digest}`;
}

async function main() {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET must be set in environment");
  }

  const args = parseArgs(process.argv.slice(2));
  const payload = {
    type: "event_callback",
    event: {
      type: "message",
      channel_type: "im",
      user: args.user,
      text: args.text,
      ts: args.ts,
      channel: args.channel,
    },
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signSlackBody(signingSecret, timestamp, rawBody);

  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });

  const bodyText = await response.text();
  console.log(`status=${response.status}`);
  if (bodyText) {
    console.log(bodyText);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
