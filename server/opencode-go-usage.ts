// server/opencode-go-usage.ts
//
// Reads the OpenCode Go API key that the Pi harness stores in
// ~/.pi/agent/auth.json and fetches the OpenCode Go usage endpoint. Window
// mapping mirrors getpaseo/paseo's built-in plugins/opencode-go-usage-source
// (Apache-2.0), which is global-only and reads the OpenCode CLI's own store;
// this module exists so Pi sessions running opencode-go models get a popover.
//
// The key is an api_key with no expiry: there is no expired state. It is
// re-read from disk on every fetch, is never written, and is never logged.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

import { MONTH_MS, WEEK_MS, withRunsOutForecast } from "./usage-forecast";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Re-read on every fetch: never cache the key.
const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");

// The daemon allows 20 s per fetch; the request stays well under it.
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi's stored OpenCode Go key, read fresh from disk each call. */
export async function readPiOpencodeGoKey(): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(AUTH_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["opencode-go"])) return null;
  const key = parsed["opencode-go"].key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

const GoWindowSchema = z.object({
  // Tolerant on purpose: status vocabulary may grow, and a stricter enum
  // would fail the whole report over one new value.
  status: z.string(),
  percent: z.number().finite(),
  resetsAt: z.string(),
});

type GoWindow = z.infer<typeof GoWindowSchema>;

function parseWindow(value: unknown): GoWindow | null {
  const result = GoWindowSchema.safeParse(value);
  return result.success ? result.data : null;
}

// Window ids follow the built-in source so saved pins keep their meaning.
const GO_WINDOWS: ReadonlyArray<{
  field: "rolling" | "weekly" | "monthly";
  id: string;
  label: string;
  shortLabel: string;
  /** Null when the length is not reported, so no forecast is made. */
  durationMs: number | null;
}> = [
  // The rolling window's length is not reported, so its percent stands
  // without a short name, as in the built-in source.
  { field: "rolling", id: "rolling", label: "Rolling", shortLabel: "", durationMs: null },
  { field: "weekly", id: "weekly", label: "Weekly", shortLabel: "wk", durationMs: WEEK_MS },
  { field: "monthly", id: "monthly", label: "Monthly", shortLabel: "mo", durationMs: MONTH_MS },
];

/** OpenCode Go quota windows for the given key. */
export async function fetchGoUsage(key: string): Promise<UsageReport> {
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout; the message never carries the key.
    return { status: "error", error: "OpenCode Go usage read failed or timed out" };
  }

  if (response.status === 401 || response.status === 403) {
    // 403 also covers the platform's EntitlementError for keys it does not
    // consider entitled, which the card should surface either way.
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "pi" });
  }
  if (!response.ok) {
    return { status: "error", error: `OpenCode Go usage API returned ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "error", error: "OpenCode Go usage response was not valid JSON" };
  }
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};

  const windows: UsageWindow[] = [];
  for (const spec of GO_WINDOWS) {
    const window = parseWindow(usage[spec.field]);
    if (window === null) continue;
    windows.push(
      withRunsOutForecast(
        windowFromUsedPct({
          id: spec.id,
          label: spec.label,
          // An empty short label shows the percent alone, matching the built-in.
          ...(spec.shortLabel !== "" ? { shortLabel: spec.shortLabel } : {}),
          utilizationPct: window.percent,
          resetsAt: window.resetsAt,
          tone: toneFromUsedPct(window.percent),
        }),
        spec.durationMs,
      ),
    );
  }
  if (windows.length === 0) {
    return {
      status: "error",
      error: "OpenCode Go usage response parsed but produced no windows",
    };
  }

  return { status: "available", planLabel: "Go", windows };
}
