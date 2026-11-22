// server/usage-forecast.ts
//
// "Runs out" forecast for a usage window, matching what Paseo's usage card
// renders from `runsOutAt` / `shortfallPct`. At the pace used so far in the
// window, the quota either lasts to the reset (no forecast) or runs out
// early: `runsOutAt` is when, `shortfallPct` is how much of the quota the
// pace would overshoot by at the reset.

import type { UsageWindow } from "@getpaseo/plugin/server/usage";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The window with forecast fields added when usage is on pace to exhaust the
 * quota before `resetsAt`. Returned untouched when the length of the window,
 * the reset time or the usage is unknown, or when nothing has been used yet.
 */
export function withRunsOutForecast(
  window: UsageWindow,
  windowMs: number | null,
  now: number = Date.now(),
): UsageWindow {
  const { usedPct, resetsAt } = window;
  if (windowMs === null || typeof usedPct !== "number" || !resetsAt) return window;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return window;

  const elapsedMs = windowMs - (resetMs - now);
  // Too little history for a pace, or a reset further away than the window.
  if (elapsedMs <= 0 || usedPct <= 0) return window;
  // Already exhausted: nothing to forecast.
  if (usedPct >= 100) return window;

  const projectedPct = (usedPct / elapsedMs) * windowMs;
  if (projectedPct <= 100) return window;

  const runsOutMs = now + ((100 - usedPct) / usedPct) * elapsedMs;
  return {
    ...window,
    runsOutAt: new Date(runsOutMs).toISOString(),
    shortfallPct: Math.round((projectedPct - 100) * 10) / 10,
  };
}

/**
 * Length of the calendar month that ends at `resetsAt`, for plans whose
 * monthly window runs from one reset to the next (Mistral resets on the 1st
 * at 1am). Null when the reset time is unparseable.
 */
export function monthEndingAtMs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const end = new Date(resetsAt);
  if (!Number.isFinite(end.getTime())) return null;
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return end.getTime() - start.getTime();
}
