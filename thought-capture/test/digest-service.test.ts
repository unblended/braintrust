import { env } from "cloudflare:test";

import {
  buildDigestPayload,
  buildStatusText,
  replaceActionsWithStatus,
  type DigestBlock,
} from "../src/digest-service";
import type { Thought } from "../src/thought-repository";

describe("DigestService", () => {
  function makeThought(overrides: Partial<Thought> = {}): Thought {
    return {
      id: crypto.randomUUID(),
      slack_user_id: "U_TEST",
      slack_message_ts: `${Date.now()}.000001`,
      text: "test thought text",
      classification: "action_required",
      classification_source: "llm",
      classification_model: "gpt-4o-mini",
      classification_latency_ms: 500,
      status: "open",
      snooze_until: null,
      created_at: "2026-02-15T14:30:00.000Z",
      classified_at: "2026-02-15T14:30:05.000Z",
      status_changed_at: null,
      text_purged_at: null,
      bot_reply_ts: null,
      ...overrides,
    };
  }

  describe("buildDigestPayload", () => {
    it("builds correct Block Kit for action_required items", () => {
      const items = [
        makeThought({ id: "t1", text: "deprecate v1 auth service" }),
        makeThought({ id: "t2", text: "review RFC for queue retries" }),
      ];

      const payload = buildDigestPayload(items, {});

      expect(payload.text).toContain("2 items");
      expect(payload.blocks.length).toBeGreaterThan(0);

      // Header
      expect(payload.blocks[0].type).toBe("header");
      expect(payload.blocks[0].text?.text).toContain("2 items");

      // First thought section
      const section1 = payload.blocks[1];
      expect(section1.type).toBe("section");
      expect(section1.block_id).toBe("thought_t1");
      expect(section1.text?.text).toContain("deprecate v1 auth service");
      expect(section1.text?.text).toContain("Captured Feb 15 at 2:30 PM");

      // First thought actions
      const actions1 = payload.blocks[2];
      expect(actions1.type).toBe("actions");
      expect(actions1.block_id).toBe("actions_t1");
      expect(actions1.elements).toHaveLength(3);

      // Divider
      expect(payload.blocks[3].type).toBe("divider");
    });

    it("builds correct Block Kit with snoozed items section", () => {
      const items = [
        makeThought({ id: "t1", text: "action item" }),
        makeThought({
          id: "t2",
          text: "snoozed item",
          status: "snoozed",
          snooze_until: "2026-02-22T09:00:00.000Z",
        }),
      ];

      const payload = buildDigestPayload(items, {});

      const snoozedHeader = payload.blocks.find(
        (b) => b.text?.text?.includes("Snoozed Items")
      );
      expect(snoozedHeader).toBeDefined();
      expect(snoozedHeader?.text?.text).toContain("1");
    });

    it("builds correct Block Kit with unclassified items under Needs Review", () => {
      const items = [
        makeThought({
          id: "t1",
          text: "unclassified thought",
          classification: "unclassified",
          classification_source: "pending",
        }),
      ];

      const payload = buildDigestPayload(items, {});

      const needsReviewHeader = payload.blocks.find(
        (b) => b.text?.text?.includes("Needs Review")
      );
      expect(needsReviewHeader).toBeDefined();
    });

    it("handles mix of action, snoozed, and unclassified items", () => {
      const items = [
        makeThought({ id: "t1", text: "action" }),
        makeThought({ id: "t2", text: "snoozed", status: "snoozed" }),
        makeThought({
          id: "t3",
          text: "unclassified",
          classification: "unclassified",
        }),
      ];

      const payload = buildDigestPayload(items, {});
      expect(payload.text).toContain("3 items");
      expect(payload.blocks.length).toBeGreaterThan(5);
    });

    it("returns empty-week message when no items", () => {
      const payload = buildDigestPayload([], {
        action_required: 2,
        reference: 5,
        noise: 8,
      });

      expect(payload.text).toContain("No Action Items");
      expect(payload.blocks).toHaveLength(1);
      expect(payload.blocks[0].text?.text).toContain("No action items this week");
      expect(payload.blocks[0].text?.text).toContain("15 thoughts");
      expect(payload.blocks[0].text?.text).toContain("5 Reference");
      expect(payload.blocks[0].text?.text).toContain("8 Noise");
    });

    it("returns empty-week message with zero thoughts", () => {
      const payload = buildDigestPayload([], {});

      expect(payload.blocks[0].text?.text).toContain("haven't captured any thoughts");
    });

    it("handles single item (no plural 's')", () => {
      const items = [makeThought({ id: "t1", text: "only one" })];
      const payload = buildDigestPayload(items, {});
      expect(payload.text).toContain("1 item");
      expect(payload.text).not.toContain("1 items");
    });

    it("handles thought with purged text", () => {
      const items = [makeThought({ id: "t1", text: null })];
      const payload = buildDigestPayload(items, {});

      const section = payload.blocks.find((b) => b.block_id === "thought_t1");
      expect(section?.text?.text).toContain("[text purged]");
    });

    it("escapes special markdown characters", () => {
      const items = [
        makeThought({ id: "t1", text: "use <script> & run > test _now_" }),
      ];
      const payload = buildDigestPayload(items, {});

      const section = payload.blocks.find((b) => b.block_id === "thought_t1");
      expect(section?.text?.text).toContain("&lt;script&gt;");
      expect(section?.text?.text).toContain("&amp;");
      expect(section?.text?.text).toContain("\\_now\\_");
    });

    it("limits rendered thought rows to 14 and adds overflow note", () => {
      const items = Array.from({ length: 20 }, (_, idx) =>
        makeThought({ id: `t${idx + 1}`, text: `thought ${idx + 1}` })
      );

      const payload = buildDigestPayload(items, {});
      const thoughtSections = payload.blocks.filter(
        (b) => b.block_id?.startsWith("thought_")
      );

      expect(thoughtSections).toHaveLength(14);
      const overflow = payload.blocks.find((b) =>
        b.text?.text?.includes("6 more items not shown")
      );
      expect(overflow).toBeDefined();
    });

    it("formats captured time in the user timezone", () => {
      const items = [makeThought({ id: "t1", text: "timezone check" })];
      const payload = buildDigestPayload(items, {}, "America/New_York");

      const section = payload.blocks.find((b) => b.block_id === "thought_t1");
      expect(section?.text?.text).toContain("Captured Feb 15 at 9:30 AM");
    });
  });

  describe("buildStatusText", () => {
    it("returns correct text for acted_on", () => {
      expect(buildStatusText("acted_on")).toBe("Marked as acted on");
    });

    it("returns correct text for snoozed with date", () => {
      const text = buildStatusText("snoozed", "2026-03-03T09:00:00.000Z");
      expect(text).toBe("Snoozed until Mar 3");
    });

    it("returns correct text for snoozed without date", () => {
      expect(buildStatusText("snoozed")).toBe("Snoozed");
    });

    it("returns correct text for dismissed", () => {
      expect(buildStatusText("dismissed")).toBe("Dismissed");
    });
  });

  describe("replaceActionsWithStatus", () => {
    it("replaces the correct actions block with status text", () => {
      const blocks: DigestBlock[] = [
        { type: "header", text: { type: "plain_text", text: "Digest" } },
        {
          type: "section",
          block_id: "thought_abc",
          text: { type: "mrkdwn", text: "some thought" },
        },
        {
          type: "actions",
          block_id: "actions_abc",
          elements: [],
        },
        { type: "divider" },
        {
          type: "section",
          block_id: "thought_def",
          text: { type: "mrkdwn", text: "another thought" },
        },
        {
          type: "actions",
          block_id: "actions_def",
          elements: [],
        },
      ];

      const result = replaceActionsWithStatus(blocks, "abc", "Marked as acted on");

      // actions_abc should be replaced
      const replacedBlock = result.find((b) => b.block_id === "actions_abc");
      expect(replacedBlock?.type).toBe("section");
      expect(replacedBlock?.text?.text).toContain("Marked as acted on");
      expect(replacedBlock?.elements).toBeUndefined();

      // actions_def should remain unchanged
      const unchangedBlock = result.find((b) => b.block_id === "actions_def");
      expect(unchangedBlock?.type).toBe("actions");
    });
  });
});
