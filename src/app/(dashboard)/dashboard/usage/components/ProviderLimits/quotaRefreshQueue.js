"use client";

export const DEFAULT_QUOTA_REFRESH_CONCURRENCY = 4;

function normalizeConcurrency(value) {
  const concurrency = Math.floor(Number(value));
  return Number.isFinite(concurrency) && concurrency > 0
    ? concurrency
    : DEFAULT_QUOTA_REFRESH_CONCURRENCY;
}

export function runQuotaRefreshQueue(items, worker, options = {}) {
  const queueItems = Array.isArray(items) ? items : [];
  const concurrency = Math.min(
    normalizeConcurrency(options.concurrency),
    Math.max(queueItems.length, 1),
  );
  const shouldContinue = typeof options.shouldContinue === "function"
    ? options.shouldContinue
    : () => true;
  const onItemSettled = typeof options.onItemSettled === "function"
    ? options.onItemSettled
    : () => {};
  const onError = typeof options.onError === "function"
    ? options.onError
    : () => {};

  let nextIndex = 0;
  let active = 0;
  let settled = 0;
  let cancelled = false;
  let resolveDone;

  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const finishIfDone = () => {
    if ((cancelled || settled >= queueItems.length) && active === 0) {
      resolveDone({ cancelled, settled, total: queueItems.length });
    }
  };

  const launchNext = () => {
    if (cancelled) {
      finishIfDone();
      return;
    }
    if (!shouldContinue()) {
      cancelled = true;
      finishIfDone();
      return;
    }

    while (active < concurrency && nextIndex < queueItems.length) {
      if (!shouldContinue()) {
        cancelled = true;
        break;
      }
      const item = queueItems[nextIndex];
      nextIndex += 1;
      active += 1;

      Promise.resolve()
        .then(() => worker(item))
        .catch((error) => {
          try {
            onError(error, item);
          } catch {}
        })
        .finally(() => {
          active -= 1;
          settled += 1;
          try {
            onItemSettled(item);
          } catch {}
          launchNext();
          finishIfDone();
        });
    }

    finishIfDone();
  };

  Promise.resolve().then(launchNext);

  return {
    done,
    cancel() {
      cancelled = true;
      finishIfDone();
    },
  };
}
