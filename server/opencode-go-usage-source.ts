// server/opencode-go-usage-source.ts
//
// Registers the "pi-opencode-go" usage source so Pi sessions running
// OpenCode Go models get Claude-style quota windows in the agent popover.
// Paseo's built-in opencode-go source is global-only and reads the OpenCode
// CLI's own store, so it never claims a session; this source reads the key
// the Pi harness stores instead. The id stays distinct from the built-in
// "opencode-go" so the two sources never collide.
//
// Global discovery lists the account only when Pi's key exists, so the Usage
// modal gains a card exactly when there is something to read. If the machine
// also has the OpenCode CLI configured, the built-in card appears beside it.

import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import { fetchGoUsage, readPiOpencodeGoKey } from "./opencode-go-usage";

// Never a credential: it names the login store, nothing else.
const ACCOUNT_INPUT = { store: "pi-auth-opencode-go" } as const;

const ACCOUNT: Omit<UsageAccount, "input"> = {
  key: "pi-opencode-go",
  label: "OpenCode Go (Pi)",
  harness: "Pi",
};

const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";

async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    // Shape 1: a Pi session running an OpenCode Go model.
    const piSessionWithGoModel =
      scope.provider === "pi" &&
      scope.model !== undefined &&
      scope.model.startsWith(OPENCODE_GO_MODEL_PREFIX);
    // Shape 2: a custom Paseo provider named opencode-go wrapping the Pi
    // harness, as claude-bridge turned out to be configured.
    const goProvider = scope.provider === "opencode-go";
    if (!piSessionWithGoModel && !goProvider) return [];
    return [{ ...ACCOUNT, input: ACCOUNT_INPUT }];
  }
  // Global: list only when Pi's key exists, so the modal never gains a card
  // that can only fail.
  return (await readPiOpencodeGoKey()) !== null ? [{ ...ACCOUNT, input: ACCOUNT_INPUT }] : [];
}

async function fetchReport(): Promise<UsageReport> {
  const key = await readPiOpencodeGoKey();
  if (key === null) {
    throw new Error("No OpenCode Go key found in Pi's auth store");
  }
  return fetchGoUsage(key);
}

export function registerPiOpencodeGoUsageSource(server: PluginServerContext): void {
  const source: UsageSourceRegistration = {
    id: "pi-opencode-go",
    label: "OpenCode Go (Pi)",
    input: z.object({ store: z.literal("pi-auth-opencode-go") }).strict(),
    discover,
    fetch: fetchReport,
  };
  server.registerUsageSource(source);
}
