// server/claude-usage.ts
//
// Fetches Claude subscription usage for sessions that run an Anthropic model
// through a provider the built-in Claude usage source does not claim (such as
// claude-bridge). Window mapping is adapted from getpaseo/paseo's built-in
// plugins/claude-usage-source/server/usage.ts (Apache-2.0), trimmed to the
// Linux file stores; the macOS Keychain path is deliberately omitted.
//
// Credentials: Claude Code's own store first (~/.claude/.credentials.json,
// which also carries the subscription tier), falling back to Pi's anthropic
// login in ~/.pi/agent/auth.json. Tokens are re-read on every fetch, are
// never written, and are never logged.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

// The daemon allows 20 s per fetch; the request stays well under it.
const REQUEST_TIMEOUT_MS = 10_000;

const PI_AUTH_PATH = join(homedir(), ".pi/agent/auth.json");

function claudeCredentialsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}

const ClaudeOauthSchema = z.object({
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: ClaudeOauthSchema.optional(),
});

const ApiNumberSchema = z.coerce.number().finite();

const ClaudeUsageWindowSchema = z.object({
  utilization: ApiNumberSchema,
  resets_at: z.string().nullish(),
});

// Model- and surface-scoped weekly limits live in a `limits[]` array rather
// than top-level `seven_day_<model>` keys. Entries are validated one at a
// time so a single malformed entry cannot take down the windows that already
// parsed from the top-level keys.
const ClaudeScopeLabelSchema = z
  .object({ id: z.string().nullish(), display_name: z.string().nullish() })
  .nullish();

const ClaudeLimitSchema = z.object({
  kind: z.string(),
  percent: ApiNumberSchema.nullish(),
  resets_at: z.string().nullish(),
  scope: z.object({ model: ClaudeScopeLabelSchema, surface: ClaudeScopeLabelSchema }).nullish(),
});

const ClaudeUsageResponseSchema = z.object({
  five_hour: ClaudeUsageWindowSchema.nullish(),
  seven_day: ClaudeUsageWindowSchema.nullish(),
  seven_day_opus: ClaudeUsageWindowSchema.nullish(),
  seven_day_omelette: ClaudeUsageWindowSchema.nullish(),
  // Deliberately permissive: shape validation happens per entry.
  limits: z.array(z.unknown()).nullish(),
  extra_usage: z.object({ is_enabled: z.boolean().optional() }).nullish(),
});

const SCOPED_WEEKLY_KIND = "weekly_scoped";

export type ClaudeLogin = {
  /** Who refreshes this token: Claude Code or Pi. */
  refreshedBy: "claude" | "pi";
  accessToken: string;
  /** Epoch milliseconds, when the store carries an expiry. */
  expires: number | null;
  subscriptionType?: string;
  rateLimitTier?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Claude Code's own credentials file, or null when absent or unusable. */
async function readClaudeCodeLogin(): Promise<ClaudeLogin | null> {
  let text: string;
  try {
    text = await readFile(claudeCredentialsPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const creds = ClaudeCredentialsSchema.safeParse(parsed);
  const oauth = creds.success ? creds.data.claudeAiOauth : undefined;
  if (!oauth?.accessToken) return null;
  return {
    refreshedBy: "claude",
    accessToken: oauth.accessToken,
    expires: oauth.expiresAt ?? null,
    ...(oauth.subscriptionType !== undefined ? { subscriptionType: oauth.subscriptionType } : {}),
    ...(oauth.rateLimitTier !== undefined ? { rateLimitTier: oauth.rateLimitTier } : {}),
  };
}

/** Pi's stored Anthropic sign-in, read fresh from disk each call. */
async function readPiAnthropicLogin(): Promise<ClaudeLogin | null> {
  let text: string;
  try {
    text = await readFile(PI_AUTH_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.anthropic)) return null;
  const token = parsed.anthropic.access;
  if (typeof token !== "string" || token.length === 0) return null;
  const expires = parsed.anthropic.expires;
  return {
    refreshedBy: "pi",
    accessToken: token,
    expires: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
  };
}

/** Claude Code's store first, then Pi's anthropic login. */
export async function resolveClaudeLogin(): Promise<ClaudeLogin | null> {
  return (await readClaudeCodeLogin()) ?? (await readPiAnthropicLogin());
}

export function buildClaudePlan(
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | null {
  if (!subscriptionType) return null;
  const label = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const tier = rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

/**
 * A weekly limit scoped to one model or one surface, normalized away from
 * whichever shape of the response described it.
 */
interface ScopedLimit {
  dimension: "model" | "surface";
  /** The API's own identifier. Null on every response observed so far. */
  id: string | null;
  /** Display name, or the id when the API sends no display name. */
  name: string;
  usedPct: number | null;
  resetsAt: string | null;
}

// Windows that describe no particular model or surface.
const UNSCOPED_WINDOWS: ReadonlyArray<{
  field: "five_hour" | "seven_day";
  id: string;
  label: string;
  shortLabel: string;
  summary: boolean;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session", shortLabel: "5h", summary: true },
  { field: "seven_day", id: "weekly", label: "Weekly", shortLabel: "wk", summary: true },
];

// Scoped windows from before `limits[]` existed. Declaring the dimension here
// is what stops a *surface* named "Omelette" from being mistaken for the
// legacy Omelette *model* window: these keys are model-scoped by definition.
const LEGACY_SCOPED_WINDOWS: ReadonlyArray<{
  field: "seven_day_opus" | "seven_day_omelette";
  name: string;
}> = [
  { field: "seven_day_opus", name: "Opus" },
  { field: "seven_day_omelette", name: "Omelette" },
];

/** Fold a name down to the characters an id is allowed to carry. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether two descriptions denote the same limit: different dimensions are
 * never the same limit; matching API ids decide; otherwise the normalized
 * name is the only link between a legacy key and its `limits[]` counterpart.
 */
function isSameLimit(a: ScopedLimit, b: ScopedLimit): boolean {
  if (a.dimension !== b.dimension) return false;
  if (a.id && b.id) return a.id === b.id;
  return normalizeName(a.name) === normalizeName(b.name);
}

/**
 * Merge the legacy and `limits[]` descriptions into one limit per identity.
 * A `limits[]` entry wins on identity; each nullable field falls back to the
 * legacy twin instead of discarding a number the response did contain.
 */
function reconcileScopedLimits(
  legacy: ScopedLimit[],
  fromLimitsArray: ScopedLimit[],
): ScopedLimit[] {
  const reconciled = [...legacy];
  for (const limit of fromLimitsArray) {
    const index = reconciled.findIndex((candidate) => isSameLimit(candidate, limit));
    if (index === -1) {
      reconciled.push(limit);
      continue;
    }
    const twin = reconciled[index];
    reconciled[index] = {
      ...limit,
      usedPct: limit.usedPct ?? twin?.usedPct ?? null,
      resetsAt: limit.resetsAt ?? twin?.resetsAt ?? null,
    };
  }
  return reconciled;
}

function scopedLimitFromLegacy(
  spec: (typeof LEGACY_SCOPED_WINDOWS)[number],
  window: z.infer<typeof ClaudeUsageWindowSchema>,
): ScopedLimit {
  return {
    dimension: "model",
    id: null,
    name: spec.name,
    usedPct: window.utilization,
    resetsAt: window.resets_at ?? null,
  };
}

/** The scope of a `limits[]` entry, or null when it names nothing renderable. */
function scopedLimitFromEntry(limit: z.infer<typeof ClaudeLimitSchema>): ScopedLimit | null {
  for (const dimension of ["model", "surface"] as const) {
    const entry = limit.scope?.[dimension];
    const id = entry?.id?.trim() || null;
    const name = entry?.display_name?.trim() || id;
    if (name) {
      return {
        dimension,
        id,
        name,
        usedPct: limit.percent ?? null,
        resetsAt: limit.resets_at ?? null,
      };
    }
  }
  return null;
}

function scopedWindowId(limit: ScopedLimit): string {
  return `weekly_${limit.dimension}_${limit.id ?? normalizeName(limit.name)}`;
}

// Backstop for an entry whose verbatim id equals another entry's normalized
// name. Suffix rather than drop: a missing bar is worse than a suffixed id.
function uniqueWindowId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) return next;
  }
}

function legacyScopedLimits(resp: z.infer<typeof ClaudeUsageResponseSchema>): ScopedLimit[] {
  const limits: ScopedLimit[] = [];
  for (const spec of LEGACY_SCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (window) limits.push(scopedLimitFromLegacy(spec, window));
  }
  return limits;
}

function scopedLimitsFromResponse(
  limits: z.infer<typeof ClaudeUsageResponseSchema>["limits"],
): ScopedLimit[] {
  if (!limits) return [];
  const parsed: ScopedLimit[] = [];
  for (const entry of limits) {
    const result = ClaudeLimitSchema.safeParse(entry);
    if (!result.success) continue;
    if (result.data.kind !== SCOPED_WEEKLY_KIND) continue;
    const limit = scopedLimitFromEntry(result.data);
    if (limit) parsed.push(limit);
  }
  return parsed;
}

function unscopedWindows(resp: z.infer<typeof ClaudeUsageResponseSchema>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const spec of UNSCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (!window) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        shortLabel: spec.shortLabel,
        summary: spec.summary,
        utilizationPct: window.utilization,
        resetsAt: window.resets_at ?? null,
        tone: toneFromUsedPct(window.utilization),
      }),
    );
  }
  return windows;
}

function scopedWindows(limits: ScopedLimit[]): UsageWindow[] {
  const taken = new Set<string>();
  return limits.map((limit) => {
    const id = uniqueWindowId(scopedWindowId(limit), taken);
    taken.add(id);
    // Emitted even at 0%: a zero bar answers "how much of this model have I
    // used", and the bar must not come and go between refreshes.
    return windowFromUsedPct({
      id,
      label: `Weekly \u00b7 ${limit.name}`,
      shortLabel: `wk ${limit.name}`,
      utilizationPct: limit.usedPct,
      resetsAt: limit.resetsAt,
      tone: toneFromUsedPct(limit.usedPct),
    });
  });
}

/** Claude subscription usage for the resolved login. */
export async function fetchClaudeUsage(login: ClaudeLogin): Promise<UsageReport> {
  if (login.expires !== null && login.expires <= Date.now()) {
    return unavailable({
      kind: "expired",
      expiresAt: new Date(login.expires).toISOString(),
      refreshedBy: login.refreshedBy,
    });
  }

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
  } catch {
    // Network failure or timeout; the message never carries the token.
    return { status: "error", error: "Claude usage read failed or timed out" };
  }

  if (response.status === 401 || response.status === 403) {
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: login.refreshedBy });
  }
  if (response.status === 429) {
    return {
      status: "error",
      error: "Rate limited by the Claude usage API; retry after the indicated backoff",
    };
  }
  if (!response.ok) {
    return { status: "error", error: `Claude usage API returned ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "error", error: "Claude usage response was not valid JSON" };
  }
  const parsed = ClaudeUsageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: "error", error: "Claude usage response did not match the expected shape" };
  }
  const resp = parsed.data;

  const scoped = reconcileScopedLimits(
    legacyScopedLimits(resp),
    scopedLimitsFromResponse(resp.limits),
  );
  const windows = [...unscopedWindows(resp), ...scopedWindows(scoped)];
  if (windows.length === 0) {
    // The response parsed but described nothing; make it greppable.
    console.warn("Claude usage response parsed but produced no windows");
  }

  const details: UsageDetail[] = [];
  const extraUsageEnabled = resp.extra_usage?.is_enabled;
  if (extraUsageEnabled !== undefined) {
    details.push({
      id: "extra_usage",
      label: "Extra usage",
      value: extraUsageEnabled ? "Enabled" : "Disabled",
    });
  }

  return {
    status: "available",
    planLabel: buildClaudePlan(login.subscriptionType, login.rateLimitTier) ?? undefined,
    windows,
    balances: [],
    details,
  };
}
