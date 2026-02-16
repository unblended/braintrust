/**
 * UserPrefsRepository — CRUD + query operations for the user_prefs table.
 * Digest due eligibility is computed in TypeScript via isDigestDue().
 */

export interface UserPrefs {
  slack_user_id: string;
  digest_day: number;
  digest_hour: number;
  digest_minute: number;
  timezone: string;
  welcomed: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertUserPrefsParams {
  slackUserId: string;
  digestDay: number;
  digestHour: number;
  digestMinute: number;
  timezone?: string;
  welcomed?: 0 | 1;
}

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface LocalTimeParts {
  day: number;
  hour: number;
  minute: number;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/**
 * Pure timezone-aware helper used by the digest scheduler.
 * Returns true when now is inside the user's configured 15-minute digest window.
 */
export function isDigestDue(
  prefs: Pick<
    UserPrefs,
    "digest_day" | "digest_hour" | "digest_minute" | "timezone"
  >,
  now: Date
): boolean {
  if (
    prefs.digest_day < 0 ||
    prefs.digest_day > 6 ||
    prefs.digest_hour < 0 ||
    prefs.digest_hour > 23 ||
    prefs.digest_minute < 0 ||
    prefs.digest_minute > 59
  ) {
    return false;
  }

  const local = getLocalTimeParts(prefs.timezone, now);
  if (local === null) {
    return false;
  }

  const currentMinuteOfWeek = toMinuteOfWeek(local.day, local.hour, local.minute);
  const digestMinuteOfWeek = toMinuteOfWeek(
    prefs.digest_day,
    prefs.digest_hour,
    prefs.digest_minute
  );

  const diff =
    (currentMinuteOfWeek - digestMinuteOfWeek + MINUTES_PER_WEEK) %
    MINUTES_PER_WEEK;

  return diff >= 0 && diff < 15;
}

function toMinuteOfWeek(day: number, hour: number, minute: number): number {
  return day * MINUTES_PER_DAY + hour * MINUTES_PER_HOUR + minute;
}

function getLocalTimeParts(timezone: string, now: Date): LocalTimeParts | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }

  const parts = formatter.formatToParts(now);
  const weekdayPart = parts.find((part) => part.type === "weekday")?.value;
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const minutePart = parts.find((part) => part.type === "minute")?.value;

  if (!weekdayPart || !hourPart || !minutePart) {
    return null;
  }

  const day = WEEKDAY_TO_NUMBER[weekdayPart];
  const hour = Number.parseInt(hourPart, 10);
  const minute = Number.parseInt(minutePart, 10);

  if (day === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  return { day, hour, minute };
}

export class UserPrefsRepository {
  /**
   * Upsert user digest preferences.
   */
  async upsert(db: D1Database, params: UpsertUserPrefsParams): Promise<UserPrefs> {
    const now = new Date().toISOString();
    const timezone = params.timezone ?? "America/New_York";
    const welcomed = params.welcomed ?? 0;
    const timezoneForUpdate = params.timezone ?? null;
    const welcomedForUpdate = params.welcomed ?? null;

    await db
      .prepare(
        `INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slack_user_id)
         DO UPDATE SET digest_day = ?, digest_hour = ?, digest_minute = ?, timezone = COALESCE(?, timezone), welcomed = COALESCE(?, welcomed), updated_at = ?`
      )
      .bind(
        params.slackUserId,
        params.digestDay,
        params.digestHour,
        params.digestMinute,
        timezone,
        welcomed,
        now,
        now,
        params.digestDay,
        params.digestHour,
        params.digestMinute,
        timezoneForUpdate,
        welcomedForUpdate,
        now
      )
      .run();

    const stored = await this.findByUserId(db, params.slackUserId);
    if (!stored) {
      throw new Error(`Failed to upsert user prefs for ${params.slackUserId}`);
    }

    return stored;
  }

  /**
   * Fetch preferences for a single user.
   */
  async findByUserId(db: D1Database, userId: string): Promise<UserPrefs | null> {
    const result = await db
      .prepare(`SELECT * FROM user_prefs WHERE slack_user_id = ?`)
      .bind(userId)
      .first<UserPrefs>();

    return result ?? null;
  }

  /**
   * Fetch all user preferences for digest scheduling.
   */
  async findAllPrefs(db: D1Database): Promise<UserPrefs[]> {
    const result = await db
      .prepare(`SELECT * FROM user_prefs ORDER BY slack_user_id ASC`)
      .all<UserPrefs>();

    return result.results;
  }
}
