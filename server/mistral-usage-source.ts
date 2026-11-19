// server/mistral-usage-source.ts
//
// Registers the "mistral-usage" usage source so Paseo renders the Mistral plan
// budget in its native Usage modal card and agent popover. Paseo owns all UI:
// this file only feeds it a UsageReport.
//
// The Vibe budget becomes a percent window (tone-colored, with its reset
// date) because UsageBalance.unit has no EUR member; EUR amounts go in
// details lines instead. A usd balance is added only when the budget
// currency actually is USD.

import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import {
  fetchMistralBilling,
  readMistralToken,
  type BudgetUsage,
} from "./mistral-budget";

// Never a credential: it names the login store, nothing else.
const ACCOUNT_INPUT = { store: "pi-auth-mistral" } as const;

const ACCOUNT: Omit<UsageAccount, "input"> = {
  key: "pi-mistral-plan",
  label: "Mistral plan",
  harness: "Pi",
};

const EXPIRED_MISSING_SINCE = new Date(0).toISOString();

// Pi's Mistral provider IDs: the current `mistral` and the deprecated
// `mistral-subscription`. Session models look like "mistral/mistral-large-4".
const MISTRAL_MODEL_PREFIXES = ["mistral/", "mistral-subscription/"] as const;

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function formatAmount(amount: number, currency: string): string {
  const rounded = amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${rounded}` : `${rounded} ${currency}`.trim();
}

function remainingAmount(usage: BudgetUsage): number {
  return usage.initial * (1 - usage.usedPct / 100);
}

function isMistralSession(scope: UsageScope): boolean {
  if (scope.kind !== "session" || scope.provider !== "pi") return false;
  const model = scope.model;
  return model !== undefined && MISTRAL_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  // Session discovery feeds the agent popover. Claim only Pi sessions that
  // actually run a Mistral model; other providers and models return []
  // rather than throwing. Global discovery still lists the account, so the
  // Usage modal card shows the plan budget everywhere.
  if (scope.kind === "session" && !isMistralSession(scope)) return [];
  return [{ ...ACCOUNT, input: ACCOUNT_INPUT }];
}

async function fetchReport(): Promise<UsageReport> {
  const token = await readMistralToken();
  if (token.kind === "missing") {
    return unavailable({ kind: "expired", expiresAt: EXPIRED_MISSING_SINCE, refreshedBy: "pi" });
  }
  if (token.kind === "expired") {
    return unavailable({ kind: "expired", expiresAt: token.expiresAt, refreshedBy: "pi" });
  }

  const read = await fetchMistralBilling(token.token);
  if (!read.ok) {
    if (read.failure.kind === "rejected") {
      return unavailable({ kind: "rejected", status: read.failure.status, refreshedBy: "pi" });
    }
    return { status: "error", error: read.failure.message };
  }

  const { vibe, plan, payAsYouGoEnabled } = read.billing;
  if (vibe === null) {
    return unavailable({
      kind: "no_quota",
      detail: "No Mistral plan budget is visible for this account",
    });
  }

  const remaining = remainingAmount(vibe);
  const details: UsageDetail[] = [
    {
      id: "vibe-remaining",
      label: "Vibe",
      value: `${formatAmount(remaining, vibe.currency)} of ${formatAmount(vibe.initial, vibe.currency)} left`,
      tone: balanceToneFromRemaining(remaining),
    },
  ];
  if (payAsYouGoEnabled !== null) {
    details.push({
      id: "payg",
      label: "Pay-as-you-go",
      value: payAsYouGoEnabled ? "on" : "off",
    });
  }

  const balances: UsageBalance[] =
    vibe.currency.toUpperCase() === "USD"
      ? [
          {
            id: "vibe-balance",
            label: "Mistral plan",
            used: vibe.initial - remaining,
            remaining,
            limit: vibe.initial,
            unit: "usd",
            resetsAt: vibe.resetAt,
            tone: balanceToneFromRemaining(remaining),
          },
        ]
      : [];

  return {
    status: "available",
    planLabel: plan ?? undefined,
    windows: [
      windowFromUsedPct({
        id: "vibe-monthly",
        label: "Vibe budget",
        shortLabel: "Vibe",
        summary: true,
        utilizationPct: vibe.usedPct,
        resetsAt: vibe.resetAt,
        tone: toneFromUsedPct(vibe.usedPct),
      }),
    ],
    balances,
    details,
  };
}

export function registerMistralUsageSource(server: PluginServerContext): void {
  const source: UsageSourceRegistration = {
    id: "mistral-usage",
    label: "Mistral",
    input: z.object({ store: z.literal("pi-auth-mistral") }).strict(),
    discover,
    fetch: fetchReport,
  };
  server.registerUsageSource(source);
}
