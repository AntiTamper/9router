import { nowSec } from "./_base.js";
import { getExecutor } from "../../executors/index.js";


const SIZE_TO_ASPECT_RATIO = new Map([
  ["1024x1024", "1:1"],
  ["1024x1536", "2:3"],
  ["1536x1024", "3:2"],
  ["1024x1792", "9:16"],
  ["1792x1024", "16:9"],
]);

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export function resolveAntigravityImageConfig(body = {}) {
  const explicit = String(body.aspectRatio || body.aspect_ratio || "").trim();
  if (/^\d+:\d+$/.test(explicit)) return { aspectRatio: explicit };

  const size = String(body.size || "").trim().toLowerCase();
  if (SIZE_TO_ASPECT_RATIO.has(size)) return { aspectRatio: SIZE_TO_ASPECT_RATIO.get(size) };

  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(width, height);
  return { aspectRatio: String(width / divisor) + ":" + String(height / divisor) };
}

function resolveImageInput(input) {
  if (!input || typeof input !== "string") return null;
  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1], data: dataUriMatch[2] } };
  }
  if (/^[A-Za-z0-9+/]/.test(input) && input.length > 100 && !input.startsWith("http")) {
    return { inlineData: { mimeType: "image/png", data: input } };
  }
  return null;
}

const antigravityImageProvider = {
  useExecutor: true,
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    const parts = [{ text: body.prompt }];
    const imageInput = body.image || (Array.isArray(body.images) && body.images[0]);
    if (imageInput) {
      const inlineData = resolveImageInput(imageInput);
      if (inlineData) parts.unshift(inlineData);
    }

    const result = await executor.execute({
      model,
      body: { contents: [{ role: "user", parts }], imageConfig: resolveAntigravityImageConfig(body) },
      stream: false,
      credentials,
      log,
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      throw new Error(text || `HTTP ${result.response.status}`);
    }
    return result.response.json();
  },

  normalize(responseBody, prompt) {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({ b64_json: p.inlineData.data }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};

export default antigravityImageProvider;
