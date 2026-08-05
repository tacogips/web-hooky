/**
 * Relay (forwarding) management view.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  adminApi,
  type AdminDestination,
  type AdminRelay,
} from "../api-client";
import { errorMessage } from "../format";

export function RelaysView(): JSX.Element {
  const [relays, setRelays] = createSignal<readonly AdminRelay[]>([]);
  const [destinations, setDestinations] = createSignal<
    readonly AdminDestination[]
  >([]);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [destinationId, setDestinationId] = createSignal("");
  const [name, setName] = createSignal("");
  const [targetUrl, setTargetUrl] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [maxAttempts, setMaxAttempts] = createSignal("");

  async function refresh(): Promise<void> {
    try {
      const loaded = await adminApi.listDestinations();
      setDestinations(loaded);
      if (destinationId().length === 0 && loaded.length > 0) {
        setDestinationId(loaded[0]?.id ?? "");
      }
      setRelays(await adminApi.listRelays());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  function destinationName(id: string): string {
    return destinations().find((entry) => entry.id === id)?.name ?? id;
  }

  async function create(event: Event): Promise<void> {
    event.preventDefault();
    try {
      const attempts = maxAttempts().trim();
      await adminApi.createRelay({
        destinationId: destinationId(),
        name: name(),
        targetUrl: targetUrl(),
        secret: secret().trim().length === 0 ? null : secret().trim(),
        maxAttempts:
          attempts.length === 0 ? null : Number.parseInt(attempts, 10),
      });
      setName("");
      setTargetUrl("");
      setSecret("");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function toggle(relay: AdminRelay): Promise<void> {
    try {
      await adminApi.setRelayEnabled(relay.id, relay.enabled === false);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function retry(relay: AdminRelay): Promise<void> {
    try {
      const result = await adminApi.retryRelay(relay.id);
      setNotice(`Requeued ${result.requeued} failed deliveries`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function remove(relay: AdminRelay): Promise<void> {
    try {
      await adminApi.deleteRelay(relay.id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section>
      <h2>Relays</h2>
      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={notice().length > 0}>
        <p>{notice()}</p>
      </Show>

      <form onSubmit={(event: Event) => void create(event)}>
        <select
          title="destination"
          value={destinationId()}
          onChange={(event: Event) => {
            setDestinationId((event.currentTarget as HTMLSelectElement).value);
          }}
        >
          <For each={destinations()}>
            {(destination) => (
              <option value={destination.id}>{destination.name}</option>
            )}
          </For>
        </select>
        <input
          placeholder="relay name"
          required
          value={name()}
          onInput={(event: InputEvent) => {
            setName((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <input
          placeholder="https://target.example/hook"
          required
          value={targetUrl()}
          onInput={(event: InputEvent) => {
            setTargetUrl((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <input
          type="password"
          placeholder="signing secret (optional)"
          value={secret()}
          onInput={(event: InputEvent) => {
            setSecret((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <input
          placeholder="max attempts (optional)"
          value={maxAttempts()}
          onInput={(event: InputEvent) => {
            setMaxAttempts((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">Add relay</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Destination</th>
            <th>Target</th>
            <th>Signed</th>
            <th>Deliveries</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={relays()}>
            {(relay) => (
              <tr>
                <td>
                  {relay.name}
                  {relay.enabled ? "" : " (disabled)"}
                </td>
                <td>{destinationName(relay.destinationId)}</td>
                <td>
                  <code>{relay.targetUrl}</code>
                </td>
                <td>{relay.hasSecret ? "hmac-sha256" : "no"}</td>
                <td>
                  pending {relay.deliveryStats?.pending ?? 0} / delivered{" "}
                  {relay.deliveryStats?.delivered ?? 0} / failed{" "}
                  {relay.deliveryStats?.failed ?? 0}
                </td>
                <td>
                  <button type="button" onClick={() => void toggle(relay)}>
                    {relay.enabled ? "Disable" : "Enable"}
                  </button>
                  <button type="button" onClick={() => void retry(relay)}>
                    Retry failed
                  </button>
                  <button type="button" onClick={() => void remove(relay)}>
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
