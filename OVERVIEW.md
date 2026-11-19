# Mistral usage

Shows your Mistral plan budget in Paseo's native Usage modal card and in the agent popover, exactly where Claude usage already appears. Paseo renders everything; this plugin only supplies the numbers.

## How it works

The plugin runs on the daemon and reads the Mistral sign-in that the Pi harness stores in `~/.pi/agent/auth.json`. It never writes that file and never logs the token. With that token it calls two free Mistral platform reads, `GET /v1/billing/budget` and `GET /v1/billing/subscription`, and maps them to a usage report: the Vibe plan budget appears as a percent window with its reset date, and the remaining EUR amount appears as a detail line such as "Vibe: €11.85 of €18.00 left".

## Setup

Requires Paseo 0.16.2 or later. Sign in to Mistral from Pi on the daemon machine first, so `~/.pi/agent/auth.json` contains a Mistral access token. No other configuration is needed.

## Capabilities and limits

- The agent popover claims the account on Pi sessions running a Mistral model only. Agents on other providers or models show nothing from this source.
- Reports are cached for five minutes by Paseo, so fresh spending may take a few minutes to appear.
- Budgets in EUR or GBP are shown as detail lines because the native balance unit only supports USD. A native USD balance is added only when the budget currency is actually USD.
- HTTP 402 with budget numbers still renders: an exhausted budget is data, colored by the native tone system.
- Missing or expired tokens show an expired card; rejected credentials show a rejected card; network or parse failures show an error on the card.
