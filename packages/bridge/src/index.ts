/**
 * @mochi-maker/bridge — the live bridge (agent API design 5): Mochi Studio's bridge protocol,
 * version 1, between the editor (the host) and agents (clients), on 127.0.0.1:47831.
 */
export * from './protocol.js';
export { BridgeServer, type BridgeOptions } from './server.js';
export {
  BridgeClient,
  BridgeCallError,
  DEFAULT_URL,
  type BridgeEvent,
  type Welcome,
} from './client.js';
export { TokenStore, PairingCode, normalizeScopes } from './tokens.js';
