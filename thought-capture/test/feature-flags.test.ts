import {
  checkUserAccess,
  isThoughtCaptureEnabled,
  parseEnabledUserIds,
} from "../src/feature-flags";

describe("feature flags", () => {
  it("parses enabled user IDs with trimming and empty filtering", () => {
    const parsed = parseEnabledUserIds(" U1, ,U2 ,, U3 ");

    expect([...parsed]).toEqual(["U1", "U2", "U3"]);
  });

  it("treats THOUGHT_CAPTURE_V1_ENABLED=false as disabled", () => {
    const enabled = isThoughtCaptureEnabled({
      THOUGHT_CAPTURE_V1_ENABLED: "false",
    });

    expect(enabled).toBe(false);
  });

  it("rejects users when the allowlist is empty", () => {
    const result = checkUserAccess(
      {
        THOUGHT_CAPTURE_V1_ENABLED: "true",
        ENABLED_USER_IDS: "",
      },
      "U123"
    );

    expect(result).toEqual({
      allowed: false,
      reason: "user_not_enabled",
    });
  });

  it("allows only users present in ENABLED_USER_IDS", () => {
    const allowed = checkUserAccess(
      {
        THOUGHT_CAPTURE_V1_ENABLED: "true",
        ENABLED_USER_IDS: "U123,U456",
      },
      "U456"
    );

    const denied = checkUserAccess(
      {
        THOUGHT_CAPTURE_V1_ENABLED: "true",
        ENABLED_USER_IDS: "U123,U456",
      },
      "U999"
    );

    expect(allowed).toEqual({ allowed: true });
    expect(denied).toEqual({
      allowed: false,
      reason: "user_not_enabled",
    });
  });
});
