import { checkUserAccess, getAccessRejectionMessage } from "./feature-flags";
import { jsonResponse } from "./health";
import { SlackClient } from "./slack-client";
import { fetchTimezone } from "./timezone-utils";
import type { Env } from "./types";
import { UserPrefsRepository } from "./user-prefs-repository";

export interface ScheduleCommandDependencies {
  userPrefsRepository: UserPrefsRepository;
  createSlackClient: (token: string) => SlackClient;
}

export function createScheduleCommandDependencies(): ScheduleCommandDependencies {
  return {
    userPrefsRepository: new UserPrefsRepository(),
    createSlackClient: (token: string) => new SlackClient(token),
  };
}

const DAY_TO_NUMBER: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const SCHEDULE_TEXT_REGEX = /^schedule\s+([a-zA-Z]+)\s+(\d{1,2}):(\d{2})$/i;

export interface ParsedScheduleCommand {
  digestDay: number;
  digestHour: number;
  digestMinute: number;
}

export function parseScheduleCommandText(
  text: string
): ParsedScheduleCommand | null {
  const match = SCHEDULE_TEXT_REGEX.exec(text.trim());
  if (!match) {
    return null;
  }

  const dayToken = match[1].toLowerCase();
  const digestDay = DAY_TO_NUMBER[dayToken];
  const digestHour = Number.parseInt(match[2], 10);
  const digestMinute = Number.parseInt(match[3], 10);

  if (digestDay === undefined) {
    return null;
  }

  if (
    Number.isNaN(digestHour) ||
    Number.isNaN(digestMinute) ||
    digestHour < 0 ||
    digestHour > 23 ||
    digestMinute < 0 ||
    digestMinute > 59
  ) {
    return null;
  }

  return {
    digestDay,
    digestHour,
    digestMinute,
  };
}

export async function handleScheduleCommand(
  rawBody: string,
  env: Env,
  deps: ScheduleCommandDependencies = createScheduleCommandDependencies()
): Promise<Response> {
  const params = new URLSearchParams(rawBody);
  const userId = params.get("user_id");
  const text = params.get("text") ?? "";

  if (!userId) {
    return commandResponse(
      "Usage: /thoughtcapture schedule <day> <HH:MM>. Example: /thoughtcapture schedule friday 14:00"
    );
  }

  const access = checkUserAccess(env, userId);
  if (!access.allowed) {
    return commandResponse(getAccessRejectionMessage(access.reason!));
  }

  const parsed = parseScheduleCommandText(text);
  if (!parsed) {
    return commandResponse(
      "Usage: /thoughtcapture schedule <day> <HH:MM>. Example: /thoughtcapture schedule friday 14:00"
    );
  }

  const existingPrefs = await deps.userPrefsRepository.findByUserId(env.DB, userId);
  const slackClient = deps.createSlackClient(env.SLACK_BOT_TOKEN);
  const timezone =
    existingPrefs?.timezone ?? (await fetchTimezone(slackClient, userId));
  const welcomed = existingPrefs?.welcomed === 1 ? 1 : 0;

  await deps.userPrefsRepository.upsert(env.DB, {
    slackUserId: userId,
    digestDay: parsed.digestDay,
    digestHour: parsed.digestHour,
    digestMinute: parsed.digestMinute,
    timezone,
    welcomed,
  });

  return commandResponse(
    `Digest schedule updated: ${DAY_LABELS[parsed.digestDay]} at ${formatTime(parsed.digestHour, parsed.digestMinute)} (${timezone}).`
  );
}

function commandResponse(message: string): Response {
  return jsonResponse(
    {
      response_type: "ephemeral",
      text: message,
    },
    200
  );
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${period}`;
}
