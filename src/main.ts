/**
 * web-hooky - Main entry point
 *
 * tr
 */

import { greet } from "./lib";

function main(): void {
  const message = greet("World");
  console.log(message);
}

main();
