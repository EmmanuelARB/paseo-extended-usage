# Extended usage

Adds usage sources to Paseo's native Usage UI for accounts the built-in sources do not cover. Paseo renders the cards and popovers; this plugin only reads credentials and vendor billing APIs on the daemon machine.

## What it shows

**Mistral plan budget.** The Vibe plan budget appears as a percent window with its reset date, with the remaining EUR amount as a detail line such as "Vibe: €11.85 of €18.00 left", the pay-as-you-go state, and the plan name. The agent popover appears on Pi sessions running a Mistral model. Requires Pi signed in to Mistral on the daemon machine.

**Claude usage on bridged Pi sessions.** Paseo's built-in Claude source claims Pi sessions only when the model id starts with "anthropic/". This plugin claims sessions running models through a bridged provider such as "claude-bridge/…" and reports the same Claude subscription usage: session, weekly, and model-scoped weekly windows. It adds no card to the Usage modal, since the built-in Claude source already lists those logins. Requires a Claude login in Claude Code's store or Pi's own auth store.

## Setup

Requires Paseo 0.16.2 or later. No settings; each source finds its own login stores. Tokens are read-only, re-read on every fetch, never written, and never logged.

## Limits

- Reports are cached for five minutes by Paseo, so fresh spending may take a few minutes to appear.
- Budgets in EUR or GBP are shown as detail lines because the native balance unit only supports USD.
- Missing or expired tokens show an expired card; rejected credentials show a rejected card; network or parse failures show an error on the card.
- The Claude window mapping follows the built-in Claude usage source, minus the macOS Keychain path.
