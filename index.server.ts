import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerMistralUsageSource } from "./server/usage-source";

export default function contribute(server: PluginServerContext) {
  registerMistralUsageSource(server);
  return () => {};
}
