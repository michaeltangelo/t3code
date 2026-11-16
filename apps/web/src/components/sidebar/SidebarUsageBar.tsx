import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  CHATGPT_USAGE_URL,
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceRemainingPercent,
  resetCreditChoices,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowUpDownIcon,
  ChartNoAxesColumnIcon,
  ExternalLinkIcon,
  SlidersHorizontalIcon,
  TicketIcon,
} from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { OpenAI } from "../Icons";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  barColor,
  PaceIcon,
  ResetCreditDialog,
  usePaceMark,
  useResetCredit,
} from "../usage/UsageLimits";
import {
  formatDisplayedPercent,
  readSidebarUsagePreferences,
  resolveUsageUrgencyTone,
  saveSidebarUsagePreferences,
  selectDetailedSummaryWindows,
  selectHeadlineWindow,
  shortWindowTag,
  type SidebarUsageMode,
  type SidebarUsagePreferences,
  type SidebarUsageUnit,
  type UsageUrgencyTone,
} from "./sidebarUsagePreferences";

const MINUTE_MS = 60_000;
const AUTO_REFRESH_INTERVAL_MS = 5 * MINUTE_MS;

function urgencyBarColor(tone: UsageUrgencyTone, fallbackColor: string): string {
  if (tone === "critical") return "var(--destructive)";
  if (tone === "warning") return "var(--warning)";
  return fallbackColor;
}

function urgencyTextClass(tone: UsageUrgencyTone): string {
  if (tone === "critical") return "text-destructive font-semibold";
  if (tone === "warning") return "text-warning font-semibold";
  return "text-sidebar-foreground font-medium";
}

function formatUpdatedAgo(checkedAtIso: string, now: number): string {
  const checkedAt = Date.parse(checkedAtIso);
  if (!Number.isFinite(checkedAt)) return "";
  const elapsed = Math.max(0, now - checkedAt);
  if (elapsed < MINUTE_MS) return "updated just now";
  return `updated ${formatDuration(elapsed)} ago`;
}

function latestPoolCheckedAt(pool: LimitPool): string | undefined {
  return pool.accounts.reduce<string | undefined>((latest, account) => {
    if (!latest) return account.limits.checkedAt;
    return Date.parse(account.limits.checkedAt) > Date.parse(latest)
      ? account.limits.checkedAt
      : latest;
  }, undefined);
}

function MiniUsageMeter({
  usedPercent,
  unit,
  color,
  tone,
  className,
}: {
  readonly usedPercent: number;
  readonly unit: SidebarUsageUnit;
  readonly color: string;
  readonly tone: UsageUrgencyTone;
  readonly className?: string;
}) {
  const fillPercent = formatDisplayedPercent(usedPercent, unit);
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-foreground/12",
        className,
      )}
    >
      {fillPercent > 0 ? (
        <span
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${fillPercent}%`,
            backgroundColor: urgencyBarColor(tone, color),
          }}
        />
      ) : null}
    </span>
  );
}

function PopoverWindowBar({
  window,
  unit,
  color,
  now,
}: {
  readonly window: LimitPoolWindow;
  readonly unit: SidebarUsageUnit;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const firstMember = window.members[0]?.window;
  const timeLeft = firstMember ? paceRemainingPercent(firstMember, now) : null;
  const pacePosition =
    timeLeft === null
      ? null
      : unit === "left"
        ? timeLeft
        : Math.max(0, Math.min(100, 100 - timeLeft));
  const [barRef, paceMark] = usePaceMark(pacePosition);
  const displayedPercent = formatDisplayedPercent(window.usedPercent, unit);
  const tone = resolveUsageUrgencyTone(window.usedPercent);
  const fillColor = urgencyBarColor(tone, color);
  const nextReset = window.resets[0];
  const resetsIn =
    nextReset && nextReset.at > now
      ? `resets in ${formatDuration(nextReset.at - now)}`
      : firstMember
        ? formatResetsIn(firstMember, now)
        : null;
  const resetsAtIso = nextReset?.member.window.resetsAt ?? firstMember?.resetsAt;
  const resetsAt = resetsAtIso ? formatUpcomingTimestamp(resetsAtIso, timestampFormat, now) : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={barRef}
            role="img"
            aria-label={`${window.label}: ${displayedPercent}% ${unit}${resetsIn ? `, ${resetsIn}` : ""}`}
            className="relative h-4 cursor-default rounded-full outline-none"
          />
        }
      >
        <div className="absolute inset-0" style={paceMark?.gap}>
          <div className="absolute inset-x-0 inset-y-1 rounded-full bg-muted" />
          {displayedPercent > 0 ? (
            <div
              className="absolute inset-y-1 left-0 rounded-full transition-[width] duration-200"
              style={{ width: `${displayedPercent}%`, backgroundColor: fillColor }}
            />
          ) : null}
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {window.remainingPercent}% left · {window.usedPercent}% used
            {timeLeft !== null ? ` · ${timeLeft}% of window left` : ""}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">
              The tick marks even spending across the window.
            </span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function AccountRedeemRow({
  account,
  now,
}: {
  readonly account: LimitAccount;
  readonly now: number;
}) {
  if (!account.redeem || !account.limits.resetCredits) return null;
  return (
    <AccountRedeemRowInner
      account={account}
      redeemAt={account.redeem}
      credits={account.limits.resetCredits}
      now={now}
    />
  );
}

function AccountRedeemRowInner({
  account,
  redeemAt,
  credits,
  now,
}: {
  readonly account: LimitAccount;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly credits: NonNullable<LimitAccount["limits"]["resetCredits"]>;
  readonly now: number;
}) {
  const redeem = useResetCredit(redeemAt.environmentId);
  const choices = resetCreditChoices(credits, redeemAt.input, now, true);
  if (credits.availableCount === 0 && !redeem.status) return null;
  return (
    <div className="flex flex-col gap-1 pt-1 text-2xs text-muted-foreground">
      {choices.map((choice) => (
        <div key={choice.key} className="flex items-center gap-2">
          <TicketIcon className="size-3 shrink-0 text-foreground/70" aria-hidden />
          <span className="truncate tabular-nums">{choice.summary}</span>
          {choice.availableCount > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders}
              className="ms-auto"
              onClick={() => redeem.confirm(choice)}
            >
              {redeem.busy ? "Using…" : choice.actionLabel}
            </Button>
          ) : null}
        </div>
      ))}
      {redeem.status ? (
        <span className="text-foreground">
          {account.displayName ?? account.email ?? account.driver}: {redeem.status}
        </span>
      ) : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </div>
  );
}

function PopoverPoolSection({
  pool,
  mode,
  unit,
  now,
}: {
  readonly pool: LimitPool;
  readonly mode: SidebarUsageMode;
  readonly unit: SidebarUsageUnit;
  readonly now: number;
}) {
  const baseColor = barColor(pool.driver);
  const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const checkedAt = latestPoolCheckedAt(pool);
  const updatedLabel = checkedAt ? formatUpdatedAgo(checkedAt, now) : "";
  const singleAccount = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
  const color = normalizeProviderAccentColor(singleAccount?.accentColor) ?? baseColor;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={singleAccount?.displayName ?? driverLabel}
          accentColor={singleAccount?.accentColor}
          indicatorBackground="var(--popover)"
          className="size-4 shrink-0"
          iconClassName="size-3.5 text-foreground/85"
        />
        <span className="truncate text-xs font-semibold text-foreground">{driverLabel}</span>
        {singleAccount?.plan ? (
          <span className="truncate rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
            {singleAccount.plan}
          </span>
        ) : pool.accounts.length > 1 ? (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground tabular-nums">
            {pool.accounts.length} accounts
          </span>
        ) : null}
        {updatedLabel ? (
          <span className="ms-auto shrink-0 text-3xs text-muted-foreground tabular-nums">
            {updatedLabel}
          </span>
        ) : null}
      </div>

      {singleAccount?.email ? (
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <RedactedSensitiveText
            value={singleAccount.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit text-2xs"
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {windows.map((window) => {
          const details =
            pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
          const label = details?.label === null ? driverLabel : (details?.label ?? window.label);
          const displayed = formatDisplayedPercent(window.usedPercent, unit);
          const tone = resolveUsageUrgencyTone(window.usedPercent);
          const nextReset = window.resets[0];
          const firstMember = window.members[0]?.window;
          const resetCountdown =
            nextReset && nextReset.at > now
              ? `↻ ${formatDuration(nextReset.at - now)}`
              : firstMember
                ? (formatResetsIn(firstMember, now)?.replace("resets in ", "↻ ") ?? null)
                : null;

          return (
            <div key={`${window.kind}:${window.id}`} className="flex flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5 text-2xs">
                <span className="min-w-0 truncate text-muted-foreground">{label}</span>
                {window.pace ? <PaceIcon pace={window.pace} /> : null}
                {resetCountdown ? (
                  <span className="ms-auto shrink-0 text-3xs text-muted-foreground tabular-nums">
                    {resetCountdown}
                  </span>
                ) : null}
                <span
                  className={cn(
                    resetCountdown ? "shrink-0" : "ms-auto shrink-0",
                    "tabular-nums",
                    urgencyTextClass(tone),
                  )}
                >
                  {displayed}% {unit}
                </span>
              </div>
              <PopoverWindowBar window={window} unit={unit} color={color} now={now} />
              {mode === "detailed" && window.members.length > 1 ? (
                <div className="mt-0.5 flex flex-col gap-0.5 ps-2 text-3xs text-muted-foreground">
                  {window.members.map((member) => {
                    const memberDisplayed = formatDisplayedPercent(member.window.usedPercent, unit);
                    const memberResets = formatResetsIn(member.window, now)?.replace(
                      "resets in ",
                      "↻ ",
                    );
                    return (
                      <div key={member.account.key} className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">
                          {member.account.displayName ??
                            member.account.email ??
                            providerClients.get(member.account.driver)?.label ??
                            member.account.driver}
                        </span>
                        {memberResets ? (
                          <span className="ms-auto shrink-0 tabular-nums">{memberResets}</span>
                        ) : null}
                        <span
                          className={cn(
                            memberResets ? "shrink-0" : "ms-auto shrink-0",
                            "font-medium text-foreground tabular-nums",
                          )}
                        >
                          {memberDisplayed}% {unit}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {pool.accounts.map((account) => (
        <AccountRedeemRow key={account.key} account={account} now={now} />
      ))}
    </section>
  );
}

export const SidebarUsageBar = memo(function SidebarUsageBar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [preferences, setPreferences] = useState<SidebarUsagePreferences>(
    readSidebarUsagePreferences,
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);

  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const updatePreferences = (patch: Partial<SidebarUsagePreferences>) => {
    setPreferences((prev) => {
      const next = { ...prev, ...patch };
      saveSidebarUsagePreferences(next);
      return next;
    });
  };

  const toggleUnit = () => {
    updatePreferences({ unit: preferences.unit === "left" ? "used" : "left" });
  };

  const refreshAllLimits = (automatic: boolean) =>
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).finally(() => {
      setNow(Date.now());
    });

  const handleManualRefresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshAllLimits(false).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  const autoRefreshLimits = useEffectEvent(() => {
    void refreshAllLimits(true);
  });

  const connectedEnvironmentKeys = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits when connected environments become ready and polls periodically for perpetual sidebar display
  useEffect(() => {
    if (!connectedEnvironmentKeys) return;
    autoRefreshLimits();
    const refreshTimer = window.setInterval(() => {
      autoRefreshLimits();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(refreshTimer);
  }, [connectedEnvironmentKeys]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances the minute clock so reset countdowns and pace ticks stay current in the perpetual sidebar bar
  useEffect(() => {
    const clockTimer = window.setInterval(() => {
      setNow(Date.now());
    }, MINUTE_MS);
    return () => window.clearInterval(clockTimer);
  }, []);

  const accounts = collectLimitAccounts(presentationsWithProviders);
  const pools = collectLimitPools(accounts, now);
  const notices = collectLimitNotices(presentationsWithProviders);
  const externalLinks = collectExternalUsageLinks(presentationsWithProviders);

  if (pools.length === 0 && notices.length === 0) {
    return null;
  }

  const navigateFromPopover = (to: "/usage" | "/settings/providers") => {
    setPopoverOpen(false);
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Agent usage limits"
            data-testid="sidebar-usage-bar"
            className={cn(
              "group/usage-bar flex w-full shrink-0 flex-col gap-1.5 rounded-lg bg-sidebar-control-surface px-2.5 py-2 text-left text-2xs text-sidebar-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[popup-open]:bg-sidebar-row-hover",
            )}
          />
        }
      >
        {preferences.mode === "compact" ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            {pools.map((pool) => {
              const windows = displayLimitWindows(pool);
              const headline = selectHeadlineWindow(windows);
              if (!headline) return null;
              const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
              const singleAccount = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
              const color =
                normalizeProviderAccentColor(singleAccount?.accentColor) ?? barColor(pool.driver);
              const displayed = formatDisplayedPercent(headline.usedPercent, preferences.unit);
              const tone = resolveUsageUrgencyTone(headline.usedPercent);
              const tag = shortWindowTag(pool.driver, headline, pool);

              return (
                <span
                  key={pool.driver}
                  data-testid={`sidebar-usage-compact-${pool.driver}`}
                  className="inline-flex min-w-0 items-center gap-1.5"
                >
                  <ProviderInstanceIcon
                    driverKind={pool.driver}
                    displayName={singleAccount?.displayName ?? driverLabel}
                    accentColor={singleAccount?.accentColor}
                    indicatorBackground="var(--sidebar)"
                    className="size-3.5 shrink-0"
                    iconClassName="size-3 text-sidebar-foreground/85"
                  />
                  <MiniUsageMeter
                    usedPercent={headline.usedPercent}
                    unit={preferences.unit}
                    color={color}
                    tone={tone}
                  />
                  <span className={cn("tabular-nums leading-none", urgencyTextClass(tone))}>
                    {displayed}%
                  </span>
                  {windows.length > 1 ? (
                    <span className="text-3xs leading-none text-muted-foreground">{tag}</span>
                  ) : null}
                </span>
              );
            })}
            {notices.length > 0 && pools.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-warning">
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                <span className="truncate">Usage notice</span>
              </span>
            ) : null}
            <span className="ms-auto shrink-0 rounded-sm bg-foreground/8 px-1 py-0.5 text-3xs leading-none font-medium text-muted-foreground">
              {preferences.unit}
            </span>
          </div>
        ) : (
          <div className="flex w-full min-w-0 flex-col gap-1.5">
            {pools.map((pool) => {
              const driverLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
              const singleAccount = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
              const color =
                normalizeProviderAccentColor(singleAccount?.accentColor) ?? barColor(pool.driver);
              const items = selectDetailedSummaryWindows(pool);

              return (
                <div
                  key={pool.driver}
                  data-testid={`sidebar-usage-detailed-${pool.driver}`}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <ProviderInstanceIcon
                    driverKind={pool.driver}
                    displayName={singleAccount?.displayName ?? driverLabel}
                    accentColor={singleAccount?.accentColor}
                    indicatorBackground="var(--sidebar)"
                    className="size-3.5 shrink-0"
                    iconClassName="size-3 text-sidebar-foreground/85"
                  />
                  <span className="shrink-0 font-medium text-sidebar-foreground/90">
                    {driverLabel}
                  </span>
                  <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
                    {items.map(({ key, tag, window }) => {
                      const displayed = formatDisplayedPercent(
                        window.usedPercent,
                        preferences.unit,
                      );
                      const tone = resolveUsageUrgencyTone(window.usedPercent);
                      return (
                        <span key={key} className="inline-flex items-center gap-1 tabular-nums">
                          <span className="text-3xs text-muted-foreground">{tag}</span>
                          <MiniUsageMeter
                            usedPercent={window.usedPercent}
                            unit={preferences.unit}
                            color={color}
                            tone={tone}
                            className="w-5"
                          />
                          <span className={cn("text-3xs", urgencyTextClass(tone))}>
                            {displayed}%
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PopoverTrigger>

      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        aria-label="Usage limits across agents"
        className="w-84 max-w-[calc(100vw-1.5rem)]"
      >
        <div className="flex flex-col gap-2.5">
          {/* Header */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
            <span className="text-xs font-semibold text-foreground">Usage · all agents</span>
            <div className="ms-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      aria-label={`Showing percentage ${preferences.unit}. Click to switch to ${preferences.unit === "left" ? "used" : "left"}`}
                      onClick={toggleUnit}
                    />
                  }
                >
                  <span>{preferences.unit === "left" ? "Left" : "Used"}</span>
                  <ArrowUpDownIcon className="size-3" aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  Switch between remaining (% left) and consumed (% used)
                </TooltipPopup>
              </Tooltip>

              <ToggleGroup
                aria-label="Usage display density"
                variant="segmented"
                size="sm"
                value={[preferences.mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "compact" || value === "detailed") {
                    updatePreferences({ mode: value });
                  }
                }}
              >
                <Toggle value="compact">Compact</Toggle>
                <Toggle value="detailed">Detailed</Toggle>
              </ToggleGroup>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Refresh usage limits"
                      disabled={isRefreshing}
                      onClick={handleManualRefresh}
                    />
                  }
                >
                  <RefreshIcon className="size-3.5" refreshing={isRefreshing} />
                </TooltipTrigger>
                <TooltipPopup side="top">Refresh usage limits</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {/* Body */}
          <div className="flex max-h-[min(26rem,calc(100vh-10rem))] flex-col gap-2.5 overflow-y-auto">
            {pools.map((pool) => (
              <PopoverPoolSection
                key={pool.driver}
                pool={pool}
                mode={preferences.mode}
                unit={preferences.unit}
                now={now}
              />
            ))}

            {externalLinks.map((link) => (
              <div
                key={link.url}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-2xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {link.url === CHATGPT_USAGE_URL ? (
                    <OpenAI className="size-3.5 shrink-0" aria-hidden />
                  ) : null}
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{link.label}</div>
                    <div className="truncate text-3xs text-muted-foreground">
                      {link.accounts.join(", ")}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost-muted"
                  size="xs"
                  className="shrink-0"
                  onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
                >
                  Open
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </Button>
              </div>
            ))}

            {notices.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-2xs text-warning">
                {notices.map((notice) => (
                  <div key={notice} className="flex items-start gap-1.5">
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span className="break-words">{notice}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
            <Button variant="ghost-muted" size="xs" onClick={() => navigateFromPopover("/usage")}>
              <ChartNoAxesColumnIcon className="size-3.5" aria-hidden />
              Usage details & history
            </Button>
            <Button
              variant="ghost-muted"
              size="xs"
              onClick={() => navigateFromPopover("/settings/providers")}
            >
              <SlidersHorizontalIcon className="size-3.5" aria-hidden />
              Providers
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
