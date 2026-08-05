/**
 * Destination issuance and management view.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  adminApi,
  type AdminAddon,
  type AdminDestination,
} from "../api-client";
import { errorMessage } from "../format";

export function DestinationsView(): JSX.Element {
  const [destinations, setDestinations] = createSignal<
    readonly AdminDestination[]
  >([]);
  const [addons, setAddons] = createSignal<readonly AdminAddon[]>([]);
  const [error, setError] = createSignal("");
  const [name, setName] = createSignal("");
  const [vendorAddon, setVendorAddon] = createSignal("wrike");
  const [destinationAddon, setDestinationAddon] = createSignal("");
  const [vendorConfig, setVendorConfig] = createSignal('{ "secret": "" }');
  const [destinationConfig, setDestinationConfig] = createSignal("{}");
  const [retention, setRetention] = createSignal("");

  async function refresh(): Promise<void> {
    try {
      setDestinations(await adminApi.listDestinations());
      setAddons(await adminApi.listAddons());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  function parseConfig(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {};
    }
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  async function create(event: Event): Promise<void> {
    event.preventDefault();
    try {
      const retentionRaw = retention().trim();
      await adminApi.createDestination({
        name: name(),
        vendorAddon: vendorAddon(),
        destinationAddon:
          destinationAddon().length === 0 ? null : destinationAddon(),
        vendorConfig: parseConfig(vendorConfig()),
        destinationConfig: parseConfig(destinationConfig()),
        retentionSeconds:
          retentionRaw.length === 0 ? null : Number.parseInt(retentionRaw, 10),
      });
      setName("");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await adminApi.deleteDestination(id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function rotate(id: string): Promise<void> {
    try {
      await adminApi.rotateFetchUuid(id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section>
      <h2>Destinations</h2>
      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>

      <form onSubmit={(event: Event) => void create(event)}>
        <input
          placeholder="name"
          required
          value={name()}
          onInput={(event: InputEvent) => {
            setName((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <select
          value={vendorAddon()}
          onChange={(event: Event) => {
            setVendorAddon((event.currentTarget as HTMLSelectElement).value);
          }}
        >
          <For each={addons().filter((addon) => addon.kind !== "destination")}>
            {(addon) => <option value={addon.name}>{addon.name}</option>}
          </For>
        </select>
        <select
          value={destinationAddon()}
          onChange={(event: Event) => {
            setDestinationAddon(
              (event.currentTarget as HTMLSelectElement).value,
            );
          }}
        >
          <option value="">(no destination addon)</option>
          <For each={addons().filter((addon) => addon.kind !== "vendor")}>
            {(addon) => <option value={addon.name}>{addon.name}</option>}
          </For>
        </select>
        <textarea
          title="vendor config JSON"
          value={vendorConfig()}
          onInput={(event: InputEvent) => {
            setVendorConfig((event.currentTarget as HTMLTextAreaElement).value);
          }}
        />
        <textarea
          title="destination config JSON"
          value={destinationConfig()}
          onInput={(event: InputEvent) => {
            setDestinationConfig(
              (event.currentTarget as HTMLTextAreaElement).value,
            );
          }}
        />
        <input
          placeholder="retention seconds (optional)"
          value={retention()}
          onInput={(event: InputEvent) => {
            setRetention((event.currentTarget as HTMLInputElement).value);
          }}
        />
        <button type="submit">Issue destination</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Addons</th>
            <th>Inbound URL</th>
            <th>Fetch endpoints</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={destinations()}>
            {(destination) => (
              <tr>
                <td>{destination.name}</td>
                <td>
                  {destination.vendorAddon}
                  {destination.destinationAddon === null
                    ? ""
                    : ` -> ${destination.destinationAddon}`}
                </td>
                <td>
                  <code>{destination.inboundPath}</code>
                </td>
                <td>
                  <code>{destination.fetchPath}</code>
                  <br />
                  <code>{destination.streamPath}</code>
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => void rotate(destination.id)}
                  >
                    Rotate fetch UUID
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(destination.id)}
                  >
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
