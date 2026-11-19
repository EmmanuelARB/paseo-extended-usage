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

import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import { fetchClaudeUsage, resolveClaudeLogin } from "./claude-usage";

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
  if (scope.provider !== "pi") return [];
  const model = scope.model;
  if (model === undefined || !model.startsWith(CLAUDE_BRIDGE_MODEL_PREFIX)) return [];
  return [{ ...ACCOUNT, input: ACCOUNT_INPUT }];
}

async function fetchReport(): Promise<UsageReport> {
  const login = await resolveClaudeLogin();
  if (login === null) {
    throw new Error("No Claude login found in Claude Code's store or Pi's auth store");
  }
  return fetchClaudeUsage(login);
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
