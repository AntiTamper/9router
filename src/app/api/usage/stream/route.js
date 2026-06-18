import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const FULL_STATS_PERIOD = "7d";
const FULL_STATS_CACHE_TTL_MS = 1000;
const FULL_UPDATE_DEBOUNCE_MS = 250;
const PENDING_UPDATE_DEBOUNCE_MS = 150;

if (!global._usageStreamSharedStats) {
  global._usageStreamSharedStats = { stats: null, ts: 0, inFlight: null };
}
const sharedStats = global._usageStreamSharedStats;

async function getSharedUsageStats({ force = false } = {}) {
  const now = Date.now();
  if (!force && sharedStats.stats && now - sharedStats.ts < FULL_STATS_CACHE_TTL_MS) {
    return sharedStats.stats;
  }
  if (sharedStats.inFlight) return sharedStats.inFlight;
  sharedStats.inFlight = getUsageStats(FULL_STATS_PERIOD)
    .then((stats) => {
      sharedStats.stats = stats;
      sharedStats.ts = Date.now();
      return stats;
    })
    .finally(() => {
      sharedStats.inFlight = null;
    });
  return sharedStats.inFlight;
}

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null, fullTimer: null, pendingTimer: null };

  const safeEnqueue = (controller, payload) => {
    if (state.closed) return false;
    try {
      controller.enqueue(encoder.encode(payload));
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) statsEmitter.off("update", state.send);
    if (state.sendPending) statsEmitter.off("pending", state.sendPending);
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.fullTimer) clearTimeout(state.fullTimer);
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    request.signal.removeEventListener("abort", cleanup);
  };

  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      // Full stats refresh (heavy) + immediate lightweight push
      state.send = async () => {
        if (state.closed) return;
        if (state.fullTimer) return;
        state.fullTimer = setTimeout(async () => {
          state.fullTimer = null;
          if (state.closed) return;
        try {
          // Push lightweight update immediately so UI reflects changes fast
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
            const quickStats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
            safeEnqueue(controller, `data: ${JSON.stringify(quickStats)}\n\n`);
          }
          // Then do full recalc and update cache
          const stats = await getSharedUsageStats({ force: true });
          state.cachedStats = stats;
          if (state.closed) return;
          safeEnqueue(controller, `data: ${JSON.stringify(stats)}\n\n`);
        } catch {
          cleanup();
        }
        }, FULL_UPDATE_DEBOUNCE_MS);
        state.fullTimer.unref?.();
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async () => {
        if (state.closed || !state.cachedStats) return;
        if (state.pendingTimer) return;
        state.pendingTimer = setTimeout(async () => {
          state.pendingTimer = null;
          if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
          if (state.closed) return;
          safeEnqueue(controller, `data: ${JSON.stringify(stats)}\n\n`);
        } catch {
          cleanup();
        }
        }, PENDING_UPDATE_DEBOUNCE_MS);
        state.pendingTimer.unref?.();
      };

      try {
        const stats = await getSharedUsageStats();
        state.cachedStats = stats;
        safeEnqueue(controller, `data: ${JSON.stringify(stats)}\n\n`);
      } catch {
        cleanup();
        return;
      }
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        safeEnqueue(controller, ": ping\n\n");
      }, 25000);
      state.keepalive.unref?.();
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
