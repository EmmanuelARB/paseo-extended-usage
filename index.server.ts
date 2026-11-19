import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerClaudeBridgeUsageSource } from "./server/claude-usage-source";
import { registerMistralUsageSource } from "./server/mistral-usage-source";
import { registerPiOpencodeGoUsageSource } from "./server/opencode-go-usage-source";

export default function contribute(server: PluginServerContext) {
  registerMistralUsageSource(server);
  registerClaudeBridgeUsageSource(server);
  registerPiOpencodeGoUsageSource(server);
  return () => {};
}
