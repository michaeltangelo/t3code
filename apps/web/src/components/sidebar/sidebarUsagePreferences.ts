import type { ServerProvider } from "@t3tools/contracts";
import {
  cursorUsageWindowDetails,
  displayLimitWindows,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:sidebar-usage-preferences:v1";

export const SidebarUsageModeSchema = Schema.Literals(["compact", "detailed"]);
export type SidebarUsageMode = typeof SidebarUsageModeSchema.Type;

export const SidebarUsageUnitSchema = Schema.Literals(["left", "used"]);
export type SidebarUsageUnit = typeof SidebarUsageUnitSchema.Type;

const SidebarUsagePreferencesSchema = Schema.Struct({
  mode: SidebarUsageModeSchema,
  unit: SidebarUsageUnitSchema,
});
export type SidebarUsagePreferences = typeof SidebarUsagePreferencesSchema.Type;

export const DEFAULT_SIDEBAR_USAGE_PREFERENCES: SidebarUsagePreferences = {
  mode: "compact",
  unit: "left",
};

export function readSidebarUsagePreferences(): SidebarUsagePreferences {
  try {
    return (
      getLocalStorageItem(STORAGE_KEY, SidebarUsagePreferencesSchema) ??
      DEFAULT_SIDEBAR_USAGE_PREFERENCES
    );
  } catch (error) {
    console.error("Could not read sidebar usage preferences.", error);
    return DEFAULT_SIDEBAR_USAGE_PREFERENCES;
  }
}

export function saveSidebarUsagePreferences(preferences: SidebarUsagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, SidebarUsagePreferencesSchema);
  } catch (error) {
    console.error("Could not save sidebar usage preferences.", error);
  }
}

export function formatDisplayedPercent(usedPercent: number, unit: SidebarUsageUnit): number {
  const clampedUsed = Math.max(0, Math.min(100, usedPercent));
  return unit === "left" ? Math.round(100 - clampedUsed) : Math.round(clampedUsed);
}

export type UsageUrgencyTone = "normal" | "warning" | "critical";

export function resolveUsageUrgencyTone(usedPercent: number): UsageUrgencyTone {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
}

const WINDOW_KIND_PRIORITY: Record<LimitPoolWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Picks the tightest quota window (highest usedPercent, tie-broken by shorter cadence). */
export function selectHeadlineWindow(
  windows: readonly LimitPoolWindow[],
): LimitPoolWindow | undefined {
  return [...windows].sort(
    (left, right) =>
      right.usedPercent - left.usedPercent ||
      WINDOW_KIND_PRIORITY[left.kind] - WINDOW_KIND_PRIORITY[right.kind],
  )[0];
}

export function shortWindowTag(
  driver: ServerProvider["driver"],
  window: LimitPoolWindow,
  pool: LimitPool,
): string {
  if (driver === "antigravity") {
    if (window.id.startsWith("gemini-argon-")) return "Argon";
    if (window.id.startsWith("gemini-carbon-")) return "Carbon";
    if (window.id.startsWith("gemini-")) {
      return window.kind === "session" ? "Gem 5h" : "Gem wk";
    }
    if (window.id.startsWith("3p-")) {
      return window.kind === "session" ? "3P 5h" : "3P wk";
    }
  }
  if (driver === "cursor") {
    const details = cursorUsageWindowDetails(window.id, pool);
    if (window.id === "autoPercentUsed") return "Auto";
    if (window.id === "apiPercentUsed") return "API";
    if (window.id === "totalPercentUsed") return "Total";
    if (details?.label) return details.label;
  }
  if (window.kind === "session") return "5h";
  if (window.kind === "weekly") return "wk";
  if (window.kind === "monthly") return "mo";
  const prefix = window.label.split("·")[0]?.trim();
  return prefix || window.label;
}

export interface SummaryWindowItem {
  readonly key: string;
  readonly tag: string;
  readonly window: LimitPoolWindow;
}

/**
 * Selects inline summary windows for the sidebar footer in Detailed mode.
 * For Antigravity, collapses each model family (Gemini, Claude & GPT, Argon, Carbon)
 * to its most constrained window so all pools are visible at a glance.
 */
export function selectDetailedSummaryWindows(pool: LimitPool): readonly SummaryWindowItem[] {
  const windows = displayLimitWindows(pool);
  if (pool.driver === "antigravity") {
    const families = new Map<string, { label: string; windows: LimitPoolWindow[] }>();
    for (const window of windows) {
      const familyKey = window.id.startsWith("gemini-argon-")
        ? "argon"
        : window.id.startsWith("gemini-carbon-")
          ? "carbon"
          : window.id.startsWith("gemini-")
            ? "gemini"
            : window.id.startsWith("3p-")
              ? "3p"
              : window.id;
      const familyLabel =
        familyKey === "argon"
          ? "Argon"
          : familyKey === "carbon"
            ? "Carbon"
            : familyKey === "gemini"
              ? "Gem"
              : familyKey === "3p"
                ? "Claude/GPT"
                : (window.label.split("·")[0]?.trim() ?? window.label);
      const existing = families.get(familyKey);
      if (existing) {
        existing.windows.push(window);
      } else {
        families.set(familyKey, { label: familyLabel, windows: [window] });
      }
    }
    return [...families.entries()].flatMap(([key, group]) => {
      const tightest = selectHeadlineWindow(group.windows);
      return tightest ? [{ key, tag: group.label, window: tightest }] : [];
    });
  }

  return windows.slice(0, 3).map((window) => ({
    key: `${window.kind}:${window.id}`,
    tag: shortWindowTag(pool.driver, window, pool),
    window,
  }));
}
