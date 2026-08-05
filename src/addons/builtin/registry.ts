/**
 * Built-in addon catalogue.
 *
 * These addons ship with the server and cannot be removed through the admin
 * API; uploaded addons may not reuse their names.
 */
import type { LoadedAddon } from "../types";
import { envelopeAddon } from "./envelope";
import { githubAddon } from "./github";
import { passthroughAddon } from "./passthrough";
import { wrikeAddon } from "./wrike";

export const BUILTIN_ADDONS: readonly LoadedAddon[] = [
  wrikeAddon,
  githubAddon,
  passthroughAddon,
  envelopeAddon,
];
