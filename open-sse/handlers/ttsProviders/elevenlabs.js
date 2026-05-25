// ElevenLabs TTS — voice id with optional model_id prefix
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { MEMORY_CONFIG } from "../../config/runtimeConfig.js";

const VOICES_TTL = 24 * 60 * 60 * 1000;
const _voicesCache = new Map(); // by hashed API key

function voicesCacheKey(apiKey) {
  return createHash("sha256").update(String(apiKey || "")).digest("hex");
}

function pruneVoicesCache(now = Date.now()) {
  for (const [key, entry] of _voicesCache) {
    if (!entry || now - entry.time >= VOICES_TTL) _voicesCache.delete(key);
  }
  while (_voicesCache.size > MEMORY_CONFIG.elevenLabsVoiceCacheMaxSize) {
    const oldestKey = _voicesCache.keys().next().value;
    if (!oldestKey) break;
    _voicesCache.delete(oldestKey);
  }
}

export async function fetchElevenLabsVoices(apiKey) {
  if (!apiKey) throw new Error("ElevenLabs API key required");
  const now = Date.now();
  const key = voicesCacheKey(apiKey);
  pruneVoicesCache(now);
  const cached = _voicesCache.get(key);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices fetch failed: ${res.status}`);
  const data = await res.json();
  // Normalize: derive lang from labels for grouping
  const voices = (data.voices || []).map((v) => ({ ...v, lang: v.labels?.language || "en" }));
  _voicesCache.set(key, { voices, time: now });
  pruneVoicesCache();
  return voices;
}

export default {
  async synthesize(text, model, credentials) {
    if (!credentials?.apiKey) throw new Error("ElevenLabs API key required");
    let modelId = "eleven_flash_v2_5";
    let voiceId = model;
    if (model && model.includes("/")) [modelId, voiceId] = model.split("/");

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `ElevenLabs TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("ElevenLabs TTS returned empty audio");
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};
