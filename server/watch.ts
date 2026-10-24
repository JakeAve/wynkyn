// server/watch.ts — debounced filesystem watching for the dev server (spec §6 live loop).

export interface Watcher {
  stop(): void;
}

export function watchTree(
  root: string,
  onChange: (paths: string[]) => void,
  opts: { debounceMs?: number } = {},
): Watcher {
  const debounceMs = opts.debounceMs ?? 150;
  const fsWatcher = Deno.watchFs(root, { recursive: true });
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  (async () => {
    for await (const event of fsWatcher) {
      if (event.kind === "access") continue;
      for (const p of event.paths) pending.add(p);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending];
        pending = new Set();
        onChange(paths);
      }, debounceMs);
    }
  })();

  return {
    stop() {
      clearTimeout(timer);
      fsWatcher.close();
    },
  };
}
