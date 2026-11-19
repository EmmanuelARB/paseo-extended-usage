# paseo-extended-usage

A server-only [Paseo](https://paseo.sh) plugin that feeds Paseo's **native Usage UI** (the Usage modal card and the per-agent popover) with usage data the built-in sources do not cover. Paseo renders everything; the plugin only supplies `UsageReport`s through `server.registerUsageSource()` (Paseo 0.11+, manifest requires `>=0.16.2`).

## What it does

**Mistral plan budget (`mistral-usage` source).** Reads the Mistral sign-in that the [Pi harness](https://paseo.sh/pi) stores in `~/.pi/agent/auth.json` and calls two free Mistral platform reads, `GET /v1/billing/budget` and `GET /v1/billing/subscription`. The Vibe plan budget appears as a percent window with its reset date, the remaining EUR amount as a detail line (`Vibe: €11.85 of €18.00 left`), the pay-as-you-go state, and the plan name as the card label. The agent popover appears on Pi sessions running a `mistral/…` (or deprecated `mistral-subscription/…`) model; the Usage modal card lists the account globally.

**Claude usage on bridged sessions (`claude-bridge` source).** Paseo's built-in Claude source claims Pi sessions only when the model id starts with `anthropic/`. If you run Anthropic models through a bridged provider (for example `claude-bridge/claude-…`), the popover stays empty even though the Claude login exists. This source claims those sessions and reports the same Claude subscription usage the built-in source would: session (5h) and weekly windows plus any model-scoped weekly limits, from `GET https://api.anthropic.com/api/oauth/usage`. Credentials resolve from Claude Code's own store first (`~/.claude/.credentials.json`, which also carries the subscription tier for the card label), falling back to Pi's `anthropic` login in `~/.pi/agent/auth.json`. A login expired by its own store is skipped outright, and a 401/403 falls through to the next candidate, because Claude Code's file can hold a stale token: its CLI refreshes lazily, so the file's presence proves nothing about its validity. It deliberately contributes no global card, because the built-in Claude source already lists those logins in the Usage modal.

## Security and limits

- Tokens are read-only: re-read from disk on every fetch, never written, never logged. Error messages carry HTTP statuses only.
- Each request uses a 10 s timeout; Paseo enforces a 20 s deadline per fetch and caches reports for five minutes.
- Missing/expired tokens show an `expired` card, rejected credentials a `rejected` card, network or parse failures an error on the card, and an account with no visible budget `no_quota`.
- The Claude window mapping is adapted from the built-in `claude-usage-source` in [getpaseo/paseo](https://github.com/getpaseo/paseo) (Apache-2.0), trimmed to the Linux file stores: the macOS Keychain path is not included.
- HTTP 402 with budget numbers still renders: an exhausted budget is data, colored by the native tone system.

## Install

```bash
paseo plugin install github:EmmanuelARB/paseo-extended-usage
```

Then check `paseo plugin ls` for `paseo-extended-usage: running` and `paseo plugin logs paseo-extended-usage` for a clean start. Pi must be signed in to Mistral on the daemon machine for the Mistral source, and a Claude login must exist in Claude Code's store or Pi's auth store for the claude-bridge source. Source edits are picked up with `npm run typecheck && paseo plugin reload paseo-extended-usage`; never restart the daemon.

## Repository layout

```
paseo-plugin.json     manifest: id paseo-extended-usage, requires Paseo >=0.16.2
index.server.ts       server entry: registers both usage sources
server/mistral-budget.ts       token read + Mistral billing reads + defensive parse
server/mistral-usage-source.ts registration and report mapping for the Mistral plan
server/claude-usage.ts         Claude credential resolution + usage fetch + window mapping
server/claude-usage-source.ts  registration and session discovery for claude-bridge
OVERVIEW.md           registry listing page
```
