import { ProviderDriverKind } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SIDEBAR_USAGE_PREFERENCES,
  formatDisplayedPercent,
  readSidebarUsagePreferences,
  resolveUsageUrgencyTone,
  saveSidebarUsagePreferences,
  selectDetailedSummaryWindows,
  selectHeadlineWindow,
  shortWindowTag,
} from "./sidebarUsagePreferences";

describe("sidebarUsagePreferences", () => {
  it("formats remaining and used percentages and clamps out-of-range inputs", () => {
    expect(formatDisplayedPercent(11.6, "left")).toBe(88);
    expect(formatDisplayedPercent(11.6, "used")).toBe(12);
    expect(formatDisplayedPercent(-5, "left")).toBe(100);
    expect(formatDisplayedPercent(120, "used")).toBe(100);
  });

  it("classifies urgency tones at 80% and 95% used thresholds", () => {
    expect(resolveUsageUrgencyTone(0)).toBe("normal");
    expect(resolveUsageUrgencyTone(79.9)).toBe("normal");
    expect(resolveUsageUrgencyTone(80)).toBe("warning");
    expect(resolveUsageUrgencyTone(94.9)).toBe("warning");
    expect(resolveUsageUrgencyTone(95)).toBe("critical");
  });

  it("selects the tightest window for compact headlines and groups Antigravity families in detailed mode", () => {
    const now = Date.parse("2026-11-16T08:00:00Z");
    const antigravityAccount: LimitAccount = {
      key: "env:antigravity",
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      email: "user@example.com",
      plan: "Google account",
      accentColor: undefined,
      environments: [],
      sourceLabel: null,
      redeem: null,
      limits: {
        checkedAt: "2026-11-16T08:00:00Z",
        windows: [
          {
            id: "gemini-5h",
            label: "Gemini · 5-hour",
            kind: "session",
            usedPercent: 0,
            windowDurationMins: 300,
          },
          {
            id: "gemini-weekly",
            label: "Gemini · Weekly",
            kind: "weekly",
            usedPercent: 5,
            windowDurationMins: 10080,
          },
          {
            id: "3p-5h",
            label: "Claude & GPT (shared) · 5-hour",
            kind: "session",
            usedPercent: 20,
            windowDurationMins: 300,
          },
          {
            id: "3p-weekly",
            label: "Claude & GPT (shared) · Weekly",
            kind: "weekly",
            usedPercent: 10,
            windowDurationMins: 10080,
          },
          {
            id: "gemini-argon-wtu-weekly",
            label: "Gemini 4 Argon · Weekly",
            kind: "weekly",
            usedPercent: 12,
            windowDurationMins: 10080,
          },
        ],
      },
    };
    const [pool] = collectLimitPools([antigravityAccount], now);
    expect(pool).toBeDefined();
    const headline = selectHeadlineWindow(pool!.windows);
    expect(headline?.id).toBe("3p-5h");
    expect(shortWindowTag(ProviderDriverKind.make("antigravity"), headline!, pool!)).toBe("3P 5h");

    const detailed = selectDetailedSummaryWindows(pool!);
    expect(detailed.map((item) => ({ tag: item.tag, used: item.window.usedPercent }))).toEqual([
      { tag: "Gem", used: 5 },
      { tag: "Argon", used: 12 },
      { tag: "Claude/GPT", used: 20 },
    ]);
  });

  it("persists and reads preferences via localStorage", () => {
    expect(readSidebarUsagePreferences()).toEqual(DEFAULT_SIDEBAR_USAGE_PREFERENCES);
    saveSidebarUsagePreferences({ mode: "detailed", unit: "used" });
    expect(readSidebarUsagePreferences()).toEqual({ mode: "detailed", unit: "used" });
    saveSidebarUsagePreferences(DEFAULT_SIDEBAR_USAGE_PREFERENCES);
  });
});
