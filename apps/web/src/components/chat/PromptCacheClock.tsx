import { secondTick, toServerClock } from "@t3tools/client-runtime/clock";
import { promptCacheTone } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SnowflakeIcon, TimerIcon } from "lucide-react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const formatLeft = (leftMs: number) => {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Counts down until Claude's prompt cache for this thread goes cold. */
export function PromptCacheClock({
  environmentId,
  expiresAtMs,
  ttlMs,
}: {
  readonly environmentId: EnvironmentId;
  /** On the environment's clock. */
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}) {
  const gt = useGT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const localExpiresAtMs = expiresAtMs - toServerClock(environmentId, 0);
  const cold = useDeadlinePassed(localExpiresAtMs);
  const time = formatUpcomingTimestamp(new Date(localExpiresAtMs).toISOString(), timestampFormat);
  const ttl = ttlMs >= 60 * 60_000 ? gt("1 hour cache") : gt("5 minute cache");

  // The countdown writes through the DOM on the shared second tick, so it never re-renders the composer.
  const tick = (node: HTMLElement | null) => {
    if (!node || cold) return;
    const label = node.querySelector<HTMLElement>("[data-prompt-cache-left]");
    const write = () => {
      const leftMs = localExpiresAtMs - Date.now();
      node.dataset.tone = promptCacheTone(leftMs, ttlMs);
      if (label) label.textContent = formatLeft(leftMs);
    };
    write();
    return secondTick.subscribe(write);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            ref={tick}
            tabIndex={0}
            data-tone={cold ? "cold" : undefined}
            aria-label={
              cold ? gt("Prompt cache cold") : gt("Prompt cache warm until {time}", { time })
            }
            className="inline-flex h-7 shrink-0 cursor-default items-center gap-1 rounded-(--control-radius) px-1.5 text-muted-foreground text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[tone=ending]:text-error-foreground data-[tone=near]:text-warning-foreground sm:h-6"
          />
        }
      >
        {cold ? (
          <SnowflakeIcon aria-hidden className="size-3.5" />
        ) : (
          <TimerIcon aria-hidden className="size-3.5" />
        )}
        <span data-prompt-cache-left>{cold ? gt("Cold", { $context: "prompt cache" }) : null}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex max-w-64 flex-col gap-0.5">
          <span className="text-foreground">
            {cold
              ? gt("Claude's prompt cache went cold at {time}", { time })
              : gt("Claude's prompt cache stays warm until {time}", { time })}
          </span>
          <span className="text-muted-foreground">
            {cold
              ? gt("{ttl}. The next message reads the whole conversation again.", { ttl })
              : gt("{ttl}. A message sent before then reuses the cached conversation.", { ttl })}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
