/**
 * @mochi-maker/mcp — Mochi Maker's MCP server (agent API design 3): `mochi-maker mcp [project]
 * [--allow-dir dir]...` over stdio.
 */
export {
  MochiMcpServer,
  MAX_CALLS_PER_SECOND,
  MAX_COMMANDS,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  SERVER_VERSION,
  type ServerOptions,
} from './server.js';
export { serveStdio } from './stdio.js';
export { PathPolicy } from './paths.js';
export { PROMPTS } from './prompts.js';
export { docTopics, docText } from './docs.js';
