/**
 * DigestService — Builds Block Kit digest payloads and empty-week messages.
 * Used by the Digest Delivery Queue consumer to generate per-user weekly digests.
 */

import type { Thought } from "./thought-repository";

export interface DigestBlock {
  type: string;
  text?: { type: string; text: string };
  block_id?: string;
  elements?: unknown[];
}

export interface DigestPayload {
  text: string; // Fallback text for notifications
  blocks: DigestBlock[];
}

const MAX_DIGEST_ITEMS = 14;

/**
 * Build a digest Block Kit message for a set of action items.
 * If no items, returns an empty-week summary message.
 */
export function buildDigestPayload(
  items: Thought[],
  classificationCounts: Record<string, number>,
  userTimezone: string = "UTC"
): DigestPayload {
  if (items.length === 0) {
    return buildEmptyWeekPayload(classificationCounts);
  }

  const blocks: DigestBlock[] = [];

  // Separate items by type for display
  const allActionItems = items.filter(
    (t) => t.classification === "action_required" && t.status === "open"
  );
  const allSnoozedItems = items.filter((t) => t.status === "snoozed");
  const allUnclassifiedItems = items.filter(
    (t) => t.classification === "unclassified" && t.status === "open"
  );

  let remainingSlots = MAX_DIGEST_ITEMS;
  const actionItems = allActionItems.slice(0, remainingSlots);
  remainingSlots -= actionItems.length;

  const snoozedItems = allSnoozedItems.slice(0, remainingSlots);
  remainingSlots -= snoozedItems.length;

  const unclassifiedItems = allUnclassifiedItems.slice(0, remainingSlots);

  const shownItemCount =
    actionItems.length + snoozedItems.length + unclassifiedItems.length;
  const hiddenItemCount = Math.max(0, items.length - shownItemCount);

  const totalCount = items.length;
  const fallbackText = `Your Action Items This Week (${totalCount} item${totalCount === 1 ? "" : "s"})`;

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: fallbackText },
  });

  // Action required items
  for (const item of actionItems) {
    appendThoughtBlocks(blocks, item, userTimezone);
  }

  // Snoozed items section
  if (snoozedItems.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Snoozed Items (${snoozedItems.length})*`,
      },
    });

    for (const item of snoozedItems) {
      appendThoughtBlocks(blocks, item, userTimezone);
    }
  }

  // Unclassified items section
  if (unclassifiedItems.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Needs Review (${unclassifiedItems.length})*`,
      },
    });

    for (const item of unclassifiedItems) {
      appendThoughtBlocks(blocks, item, userTimezone);
    }
  }

  if (hiddenItemCount > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_${hiddenItemCount} more item${hiddenItemCount === 1 ? "" : "s"} not shown to keep this digest concise._`,
      },
    });
  }

  return { text: fallbackText, blocks };
}

/**
 * Build the empty-week summary message.
 * Shows total thought count and classification breakdown.
 */
function buildEmptyWeekPayload(
  counts: Record<string, number>
): DigestPayload {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const reference = counts["reference"] ?? 0;
  const noise = counts["noise"] ?? 0;
  const actionRequired = counts["action_required"] ?? 0;

  let summary: string;
  if (total === 0) {
    summary =
      "No action items this week. You haven't captured any thoughts yet — send me a DM to get started!";
  } else {
    const parts: string[] = [];
    if (actionRequired > 0) parts.push(`${actionRequired} Action Required`);
    if (reference > 0) parts.push(`${reference} Reference`);
    if (noise > 0) parts.push(`${noise} Noise`);

    summary = `No action items this week. You captured ${total} thought${total === 1 ? "" : "s"} — ${parts.join(", ")}. Keep capturing!`;
  }

  const fallbackText = "Weekly Digest — No Action Items";

  return {
    text: fallbackText,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: summary },
      },
    ],
  };
}

/**
 * Append thought section + action buttons to the blocks array.
 */
function appendThoughtBlocks(
  blocks: DigestBlock[],
  thought: Thought,
  userTimezone: string
): void {
  const capturedDate = formatCapturedDate(thought.created_at, userTimezone);
  const displayText = thought.text ?? "[text purged]";

  blocks.push({
    type: "section",
    block_id: `thought_${thought.id}`,
    text: {
      type: "mrkdwn",
      text: `*${escapeMarkdown(displayText)}*\n_Captured ${capturedDate}_`,
    },
  });

  blocks.push({
    type: "actions",
    block_id: `actions_${thought.id}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Acted on" },
        action_id: "thought_acted_on",
        value: thought.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Snooze" },
        action_id: "thought_snooze",
        value: thought.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Dismiss" },
        action_id: "thought_dismiss",
        value: thought.id,
      },
    ],
  });

  blocks.push({ type: "divider" });
}

/**
 * Format a created_at ISO timestamp into a human-readable date.
 * e.g., "Feb 15 at 2:30 PM"
 */
function formatCapturedDate(isoTimestamp: string, timezone: string): string {
  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) {
    return "unknown date";
  }

  const formatted = formatDateInTimezone(date, timezone);
  if (formatted) {
    return formatted;
  }

  return formatDateInTimezone(date, "UTC") ?? "unknown date";
}

function formatDateInTimezone(date: Date, timezone: string): string | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });

    const parts = formatter.formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value;
    const tz = parts.find((part) => part.type === "timeZoneName")?.value;

    if (!month || !day || !hour || !minute || !dayPeriod) {
      return null;
    }

    const period = dayPeriod.toUpperCase();
    const tzSuffix = tz ? ` ${tz}` : "";
    return `${month} ${day} at ${hour}:${minute} ${period}${tzSuffix}`;
  } catch {
    return null;
  }
}

/**
 * Escape special Slack mrkdwn characters in thought text.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_~`|])/g, "\\$1");
}

/**
 * Build the status text that replaces buttons after a user acts on a digest item.
 */
export function buildStatusText(
  action: "acted_on" | "snoozed" | "dismissed",
  snoozeUntil?: string
): string {
  switch (action) {
    case "acted_on":
      return "Marked as acted on";
    case "snoozed": {
      if (snoozeUntil) {
        const date = new Date(snoozeUntil);
        const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        const day = date.getUTCDate();
        return `Snoozed until ${month} ${day}`;
      }
      return "Snoozed";
    }
    case "dismissed":
      return "Dismissed";
  }
}

/**
 * Update digest blocks: replace the actions block for a thought with status text.
 * Returns a new blocks array with the actions block replaced by a context block.
 */
export function replaceActionsWithStatus(
  originalBlocks: DigestBlock[],
  thoughtId: string,
  statusText: string
): DigestBlock[] {
  return originalBlocks.map((block) => {
    if (block.block_id === `actions_${thoughtId}`) {
      return {
        type: "section",
        block_id: `actions_${thoughtId}`,
        text: { type: "mrkdwn", text: `_${statusText}_` },
      };
    }
    return block;
  });
}
