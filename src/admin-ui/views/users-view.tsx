/**
 * Fetch API user registration and per-destination authorization view.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  adminApi,
  type AdminApiUser,
  type AdminDestination,
} from "../api-client";
import { errorMessage, formatTimestamp } from "../format";

export function UsersView(): JSX.Element {
  const [users, setUsers] = createSignal<readonly AdminApiUser[]>([]);
  const [destinations, setDestinations] = createSignal<
    readonly AdminDestination[]
  >([]);
  const [error, setError] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [issuedCredential, setIssuedCredential] = createSignal("");

  async function refresh(): Promise<void> {
    try {
      setUsers(await adminApi.listUsers());
      setDestinations(await adminApi.listDestinations());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  async function create(event: Event): Promise<void> {
    event.preventDefault();
    try {
      const created = await adminApi.createUser(label());
      setIssuedCredential(created.credential);
      setLabel("");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function rotate(id: string): Promise<void> {
    try {
      const rotated = await adminApi.rotateUserSecret(id);
      setIssuedCredential(rotated.credential);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function toggleGrant(
    user: AdminApiUser,
    destinationId: string,
  ): Promise<void> {
    try {
      await adminApi.setGrant(
        user.id,
        destinationId,
        user.grants.includes(destinationId) === false,
      );
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await adminApi.deleteUser(id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section>
      <h2>Fetch API users</h2>
      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={issuedCredential().length > 0}>
        <p class="secret">
          Credential (shown once): <code>{issuedCredential()}</code>
          <br />
          Use it as <code>Authorization: Bearer &lt;credential&gt;</code>.
        </p>
      </Show>

      <form onSubmit={(event: Event) => void create(event)}>
        <input
          placeholder="label"
          required
          value={label()}
          onInput={(event: InputEvent) => {
            setLabel((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">Register API key</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Key id</th>
            <th>Label</th>
            <th>Created</th>
            <th>Authorized destinations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={users()}>
            {(user) => (
              <tr>
                <td>
                  <code>{user.id}</code>
                </td>
                <td>{user.label}</td>
                <td>{formatTimestamp(user.createdAt)}</td>
                <td>
                  <For each={destinations()}>
                    {(destination) => (
                      <label style={{ display: "block" }}>
                        <input
                          type="checkbox"
                          checked={user.grants.includes(destination.id)}
                          onChange={() =>
                            void toggleGrant(user, destination.id)
                          }
                        />
                        {destination.name}
                      </label>
                    )}
                  </For>
                </td>
                <td>
                  <button type="button" onClick={() => void rotate(user.id)}>
                    Rotate secret
                  </button>
                  <button type="button" onClick={() => void remove(user.id)}>
                    Delete
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
