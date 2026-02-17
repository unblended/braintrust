import {
  checkUserAccess,
  getAccessRejectionMessage,
} from "./feature-flags";
import { jsonResponse } from "./health";
import { logWarn } from "./logging";
import {
  handleDigestButtonAction,
  type SlackInteractionPayload,
} from "./digest-button-handler";
import type { Env } from "./types";

const DIGEST_ACTION_IDS = new Set([
  "thought_acted_on",
  "thought_snooze",
  "thought_dismiss",
]);

const GENERIC_INTERACTION_ERROR = "Something went wrong. Please try again.";

export async function handleSlackInteractions(
  rawBody: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const params = new URLSearchParams(rawBody);
  const payloadValue = params.get("payload");
  if (!payloadValue) {
    return jsonResponse({ error: "Invalid interaction payload" }, 400);
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadValue) as SlackInteractionPayload;
  } catch {
    return jsonResponse({ error: "Invalid interaction payload" }, 400);
  }

  const userId = payload.user?.id;
  if (!userId) {
    return jsonResponse({ error: "Missing user in payload" }, 400);
  }

  const access = checkUserAccess(env, userId);
  if (!access.allowed) {
    return interactionResponse(getAccessRejectionMessage(access.reason!));
  }

  if (payload.type === "block_actions" && payload.actions?.length > 0) {
    const actionId = payload.actions[0].action_id;

    if (DIGEST_ACTION_IDS.has(actionId)) {
      if (!payload.response_url) {
        const result = await runDigestButtonAction(payload, env, userId, actionId);
        if (!result.ok) {
          return interactionResponse(result.userMessage ?? GENERIC_INTERACTION_ERROR);
        }

        return new Response("", { status: 200 });
      }

      ctx.waitUntil(
        runDigestButtonAction(payload, env, userId, actionId).then(
          async (result) => {
            if (!result.ok) {
              await sendErrorViaResponseUrl(
                payload.response_url,
                result.userMessage ?? GENERIC_INTERACTION_ERROR
              );
            }
          }
        )
      );

      return new Response("", { status: 200 });
    }
  }

  logWarn("interaction.unknown_type", {
    user_id: userId,
    type: payload.type,
  });

  return interactionResponse("Something went wrong. Please try again.");
}

async function runDigestButtonAction(
  payload: SlackInteractionPayload,
  env: Env,
  userId: string,
  actionId: string
): Promise<{ ok: boolean; userMessage?: string }> {
  try {
    return await handleDigestButtonAction(payload, env);
  } catch (error) {
    logWarn("interaction.digest_button_failed", {
      user_id: userId,
      action_id: actionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { ok: false, userMessage: GENERIC_INTERACTION_ERROR };
  }
}

async function sendErrorViaResponseUrl(
  responseUrl: string,
  text: string
): Promise<void> {
  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text,
      }),
    });

    if (!response.ok) {
      logWarn("interaction.response_url_failed", {
        status: response.status,
      });
    }
  } catch (error) {
    logWarn("interaction.response_url_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function interactionResponse(text: string): Response {
  return jsonResponse({ response_type: "ephemeral", text }, 200);
}
