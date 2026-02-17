import { logWarn } from "./logging";
import { SlackClient } from "./slack-client";

/**
 * Shared timezone utilities used by event handlers and slash commands.
 */

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function fetchTimezone(
  slackClient: SlackClient,
  userId: string
): Promise<string> {
  try {
    const userInfo = await slackClient.getUserInfo({ user: userId });
    const timezone = userInfo.user?.tz;
    if (timezone && isValidTimezone(timezone)) {
      return timezone;
    }
  } catch (error) {
    logWarn("user_prefs.timezone_lookup_failed", {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return "America/New_York";
}
