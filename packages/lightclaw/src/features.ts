import type { LightClawConfig, LightClawFeatures } from "./config.js";

export function featureEnabled(config: LightClawConfig, name: keyof LightClawFeatures): boolean {
	return config.features?.[name] ?? true;
}
