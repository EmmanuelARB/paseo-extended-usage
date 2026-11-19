// server/claude-usage-source.ts
//
// Registers the "claude-bridge" usage source so Paseo's agent popover shows
// Claude subscription usage on Pi sessions that run an Anthropic model
// through a provider the built-in Claude source does not claim. The built-in
// source matches sessions on `anthropic/…` models only; this source claims
// `claude-bridge/…` models.
//
// Global discovery returns [] deliberately: the built-in Claude source
// already lists these logins in the Usage modal, and a second card would
// duplicate it. This source exists for the session popover alone.
//
// Credentials try Claude Code's store first (it carries the subscription
// tier), then Pi's anthropic login. A login expired by its own store is
// skipped, and a 401/403 from the usage API falls through to the next
// candidate, because Claude Code's file can hold a stale token: its CLI
// refreshes lazily, so presence alone proves nothing.

import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import {
  claudeLoginCandidates,
  fetchClaudeUsage,
  resolveClaudeLogins,
  type ClaudeLogin,
} from "./claude-usage";

// Never a credential: it names the login stores, nothing else.
const ACCOUNT_INPUT = { store: "claude-bridge" } as const;

const ACCOUNT: Omit<UsageAccount, "input"> = {
  key: "pi-claude-bridge",
  label: "Claude (claude-bridge)",
  harness: "Pi",
};

const CLAUDE_BRIDGE_MODEL_PREFIX = "claude-bridge/";

async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind === "global") return [];
  // Diagnostic: log what the daemon passes for this session. Env values stay
  // unread; provider and model are not credentials.
  console.log(
    `[claude-bridge] session discovery: provider=${JSON.stringify(scope.provider)} model=${JSON.stringify(scope.model ?? null)}`,
  );
  // Shape 1: a Pi session running a claude-bridge model (provider "pi",
  // model "claude-bridge/claude-…").
  const piSessionWithBridgeModel =
    scope.provider === "pi" &&
    scope.model !== undefined &&
    scope.model.startsWith(CLAUDE_BRIDGE_MODEL_PREFIX);
  // Shape 2: a custom Paseo provider named claude-bridge that wraps the Pi
  // harness; the bridge shows up as the session provider itself.
  const bridgeProvider = scope.provider === "claude-bridge";
  if (!piSessionWithBridgeModel && !bridgeProvider) return [];
  return [{ ...ACCOUNT, input: ACCOUNT_INPUT }];
}

/** Every candidate in order until one reports something other than rejected. */
async function fetchWithFallback(candidates: ClaudeLogin[]): Promise<UsageReport> {
  let last: UsageReport | null = null;
  for (const login of candidates) {
    const report = await fetchClaudeUsage(login);
    if (report.status === "unavailable" && report.problem.kind === "rejected") {
      last = report;
      continue;
    }
    return report;
  }
  return last ?? { status: "error", error: "No Claude login to read" };
}

async function fetchReport(): Promise<UsageReport> {
  const logins = await resolveClaudeLogins();
  const candidates = claudeLoginCandidates(logins);
  if (candidates.length > 0) return fetchWithFallback(candidates);

  // No candidate is fresh: report the primary login's state (expired, or
  // rejected when the store claims no expiry but the token is dead).
  const fallback = logins.claudeCode ?? logins.pi;
  if (fallback === null) {
    throw new Error("No Claude login found in Claude Code's store or Pi's auth store");
  }
  return fetchClaudeUsage(fallback);
}

export function registerClaudeBridgeUsageSource(server: PluginServerContext): void {
  const source: UsageSourceRegistration = {
    id: "claude-bridge",
    label: "Claude (claude-bridge)",
    input: z.object({ store: z.literal("claude-bridge") }).strict(),
    discover,
    fetch: fetchReport,
  };
  server.registerUsageSource(source);
}
