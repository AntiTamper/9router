const STREAM_DETAIL_PREVIEW_CHARS = typeof process !== "undefined"
  ? process.env?.STREAM_DETAIL_PREVIEW_CHARS
  : undefined;

export const DEFAULT_STREAM_PREVIEW_LIMIT_CHARS = Math.max(
  64 * 1024,
  Number(STREAM_DETAIL_PREVIEW_CHARS || 1024 * 1024) || 1024 * 1024,
);
export const DEFAULT_RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 12 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function createBoundedTextAccumulator(limitChars = DEFAULT_STREAM_PREVIEW_LIMIT_CHARS) {
  const limit = Math.max(0, Number(limitChars) || 0);
  let text = "";
  let originalLength = 0;
  let truncated = false;

  return {
    append(value) {
      if (value === undefined || value === null) return;
      const chunk = String(value);
      if (!chunk) return;
      originalLength += chunk.length;
      const remaining = limit - text.length;
      if (remaining > 0) text += chunk.slice(0, remaining);
      if (chunk.length > Math.max(remaining, 0)) truncated = true;
    },
    get text() { return text; },
    get originalLength() { return originalLength; },
    get truncated() { return truncated; },
    snapshot() { return { text, originalLength, truncated }; },
  };
}

export function buildPreviewMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    originalLength: snapshot.originalLength || 0,
    truncated: snapshot.truncated === true,
    previewLength: String(snapshot.text || "").length,
  };
}

export function previewText(snapshot, fallback = "") {
  if (!snapshot || typeof snapshot !== "object") return fallback;
  return snapshot.text || fallback;
}

function timeoutError(timeoutMs) {
  const err = new Error(`response body read timeout after ${timeoutMs}ms`);
  err.name = "TimeoutError";
  return err;
}

export async function readResponseTextBounded(response, options = {}) {
  const limitBytes = Math.max(1, Number(options.limitBytes ?? DEFAULT_RESPONSE_BODY_LIMIT_BYTES) || DEFAULT_RESPONSE_BODY_LIMIT_BYTES);
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_RESPONSE_BODY_TIMEOUT_MS) || DEFAULT_RESPONSE_BODY_TIMEOUT_MS);

  if (!response?.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    const byteLength = encoder.encode(text).byteLength;
    if (byteLength > limitBytes) {
      const err = new Error(`response body exceeded ${limitBytes} bytes`);
      err.name = "BodyLimitError";
      throw err;
    }
    return { text, byteLength, truncated: false };
  }

  const reader = response.body.getReader();
  let timer = null;
  let timedOut = false;
  let byteLength = 0;
  let text = "";

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { reader.cancel(timeoutError(timeoutMs)); } catch {}
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  const read = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const size = value?.byteLength || value?.length || 0;
        byteLength += size;
        if (byteLength > limitBytes) {
          const err = new Error(`response body exceeded ${limitBytes} bytes`);
          err.name = "BodyLimitError";
          try { await reader.cancel(err); } catch {}
          throw err;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return { text, byteLength, truncated: false };
    } finally {
      if (timer) clearTimeout(timer);
      if (!timedOut) {
        try { reader.releaseLock(); } catch {}
      }
    }
  })();

  return Promise.race([read, timeout]);
}

export async function readResponseJsonBounded(response, options = {}) {
  const { text } = await readResponseTextBounded(response, options);
  return JSON.parse(text);
}
