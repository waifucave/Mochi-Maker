/**
 * The bridge endpoint in the main process: the same bridge as `mochi-maker bridge`, so
 * agents and `mochi-maker mcp --bridge` reach the desktop app as they reach the browser editor.
 * The app's window is the person's own, so it pairs itself with the code the bridge makes.
 */
import { BridgeServer, DEFAULT_PORT } from '@mochi-maker/bridge';

export const APP_ORIGIN = 'mochi://app';

export interface DesktopBridge {
  server: BridgeServer;
  url: string;
  port: number;
}

/** Starts the bridge on 127.0.0.1; null (with the reason) when the port is taken. */
export async function startBridge(
  stateFile: string,
  options: { port?: number; log?: (line: string) => void } = {},
): Promise<DesktopBridge | { error: string }> {
  const server = new BridgeServer({
    port: options.port ?? DEFAULT_PORT,
    stateFile,
    allowOrigins: [APP_ORIGIN],
    onLog: options.log,
  });
  try {
    const port = await server.listen();
    return { server, port, url: `ws://127.0.0.1:${port}` };
  } catch (e) {
    await server.close().catch(() => undefined);
    return { error: `The bridge could not start: ${(e as Error).message}` };
  }
}
