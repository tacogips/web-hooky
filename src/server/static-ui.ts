/**
 * Static asset serving for the SolidJS admin UI at `/_admin/`.
 */
import { join, normalize, resolve, sep } from "node:path";
import { errors } from "../core/errors";
import type { AppContext } from "./context";
import { errorResponse } from "./responses";

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>web-hooky admin</title></head>
  <body>
    <h1>web-hooky admin UI is not built</h1>
    <p>Run <code>bun run build:ui</code> to build the SolidJS admin UI, or set
      <code>WEBHOOKY_ADMIN_UI_DIR</code> to the directory holding the built assets.</p>
    <p>The full admin API remains available under <code>/_admin/api</code>.</p>
  </body>
</html>
`;

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  return (
    CONTENT_TYPES.get(path.slice(dot).toLowerCase()) ??
    "application/octet-stream"
  );
}

/** Resolves a request path to a file inside the UI directory, or null. */
export function resolveAssetPath(
  rootDir: string,
  relativePath: string,
): string | null {
  const cleaned = relativePath.replace(/^\/+/, "");
  if (cleaned.includes("\0")) {
    return null;
  }
  const root = resolve(rootDir);
  const candidate = resolve(join(root, normalize(cleaned)));
  if (candidate !== root && candidate.startsWith(`${root}${sep}`) === false) {
    return null;
  }
  return candidate;
}

async function readAsset(path: string): Promise<Response | null> {
  const file = Bun.file(path);
  if ((await file.exists()) === false) {
    return null;
  }
  return new Response(file, {
    headers: { "content-type": contentTypeFor(path) },
  });
}

/**
 * Serves the built single-page app. Unknown paths fall back to `index.html`
 * so client-side routing works; a missing build serves a placeholder page.
 */
export async function handleAdminUi(
  ctx: AppContext,
  pathname: string,
): Promise<Response> {
  const relative = pathname.replace(/^\/_admin\/?/, "");
  const requested = relative.length === 0 ? "index.html" : relative;

  const assetPath = resolveAssetPath(ctx.config.adminUiDir, requested);
  if (assetPath === null) {
    return errorResponse(errors.badRequest("Invalid asset path"));
  }

  const asset = await readAsset(assetPath);
  if (asset !== null) {
    return asset;
  }

  const indexPath = resolveAssetPath(ctx.config.adminUiDir, "index.html");
  if (indexPath !== null) {
    const index = await readAsset(indexPath);
    if (index !== null) {
      return index;
    }
  }

  return new Response(PLACEHOLDER_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
