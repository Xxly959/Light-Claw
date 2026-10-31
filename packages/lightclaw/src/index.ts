/** Library entry point. Importing this module does not load credentials or start a transport. */

export type { LightClawConfig, LightClawFeatures, TransportKind } from "./config.js";
export { loadConfig } from "./config.js";
export { featureEnabled } from "./features.js";
export type { RuntimeOptions } from "./runtime.js";
export { createLightClawRuntime } from "./runtime.js";
export type { Attachment, ChannelStoreConfig, LoggedMessage } from "./store.js";
export { ChannelStore } from "./store.js";
export type { ChatChannel, ChatContext, ChatEvent, ChatHandler, ChatTransport, ChatUser } from "./transport.js";
