// server/mistral-budget.ts
//
// Reads Pi's Mistral sign-in token and the two free Mistral platform billing
// reads. The token is re-read from ~/.pi/agent/auth.json on every fetch, is
// never written, and is never logged. Field names follow the proven parser in
// EmmanuelARB/pi-mistral-subscription (checked live against the platform).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MISTRAL_BASE_URL = "https://api.mistral.ai";
const BUDGET_URL = `${MISTRAL_BASE_URL}/v1/billing/budget`;
const SUBSCRIPTION_URL = `${MISTRAL_BASE_URL}/v1/billing/subscription`;

// Re-read on every fetch: never cache the token.
const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");

// The daemon allows 20 s per fetch; each request stays well under it.
const REQUEST_TIMEOUT_MS = 10_000;

export type BudgetUsage = {
  /** Share of the budget already used, as a percentage (0..100). */
  usedPct: number;
  initial: number;
  currency: string;
  resetAt: string | null;
};

export type MistralBilling = {
  plan: string | null;
  payAsYouGoEnabled: boolean | null;
  vibe: BudgetUsage | null;
};

export type TokenState =
  | { kind: "ready"; token: string; expiresAt: string | null }
  | { kind: "missing" }
  | { kind: "expired"; expiresAt: string };

export type BillingFailure =
  | { kind: "rejected"; status: number }
  | { kind: "error"; message: string };

export type BillingRead =
  | { ok: true; billing: MistralBilling }
  | { ok: false; failure: BillingFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function accessToken(mistral: Record<string, unknown>): string | null {
  // OAuth sign-in stores `access`; an api_key login stores `key`. Both
  // authorize the billing reads, so accept either.
  const token = mistral.access ?? (mistral.type === "api_key" ? mistral.key : null);
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Pi's stored Mistral sign-in, read fresh from disk each call. */
export async function readMistralToken(): Promise<TokenState> {
  let text: string;
  try {
    text = await readFile(AUTH_PATH, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "missing" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.mistral)) return { kind: "missing" };
  const token = accessToken(parsed.mistral);
  if (token === null) return { kind: "missing" };
  const expires = finiteNumber(parsed.mistral.expires);
  const expiresAt = expires !== null ? new Date(expires).toISOString() : null;
  if (expires !== null && expires <= Date.now()) {
    return { kind: "expired", expiresAt: expiresAt ?? new Date(0).toISOString() };
  }
  return { kind: "ready", token, expiresAt };
}

type EndpointRead = { status: number; payload: unknown } | null;

async function readJson(url: string, token: string): Promise<EndpointRead> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } catch {
    // Network failure or timeout; the message never carries the token.
    return null;
  }
}

function parseUsage(record: Record<string, unknown>): BudgetUsage | null {
  const usedPct = finiteNumber(record.usage_percentage);
  const initial = finiteNumber(record.initial_budget);
  if (usedPct === null || initial === null) return null;
  return {
    usedPct,
    initial,
    currency: typeof record.currency === "string" ? record.currency : "",
    resetAt: typeof record.reset_at === "string" ? record.reset_at : null,
  };
}

/**
 * The plan's current billing state. The budget read is the one that matters;
 * a failing subscription read only costs the plan name.
 */
export async function fetchMistralBilling(token: string): Promise<BillingRead> {
  const [budgetRead, subscriptionRead] = await Promise.all([
    readJson(BUDGET_URL, token),
    readJson(SUBSCRIPTION_URL, token),
  ]);

  if (budgetRead === null) {
    return { ok: false, failure: { kind: "error", message: "Mistral billing budget read failed or timed out" } };
  }
  if (budgetRead.status === 401 || budgetRead.status === 403) {
    return { ok: false, failure: { kind: "rejected", status: budgetRead.status } };
  }
  if (subscriptionRead !== null && (subscriptionRead.status === 401 || subscriptionRead.status === 403)) {
    return { ok: false, failure: { kind: "rejected", status: subscriptionRead.status } };
  }
  // HTTP 402 keeps its payload: an exhausted budget is still data, and a
  // payment-required body without numbers has no visible quota left. Any
  // other failing status means the read carried nothing usable.
  if (budgetRead.status >= 400 && budgetRead.status !== 402) {
    return {
      ok: false,
      failure: { kind: "error", message: `Mistral billing budget read returned HTTP ${budgetRead.status}` },
    };
  }

  const payload = isRecord(budgetRead.payload) ? budgetRead.payload : {};
  const vibe = isRecord(payload.vibe_budget) ? parseUsage(payload.vibe_budget) : null;

  const subscription = subscriptionRead !== null && isRecord(subscriptionRead.payload)
    ? subscriptionRead.payload
    : null;
  const planName = subscription?.plan_name;
  const payAsYouGo = subscription?.vibe_payg_enabled;

  return {
    ok: true,
    billing: {
      plan: typeof planName === "string" && planName.length > 0 ? planName : null,
      payAsYouGoEnabled: typeof payAsYouGo === "boolean" ? payAsYouGo : null,
      vibe,
    },
  };
}
