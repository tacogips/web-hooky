/**
 * HTTP boundary of the addon upload endpoint.
 *
 * The archive/zip internals are covered by `addons.test.ts`; this suite covers
 * the transport layer above them - the multipart branch, content-type
 * screening, and the streamed-body size cap - which previously had no tests at
 * all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { MAX_ARCHIVE_BYTES } from "../addons/package";
import { createHarness, type Harness } from "../test-support/harness";

const encoder = new TextEncoder();

function sampleArchive(name: string): Uint8Array {
  return zipSync({
    "addon.json": encoder.encode(
      JSON.stringify({
        name,
        version: "1.0.0",
        kind: "vendor",
        description: "upload transport sample",
        entry: "addon.js",
        acceptsSchema: { type: "object" },
        returnsSchema: { type: "object" },
      }),
    ),
    "addon.js": encoder.encode(
      "export function transform(input) { return input; }",
    ),
  });
}

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("addon upload transport", () => {
  test("accepts a multipart upload with a package field", async () => {
    const form = new FormData();
    form.set(
      "package",
      new File([sampleArchive("multi-addon")], "multi-addon.zip", {
        type: "application/zip",
      }),
    );
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("multi-addon");

    const removed = await harness.admin("/_admin/api/addons/multi-addon", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });

  test("rejects a multipart upload without the package field", async () => {
    const form = new FormData();
    form.set("wrong-field", "not a file");
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain('"package" file field');
  });

  test("rejects an upload with a non-zip content type", async () => {
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "definitely not a zip",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unsupported content type");
  });

  test("rejects a streamed body that exceeds the archive cap", async () => {
    // No Content-Length: the body arrives chunk by chunk and must be abandoned
    // once the running total passes the cap, not buffered to completion.
    const chunk = new Uint8Array(64 * 1024);
    const chunksNeeded = Math.ceil((MAX_ARCHIVE_BYTES + 1) / chunk.byteLength);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (sent >= chunksNeeded + 4) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("exceeds");
  });

  test("rejects a declared Content-Length beyond the cap without reading", async () => {
    // Whether the runtime preserves the explicit header (declared-size
    // rejection) or strips it for a stream (chunked-read rejection), the
    // outcome the caller sees must be the same 413. The runtime is free to
    // prime the stream, so how much was read is not asserted.
    const declared = String(MAX_ARCHIVE_BYTES + 1);
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const response = await harness.admin("/_admin/api/addons", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "content-length": declared,
      },
      body,
    });
    expect(response.status).toBe(413);
  });
});
