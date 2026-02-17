import type { Env } from "./types";

export type AccessRejectionReason = "feature_disabled" | "user_not_enabled";

export interface AccessResult {
  allowed: boolean;
  reason?: AccessRejectionReason;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isThoughtCaptureEnabled(env: Pick<Env, "THOUGHT_CAPTURE_V1_ENABLED">): boolean {
  return TRUE_VALUES.has(env.THOUGHT_CAPTURE_V1_ENABLED.trim().toLowerCase());
}

export function parseEnabledUserIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

export function checkUserAccess(
  env: Pick<Env, "THOUGHT_CAPTURE_V1_ENABLED" | "ENABLED_USER_IDS">,
  userId: string
): AccessResult {
  if (!isThoughtCaptureEnabled(env)) {
    return { allowed: false, reason: "feature_disabled" };
  }

  const enabledUserIds = parseEnabledUserIds(env.ENABLED_USER_IDS);
  if (!enabledUserIds.has(userId)) {
    return { allowed: false, reason: "user_not_enabled" };
  }

  return { allowed: true };
}

export function getAccessRejectionMessage(reason: AccessRejectionReason): string {
  if (reason === "feature_disabled") {
    return "Thought Capture is temporarily unavailable. Your previous thoughts are saved.";
  }

  return "Thought Capture is currently in private beta. You're not yet on the list - stay tuned!";
}
