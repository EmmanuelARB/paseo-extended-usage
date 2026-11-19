// server/usage-source.ts
//
// Registers the "mistral-usage" usage source so Paseo renders the Mistral plan
// budget in its native Usage modal card and agent popover. Paseo owns all UI:
// this file only feeds it a UsageReport.
//
// Windows carry percent + reset date (tone-colored) because UsageBalance.unit
// has no EUR member; EUR amounts go in details lines instead. A usd balance is
// added only when the budget currency actually is USD.

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

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

function formatAmount(amount: number, currency: string): string {
  const rounded = amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${rounded}` : `${rounded} ${currency}`.trim();
}

function remainingAmount(usage: BudgetUsage): number {
  return usage.initial * (1 - usage.usedPct / 100);
}

async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  // Session discovery feeds the agent popover. Pi runs on the Mistral
  // subscription, so every Pi session claims the account; other providers
  // return [] rather than throwing.
  if (scope.kind === "session" && scope.provider !== "pi") return [];
  return [{ ...ACCOUNT, input: ACCOUNT_INPUT }];
}

function budgetWindow(usage: BudgetUsage, id: "vibe-monthly" | "api-monthly", label: string, shortLabel: string, summary: boolean) {
  return windowFromUsedPct({
    id,
    label,
    shortLabel,
    summary,
    utilizationPct: usage.usedPct,
    resetsAt: usage.resetAt,
    tone: toneFromUsedPct(usage.usedPct),
  });
}

function remainingDetail(usage: BudgetUsage, id: "vibe-remaining" | "api-remaining", label: string): UsageDetail {
  return {
    id,
    label,
    value: `${formatAmount(remainingAmount(usage), usage.currency)} of ${formatAmount(usage.initial, usage.currency)} left`,
    tone: balanceToneFromRemaining(remainingAmount(usage)),
  };
}

function usdBalance(usage: BudgetUsage, id: "vibe-balance" | "api-balance", label: string): UsageBalance {
  const remaining = remainingAmount(usage);
  const used = usage.initial - remaining;
  return {
    id,
    label,
    used,
    remaining,
    limit: usage.initial,
    unit: "usd",
    resetsAt: usage.resetAt,
    tone: balanceToneFromRemaining(remaining),
  };
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

  const { vibe, api, plan, payAsYouGoEnabled } = read.billing;
  if (vibe === null && api === null) {
    return unavailable({
      kind: "no_quota",
      detail: "No Mistral budget is visible for this account",
    });
  }

  const windows = [];
  const details: UsageDetail[] = [];
  const balances: UsageBalance[] = [];
  if (vibe !== null) {
    windows.push(budgetWindow(vibe, "vibe-monthly", "Vibe budget", "Vibe", true));
    details.push(remainingDetail(vibe, "vibe-remaining", "Vibe"));
    if (vibe.currency.toUpperCase() === "USD") {
      balances.push(usdBalance(vibe, "vibe-balance", "Vibe budget"));
    }
  }
  if (api !== null) {
    windows.push(budgetWindow(api, "api-monthly", "API budget", "API", false));
    details.push(remainingDetail(api, "api-remaining", "API"));
    if (api.currency.toUpperCase() === "USD") {
      balances.push(usdBalance(api, "api-balance", "API budget"));
    }
  }
  if (payAsYouGoEnabled !== null) {
    details.push({
      id: "payg",
      label: "Pay-as-you-go",
      value: payAsYouGoEnabled ? "on" : "off",
    });
  }

  return {
    status: "available",
    planLabel: plan ?? undefined,
    windows,
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
