/**
 * Admin UI shell: identity banner and tab navigation.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  adminApi,
  clearApiKeyCredential,
  getApiKeyCredential,
  setApiKeyCredential,
} from "./api-client";
import { errorMessage } from "./format";
import { AddonsView } from "./views/addons-view";
import { DestinationsView } from "./views/destinations-view";
import { KeysView } from "./views/keys-view";
import { RelaysView } from "./views/relays-view";
import { UsersView } from "./views/users-view";

const TABS = [
  { id: "destinations", label: "Destinations" },
  { id: "relays", label: "Relays" },
  { id: "users", label: "Fetch API users" },
  { id: "addons", label: "Addons" },
  { id: "keys", label: "Admin keys" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Storage key written by earlier builds that persisted the credential. */
const LEGACY_CREDENTIAL_STORAGE_KEY = "web-hooky.admin-credential";

/**
 * Removes admin credentials left in web storage by earlier builds.
 *
 * The credential is now held in memory for the page load only, so any copy in
 * `localStorage`/`sessionStorage` is a leftover readable by every script on the
 * origin and is deleted on start.
 */
function purgeStoredCredential(): void {
  try {
    window.localStorage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY);
  } catch {
    // Web storage can be unavailable (blocked cookies, private mode).
  }
}

export function App(): JSX.Element {
  const [tab, setTab] = createSignal<TabId>("destinations");
  const [identity, setIdentity] = createSignal("");
  const [error, setError] = createSignal("");
  const [credential, setCredential] = createSignal("");
  const [keyActive, setKeyActive] = createSignal(
    getApiKeyCredential().length > 0,
  );

  async function loadIdentity(): Promise<void> {
    try {
      const me = await adminApi.me();
      setIdentity(`${me.subject} (provider: ${me.adminAuthProvider})`);
      setError("");
    } catch (cause) {
      setIdentity("");
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    purgeStoredCredential();
    void loadIdentity();
  });

  function applyCredential(event: Event): void {
    event.preventDefault();
    setApiKeyCredential(credential());
    setKeyActive(getApiKeyCredential().length > 0);
    void loadIdentity();
  }

  function signOutKey(): void {
    clearApiKeyCredential();
    setCredential("");
    setKeyActive(false);
    void loadIdentity();
  }

  return (
    <main>
      <header>
        <h1>web-hooky admin</h1>
        <Show when={identity().length > 0}>
          <span>Signed in as {identity()}</span>
        </Show>
      </header>

      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>

      <form onSubmit={applyCredential}>
        <label for="credential">Admin API key (keyId:secret), optional</label>
        <input
          id="credential"
          type="password"
          placeholder="only needed without an identity provider"
          value={credential()}
          onInput={(event: InputEvent) => {
            setCredential((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">{keyActive() ? "Update key" : "Use key"}</button>
        <Show when={keyActive()}>
          <button type="button" onClick={signOutKey}>
            Sign out key
          </button>
        </Show>
        <small>
          The key is kept in memory only and has to be entered again after a
          reload.
        </small>
      </form>

      <nav>
        <For each={TABS}>
          {(entry) => (
            <button
              type="button"
              aria-current={tab() === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          )}
        </For>
      </nav>

      <Show when={tab() === "destinations"}>
        <DestinationsView />
      </Show>
      <Show when={tab() === "relays"}>
        <RelaysView />
      </Show>
      <Show when={tab() === "users"}>
        <UsersView />
      </Show>
      <Show when={tab() === "addons"}>
        <AddonsView />
      </Show>
      <Show when={tab() === "keys"}>
        <KeysView />
      </Show>
    </main>
  );
}
