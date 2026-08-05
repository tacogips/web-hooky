/**
 * Admin API key issuance and admin user management view.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { adminApi, type AdminKeySummary, type AdminUser } from "../api-client";
import { errorMessage, formatTimestamp } from "../format";

export function KeysView(): JSX.Element {
  const [keys, setKeys] = createSignal<readonly AdminKeySummary[]>([]);
  const [adminUsers, setAdminUsers] = createSignal<readonly AdminUser[]>([]);
  const [error, setError] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [issuedCredential, setIssuedCredential] = createSignal("");

  async function refresh(): Promise<void> {
    try {
      setKeys(await adminApi.listAdminKeys());
      setAdminUsers(await adminApi.listAdminUsers());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  async function createKey(event: Event): Promise<void> {
    event.preventDefault();
    try {
      const created = await adminApi.createAdminKey(label());
      setIssuedCredential(created.credential);
      setLabel("");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function removeKey(id: string): Promise<void> {
    try {
      await adminApi.deleteAdminKey(id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function addAdminUser(event: Event): Promise<void> {
    event.preventDefault();
    try {
      await adminApi.createAdminUser(subject());
      setSubject("");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function removeAdminUser(value: string): Promise<void> {
    try {
      await adminApi.deleteAdminUser(value);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section>
      <h2>Admin API keys</h2>
      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={issuedCredential().length > 0}>
        <p class="secret">
          Admin credential (shown once): <code>{issuedCredential()}</code>
        </p>
      </Show>

      <form onSubmit={(event: Event) => void createKey(event)}>
        <input
          placeholder="label"
          required
          value={label()}
          onInput={(event: InputEvent) => {
            setLabel((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">Issue admin key</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Key id</th>
            <th>Label</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={keys()}>
            {(key) => (
              <tr>
                <td>
                  <code>{key.id}</code>
                </td>
                <td>{key.label}</td>
                <td>{formatTimestamp(key.createdAt)}</td>
                <td>
                  <button type="button" onClick={() => void removeKey(key.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <h2>Admin identities</h2>
      <p>
        Subjects asserted by the external identity provider that may use this
        admin surface.
      </p>
      <form onSubmit={(event: Event) => void addAdminUser(event)}>
        <input
          placeholder="subject (e.g. person@example.com)"
          required
          value={subject()}
          onInput={(event: InputEvent) => {
            setSubject((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">Allow subject</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Role</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={adminUsers()}>
            {(user) => (
              <tr>
                <td>{user.subject}</td>
                <td>{user.role}</td>
                <td>{formatTimestamp(user.createdAt)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => void removeAdminUser(user.subject)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}
