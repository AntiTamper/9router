# 9router Fork — Feature Set (Root Index)

Stamp: 2026-06-13e | Branch: adapt/upstream-v0477 | Upstream synced: v0.4.77 (23da7b1)
Status: ports applied, eslint clean, 587 vitest pass, next build OK. NOT yet committed/pushed.

## Fork-Only Logic (PRESERVE — never blind-merge over these)
- API-key overhaul + per-key system-instruction injection + holder self-service toggles.
- Quota queue + quota-bars dashboard UI (UsageStats.js, ProviderTopology.js).
- Codex/Kimi fixes; OAuth lease + fresh-token (connectionsRepo.js).
- proxyFetch.js (auto-patches globalThis.fetch); custom domain; merge/analyze/conflict DB modes.
- Login limiter getClientIp: cf-connecting-ip + rightmost-XFF + "unknown" bucket (CF-fronted, superior to upstream x-9r-real-ip).
- Kiro MITM slots: auto / minimax-m2.5 / glm-5 (fork-added; do NOT let upstream b2aa08a revert).

## Capabilities (high level)
- Multi-provider LLM router w/ translators: openai <-> claude <-> gemini <-> kiro, passthrough.
- MITM tools: antigravity, copilot, kiro, cursor (src/mitm, src/shared/constants/cliTools.js).
- Providers incl claude(OAuth), kimi/kimi-coding, github-copilot, kiro(CodeWhisperer), siliconflow,
  cerebras, mistral, commandcode, xiaomi-mimo, vertex, anthropic-compatible-*, openai-compatible-*.
- Server-side web fetch /api/v1/web/fetch (SSRF-guarded), embeddings, images, STT model-test.
- Dashboard: providers, combos, usage/quota, mitm, cli-tools, translator, proxy-pools, skills.
- Tunnel: tailscale funnel + custom domain (fork custom).

## v0.4.77 Sync — see conversation_cache/feature_set.md (PORTED 2026-06-13e) for full per-commit log.
Ported: gemini unsigned-thought, claude adaptive-thinking downgrade, usage-stats SSE race,
cerebras/mistral client_metadata, anthropic-compat Bearer, commandcode stream, siliconflow .com,
Kiro endpoint+failover+profileArn, copilot gpt-5-mini/nano slots, copilot token refresh-on-missing,
remote default-password warning (mustChangePassword).
Deferred features: MiMo Free, Vercel AI Gateway media, vertex ADC, Cowork, codex bulk import,
tailscale probe refactor, combos/topology display polish.

## Build / Deploy
- npm test (vitest tests/unit) -> 587. npm run build -> .next standalone+static.
- Deploy: EXTERNAL runtime/deploy-live-all-in-one.ps1 -SourceDir <fork> -Port 20128.
- Live + prod server router.antitamper.id.vn require EXPLICIT user confirmation (risk path).

## SECURITY
- Prod dashboard password Asdfmovie2 was exposed in chat -> ROTATE.
- Never commit/upload conversation_cache/ or secrets.
