/**
 * A fetch double that records the request and answers with a fixed response.
 */

export const BASE_URL = "https://hooks.example.test";

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  bodyBytes: Uint8Array;
}

export function stub(
  status: number,
  body: unknown,
): { readonly fetchImpl: typeof fetch; readonly seen: Seen } {
  const seen: Seen = {
    url: "",
    method: "",
    headers: {},
    body: "",
    bodyBytes: new Uint8Array(),
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.url = String(input);
    seen.method = init?.method ?? "GET";
    seen.headers = { ...((init?.headers ?? {}) as Record<string, string>) };

    if (typeof init?.body === "string") {
      seen.body = init.body;
      seen.bodyBytes = new TextEncoder().encode(init.body);
    } else if (init?.body instanceof Uint8Array) {
      seen.bodyBytes = init.body;
      seen.body = new TextDecoder().decode(init.body);
    } else {
      seen.body = "";
      seen.bodyBytes = new Uint8Array();
    }

    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}
