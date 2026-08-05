/**
 * web-hooky - server entry point.
 */
import { configWarnings, loadConfig, USAGE } from "./config";
import { createRuntime } from "./runtime";
import type { ServerWebSocketLike, UpgradeCapableServer } from "./server/app";

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig(Bun.env, argv);
  if (config.ok === false) {
    console.error(`[web-hooky] configuration error: ${config.error.message}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config.value)) {
    console.warn(`[web-hooky] warning: ${warning}`);
  }

  const runtime = await createRuntime(config.value);
  if (runtime.ok === false) {
    console.error(`[web-hooky] startup failed: ${runtime.error.message}`);
    process.exit(1);
  }

  const { app } = runtime.value;
  const server = Bun.serve({
    hostname: config.value.host,
    port: config.value.port,
    async fetch(request: Request, bunServer: UpgradeCapableServer) {
      const response = await app.fetch(request, bunServer);
      // A null response means the request became a WebSocket connection.
      return response ?? undefined;
    },
    websocket: {
      open(socket: ServerWebSocketLike): void {
        app.websocket.open(socket);
      },
      close(socket: ServerWebSocketLike): void {
        app.websocket.close(socket);
      },
      message(socket: ServerWebSocketLike, message: unknown): void {
        app.websocket.message(socket, message);
      },
    },
  });

  console.log(
    `[web-hooky] listening on http://${config.value.host}:${server.port}`,
  );
  console.log("[web-hooky] inbound webhooks: POST /{addon}/{inboundUuid}");
  console.log("[web-hooky] fetch API:        GET  /_get/{fetchUuid}");
  console.log("[web-hooky] stream API:       WS   /_ws/{fetchUuid}");
  console.log("[web-hooky] admin UI/API:     /_admin/ and /_admin/api");

  const shutdown = (): void => {
    console.log("[web-hooky] shutting down");
    server.stop();
    void runtime.value.shutdown().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
