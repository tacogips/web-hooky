/**
 * Addon listing and zip package upload view.
 */
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { adminApi, type AdminAddon } from "../api-client";
import { errorMessage } from "../format";

export function AddonsView(): JSX.Element {
  const [addons, setAddons] = createSignal<readonly AdminAddon[]>([]);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [file, setFile] = createSignal<File | null>(null);

  async function refresh(): Promise<void> {
    try {
      setAddons(await adminApi.listAddons());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  async function upload(event: Event): Promise<void> {
    event.preventDefault();
    const selected = file();
    if (selected === null) {
      setError("Select a zip package first");
      return;
    }
    try {
      const uploaded = await adminApi.uploadAddon(selected);
      setStatus(`Installed addon "${uploaded.name}" ${uploaded.version}`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      await adminApi.deleteAddon(name);
      setStatus(`Removed addon "${name}"`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section>
      <h2>Addons</h2>
      <Show when={error().length > 0}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={status().length > 0}>
        <p>{status()}</p>
      </Show>

      <form onSubmit={(event: Event) => void upload(event)}>
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            // Wrapped in a thunk: Solid setters treat a bare function value
            // as an updater, and File is not callable.
            const selected = input.files?.item(0) ?? null;
            setFile(() => selected);
          }}
        />
        <button type="submit">Upload package</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Version</th>
            <th>Kind</th>
            <th>Source</th>
            <th>Hooks</th>
            <th>Description</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <For each={addons()}>
            {(addon) => (
              <tr>
                <td>
                  <code>{addon.name}</code>
                </td>
                <td>{addon.version}</td>
                <td>{addon.kind}</td>
                <td>{addon.source}</td>
                <td>
                  {addon.hasAuthenticate ? "auth " : ""}
                  {addon.hasTransform ? "transform" : ""}
                </td>
                <td>{addon.description}</td>
                <td>
                  <Show when={addon.source !== "builtin"}>
                    <button
                      type="button"
                      onClick={() => void remove(addon.name)}
                    >
                      Remove
                    </button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}
