/**
 * Admin UI entry point.
 */
import { render } from "solid-js/web";
import { App } from "./app";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Admin UI root element is missing");
}

render(() => <App />, root);
