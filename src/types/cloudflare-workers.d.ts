/**
 * The Workers globals used by `src/platform/cloudflare/`.
 *
 * `@cloudflare/workers-types` is installed for `wrangler`'s own tooling, but it
 * is not added to `compilerOptions.types`: its global lib replaces the DOM-ish
 * declarations Bun's types provide, which would break typechecking for every
 * other file in the repository. Only the handful of members the adapter
 * actually touches are declared here, following the same pattern as
 * `babel-preset-solid.d.ts`.
 */

/** Workers' server/client socket pair, indexed `[client, server]`. */
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface ResponseInit {
  /** Set on a 101 response to complete a WebSocket upgrade. */
  webSocket?: WebSocket | null;
}
