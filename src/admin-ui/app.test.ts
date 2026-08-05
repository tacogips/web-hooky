/**
 * Admin UI rendering test.
 *
 * The test builds the real browser bundle (same plugin and entry point as
 * `bun run build:ui`) and evaluates it against happy-dom with a stubbed
 * `/_admin/api`, so the tested artifact is the shipped artifact.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { buildAdminUi } from "./build";

GlobalRegistrator.register();

interface StubbedCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
}

/** Obviously fake credential; the admin UI never persists what is typed here. */
const TEST_CREDENTIAL = "admin-1:not-a-real-secret";

const calls: StubbedCall[] = [];

const responses: Record<string, unknown> = {
  "/_admin/api/me": {
    subject: "dev@localhost",
    viaApiKey: false,
    keyId: null,
    adminAuthProvider: "dev",
  },
  "/_admin/api/destinations": {
    destinations: [
      {
        id: "dest-1",
        name: "Wrike production",
        vendorAddon: "wrike",
        destinationAddon: "envelope",
        inboundUuid: "inbound-uuid",
        inboundPath: "/wrike/inbound-uuid",
        fetchUuid: "fetch-uuid",
        fetchPath: "/_get/fetch-uuid",
        streamPath: "/_ws/fetch-uuid",
        retentionSeconds: null,
        enabled: true,
        createdAt: 1700000000,
      },
    ],
  },
  "/_admin/api/addons": {
    addons: [
      {
        name: "wrike",
        version: "1.0.0",
        kind: "vendor",
        description: "Wrike webhooks",
        source: "builtin",
        hasAuthenticate: true,
        hasTransform: true,
      },
      {
        name: "envelope",
        version: "1.0.0",
        kind: "destination",
        description: "Envelope wrapper",
        source: "builtin",
        hasAuthenticate: false,
        hasTransform: true,
      },
    ],
  },
  "/_admin/api/relays": {
    relays: [
      {
        id: "relay-1",
        destinationId: "dest-1",
        name: "downstream",
        targetUrl: "https://downstream.example/hook",
        hasSecret: true,
        enabled: true,
        maxAttempts: 5,
        backoffSeconds: 10,
        timeoutSeconds: 10,
        createdAt: 1700000000,
        deliveryStats: { pending: 1, delivered: 2, failed: 3 },
      },
    ],
  },
  "/_admin/api/users": {
    users: [
      {
        id: "key-1",
        label: "reporting",
        enabled: true,
        createdAt: 1700000000,
        grants: ["dest-1"],
      },
    ],
  },
  "/_admin/api/admin-keys": {
    keys: [{ id: "admin-1", label: "automation", enabled: true, createdAt: 1 }],
  },
  "/_admin/api/admin-users": {
    adminUsers: [{ subject: "dev@localhost", role: "admin", createdAt: 1 }],
  },
};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      method: init?.method ?? "GET",
      path,
      authorization: headers?.["authorization"] ?? "",
    });
    return Promise.resolve(
      new Response(JSON.stringify(responses[path] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("admin UI", () => {
  let bundle = "";

  beforeAll(async () => {
    bundle = await buildAdminUi({ format: "iife" });
  });

  beforeEach(() => {
    calls.length = 0;
    installFetchStub();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mount(): Promise<HTMLElement> {
    // The bundle is an IIFE: evaluating it mounts the app into #root.
    new Function(bundle)();
    await settle();
    const root = document.getElementById("root");
    if (root === null) {
      throw new Error("Missing root element");
    }
    return root;
  }

  function clickTab(root: HTMLElement, label: string): void {
    const tab = [...root.querySelectorAll("nav button")].find(
      (button) => button.textContent?.trim() === label,
    );
    if (tab === undefined) {
      throw new Error(`Tab "${label}" was not rendered`);
    }
    (tab as HTMLButtonElement).click();
  }

  async function submitCredential(
    root: HTMLElement,
    value: string,
  ): Promise<void> {
    const input = root.querySelector<HTMLInputElement>("input#credential");
    if (input === null) {
      throw new Error("Credential input was not rendered");
    }
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = input.closest("form");
    if (form === null) {
      throw new Error("Credential form was not rendered");
    }
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
  }

  function storedValues(storage: Storage): string[] {
    const values: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) {
        values.push(storage.getItem(key) ?? "");
      }
    }
    return values;
  }

  test("builds without errors", () => {
    expect(bundle.length).toBeGreaterThan(0);
  });

  test("renders the identity banner and every navigation tab", async () => {
    const root = await mount();
    expect(root.textContent).toContain("web-hooky admin");
    expect(root.textContent).toContain("dev@localhost");
    for (const label of [
      "Destinations",
      "Relays",
      "Fetch API users",
      "Addons",
      "Admin keys",
    ]) {
      expect(root.textContent).toContain(label);
    }
  });

  test("lists destinations with their inbound and fetch paths", async () => {
    const root = await mount();
    expect(root.textContent).toContain("Wrike production");
    expect(root.textContent).toContain("/wrike/inbound-uuid");
    expect(root.textContent).toContain("/_get/fetch-uuid");
    expect(root.textContent).toContain("/_ws/fetch-uuid");
  });

  test("offers vendor and destination addons when issuing a destination", async () => {
    const root = await mount();
    const selects = root.querySelectorAll("select");
    const vendorOptions = [...(selects[0]?.querySelectorAll("option") ?? [])];
    expect(vendorOptions.map((option) => option.textContent)).toContain(
      "wrike",
    );
    const destinationOptions = [
      ...(selects[1]?.querySelectorAll("option") ?? []),
    ];
    expect(destinationOptions.map((option) => option.textContent)).toContain(
      "envelope",
    );
  });

  test("switches to the addons tab and lists addons", async () => {
    const root = await mount();
    clickTab(root, "Addons");
    await settle();
    expect(root.textContent).toContain("Upload package");
    expect(root.textContent).toContain("Wrike webhooks");
    expect(root.textContent).toContain("builtin");
  });

  test("switches to the relays tab and lists forwarding targets", async () => {
    const root = await mount();
    clickTab(root, "Relays");
    await settle();
    expect(root.textContent).toContain("Add relay");
    expect(root.textContent).toContain("downstream");
    expect(root.textContent).toContain("https://downstream.example/hook");
    expect(root.textContent).toContain("hmac-sha256");
    expect(root.textContent).toContain("delivered 2");
    expect(root.textContent).toContain("failed 3");
  });

  test("switches to the users tab and shows grants", async () => {
    const root = await mount();
    clickTab(root, "Fetch API users");
    await settle();
    expect(root.textContent).toContain("reporting");
    expect(root.textContent).toContain("Register API key");
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.checked).toBe(true);
  });

  test("switches to the admin keys tab and lists keys and identities", async () => {
    const root = await mount();
    clickTab(root, "Admin keys");
    await settle();
    expect(root.textContent).toContain("automation");
    expect(root.textContent).toContain("Issue admin key");
    expect(root.textContent).toContain("Admin identities");
  });

  test("issues a destination through the admin API", async () => {
    const root = await mount();
    const nameInput = root.querySelector<HTMLInputElement>(
      'input[placeholder="name"]',
    );
    if (nameInput === null) {
      throw new Error("Destination name input was not rendered");
    }
    nameInput.value = "new destination";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));

    const form = nameInput.closest("form");
    if (form === null) {
      throw new Error("Destination form was not rendered");
    }
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();

    const created = calls.find(
      (call) =>
        call.method === "POST" && call.path === "/_admin/api/destinations",
    );
    expect(created).toBeDefined();
  });

  test("uses the admin key without persisting it in web storage", async () => {
    const root = await mount();
    await submitCredential(root, TEST_CREDENTIAL);

    const authorized = calls.filter(
      (call) => call.authorization === `Bearer ${TEST_CREDENTIAL}`,
    );
    expect(authorized.length).toBeGreaterThan(0);

    expect(storedValues(window.localStorage)).toEqual([]);
    expect(storedValues(window.sessionStorage)).toEqual([]);
  });

  test("deletes a credential persisted by an earlier build", async () => {
    window.localStorage.setItem("web-hooky.admin-credential", TEST_CREDENTIAL);
    await mount();

    expect(
      window.localStorage.getItem("web-hooky.admin-credential"),
    ).toBeNull();
    for (const call of calls) {
      expect(call.authorization).toBe("");
    }
  });

  test("drops the in-memory credential on sign out", async () => {
    const root = await mount();
    await submitCredential(root, TEST_CREDENTIAL);

    const signOut = [...root.querySelectorAll("form button")].find(
      (button) => button.textContent?.trim() === "Sign out key",
    );
    if (signOut === undefined) {
      throw new Error("Sign out button was not rendered");
    }
    calls.length = 0;
    (signOut as HTMLButtonElement).click();
    await settle();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.authorization).toBe("");
    }
  });

  test("only talks to the admin API", async () => {
    await mount();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.path.startsWith("/_admin/api")).toBe(true);
    }
  });
});
