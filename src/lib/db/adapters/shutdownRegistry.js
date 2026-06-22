const g = (globalThis.__dbAdapterShutdownRegistry ??= {
  handlers: new Set(),
  installed: false,
});

function runHandlers() {
  const pending = [];
  for (const handler of Array.from(g.handlers)) {
    try {
      const result = handler();
      if (result?.then) pending.push(result.catch(() => {}));
    } catch { /* ignore shutdown cleanup errors */ }
  }
  return pending;
}

async function runSignalHandlers() {
  await Promise.allSettled(runHandlers());
  process.exit(0);
}

function ensureInstalled() {
  if (g.installed) return;
  process.once("beforeExit", runHandlers);
  process.once("SIGINT", runSignalHandlers);
  process.once("SIGTERM", runSignalHandlers);
  g.installed = true;
}

export function registerShutdownHandler(handler) {
  ensureInstalled();
  g.handlers.add(handler);
  return () => { g.handlers.delete(handler); };
}
