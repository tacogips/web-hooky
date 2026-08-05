/**
 * Builds the SolidJS admin UI into the directory served at `/_admin/`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ADMIN_UI_HTML, buildAdminUi } from "../src/admin-ui/build";

const outdir = process.argv[2] ?? "./dist/admin-ui";

await mkdir(outdir, { recursive: true });
await buildAdminUi({ outdir, minify: true });
await Bun.write(
  join(outdir, "index.html"),
  await Bun.file(ADMIN_UI_HTML).text(),
);

console.log(`[web-hooky] admin UI built into ${outdir}`);
