import { describe, expect, it } from "vitest";
import { agentChip, agentErrorKey, cleanKey, keyLooksValid, maskedKey } from "../whatsappAgent";

describe("WhatsApp Agent settings helpers", () => {
  const now = Date.parse("2026-10-28T10:00:00Z");

  it("status chip: connected, needs reconnect, error, rate-limited while it lasts, not connected", () => {
    expect(agentChip(null)).toBe("notConnected");
    expect(agentChip({ status: null, rateLimitedUntil: null })).toBe("notConnected");
    expect(agentChip({ status: "CONNECTED", rateLimitedUntil: null }, now)).toBe("connected");
    expect(agentChip({ status: "CONNECTED", rateLimitedUntil: "2026-10-28T10:01:00Z" }, now)).toBe("rateLimited");
    expect(agentChip({ status: "CONNECTED", rateLimitedUntil: "2026-10-28T09:59:00Z" }, now)).toBe("connected");
    expect(agentChip({ status: "NEEDS_RECONNECT", rateLimitedUntil: null }, now)).toBe("needsReconnect");
    expect(agentChip({ status: "ERROR", rateLimitedUntil: null }, now)).toBe("error");
    expect(agentChip({ status: "DISABLED", rateLimitedUntil: null }, now)).toBe("notConnected");
  });

  it("errors map to copy keys; unknown codes and raw text never reach the screen", () => {
    expect(agentErrorKey("INVALID_KEY", false)).toBe("waAgent.err.INVALID_KEY");
    expect(agentErrorKey("SOMETHING_ELSE", false)).toBe("waAgent.err.generic");
    expect(agentErrorKey(null, true)).toBe("waAgent.err.offline");
  });

  it("a pasted key loses spaces and line breaks; only the last 4 are ever shown", () => {
    expect(cleanKey("  abcd efgh\n1234 ")).toBe("abcdefgh1234");
    expect(keyLooksValid("short")).toBe(false);
    expect(keyLooksValid("abcdefgh1234")).toBe(true);
    expect(maskedKey("1234")).toBe("••••1234");
    expect(maskedKey(null)).toBe("");
  });
});
