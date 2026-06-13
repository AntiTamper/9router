# 9router Fork — Feature Set Index

## PORTED 2026-06-13d (model-test image/STT cluster + debug closure)
- model-test cluster (8671468 merge: e414975/d4c3e63/dcf9bee/c980e1f/c980e1f):
  - NEW src/app/api/models/test/ping.js: pingModelByKind(model, kind, baseUrl) with branches embedding -> /api/v1/embeddings, image -> /api/v1/images/generations, stt -> /api/v1/audio/transcriptions (silent 16k/250ms WAV via createSilentWavFile), default llm -> /api/v1/chat/completions. Preserves fork internal auth (getApiKeys + x-9r-cli-token machineId + CLI_TOKEN_SALT).
  - src/app/api/models/test/route.js: slimmed to delegate to pingModelByKind (137->14 lines region).
  - src/app/api/providers/[id]/test-models/route.js: inner pingModel() replaced with pingModelByKind(`${alias}/${id}`, model.type || "llm", baseUrl). PRESERVED fork-only kiro dynamic model list + compatible-provider live /models fetch. Removed stale local pingModel/getInternalApiKey/CLI_TOKEN_SALT/getConsistentMachineId.
  - open-sse/services/model.js: ALIAS_TO_PROVIDER_ID += hf/huggingface (was missing -> HF model routing broke; fork has huggingface provider w/ hf: model ids).
- Tests: ported tests/unit/model-test-routing.test.js + hf-model-routing.test.js (PASS). DROPPED tests/unit/provider-test-models-routing.test.js: incompatible with fork-only open-sse/utils/proxyFetch.js which auto-patches globalThis.fetch at import -> clobbers vitest fetch spy (TypeError: not a spy). Functionality still covered by model-test-routing at ping.js level.
- Verify: eslint clean (4 files), vitest 587 passed (was 581 + 6 new), next build OK (96s).

### DEBUG CLOSED: output_tokens=1 on Claude Code (prod) = ANTHROPIC-SIDE, NOT a 9router bug
- Authed to prod, pulled request-details. out==1 rows: response='[Empty streaming response]', input_tokens:4 fresh + cache_read:99258 (~104k cached), 51 msgs, last user = tool_result + 3x 'continue' text blocks, prev=assistant(text+tool_use), 25/25 tool pairs 0 orphans, tool_choice:auto, max_tokens:64000, thinking:null.
- cc_suffixed=0 -> cloaking did NOT run; 35 tools are real Codex toolset (not 9router decoys). Translation faithful (tool_result carried real shell output). Stream properly terminated (DONE sentinel + message_stop). A 227-msg convo with real new instruction worked (out=1469).
- Conclusion: Claude returns an empty end_turn (output_tokens:1) for a 'continue'-only follow-up against a fully-cached prompt; client (Codex) retries -> identical empty. No upstream fix exists. Did NOT add synthetic-content mitigation (would corrupt convo / mask real empty turns). Logging pipeline verified correct (extractUsage reads final message_delta only).

## PORTED 2026-06-13b (second pass — more gaps + bug hunt)
- 2be00e2 body limit: next.config.mjs adds experimental.proxyClientMaxBodySize (env NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE, default 128mb). Stops 10MB truncation of large /v1 payloads (long context / base64 images).
- 38b73bf antigravity passthrough: src/mitm/config.js MODEL_NO_MAP={antigravity:[/^tab[_-]/i]} (+export); src/mitm/server.js imports it and passthroughs tab-autocomplete BEFORE getMappedModel. Stops broad `flash` pattern hijacking tab_* models -> laggy inline completion + per-keystroke quota burn. Also set mandatory:true on antigravity Default model in cliTools.js (metadata parity).
- 41f94ce (bug-fix part only): open-sse/handlers/chatCore/nonStreamingHandler.js Claude->OpenAI guard now bails only on non-array truthy content; iterates (content || []). Fixes content:null bodies (thinking-only / max_tokens:1) that previously returned raw Claude body with no choices array -> OpenAI client/UI test error. Line 104 already defaults content:"" so output stays valid.
- Verify: eslint clean (5 files), vitest 581 passed, next build OK.

### Decided NOT to port (this pass)
- 61d5466 / 12c97ad qoder qmodel_latest + import btn: fork has NO qoder executor/constants (git grep qoder = none). Substrate missing; N/A.
- 41f94ce model entries + usage.js MiniMax quota rework: fork uses lowercase model ids (minimax-m2.7) vs upstream MiniMax-M2.7; quota-tracker rework risks the fork quota-bars feature. Deferred.
- 8ad9554 kiro tool-bearing-history 400: 284-line rewrite of openai-to-kiro.js on upstream base 716ec86; fork translator diverged (currentMessage flow differs). Needs careful adaptation, not blind port. Deferred.
- model-test cluster (8671468/c980e1f/dcf9bee/d4c3e63/e414975/cce8a50): fork route.js (120 lines) has NO image/STT handling -> media/STT connection tests likely broken. Real gap but 600+ line refactor (extracts ping.js, touches model.js + test-models route). Deferred — sized for its own pass.
- 64f5842 i18n exposure notice, f161b29 menu reorg, 4758a00 RU README, 281f292 upstream tests: cosmetic / conflicts / not applicable.

## PORTED 2026-06-13 (v0.4.71 adapt — built+tested on master 74b3592)
- c785051 cloaking: open-sse/utils/claudeCloaking.js now suffix-rewrites forced tool_choice.name (only client tools, never decoys). Fixes Claude 400 "Tool not found" on cc/ OAuth forced-tool.
- 4fc02e6 minimax: open-sse/utils/reasoningContentInjector.js PROVIDER_RULES += minimax + minimax-cn (scope:all). Fixes MiniMax follow-up 400.
- 293cf40 tunnel: src/shared/services/initializeApp.js getNetworkFingerprint() now skips VIRTUAL_IFACE_REGEX (utun/awdl/bridge/vmnet/veth/docker...). Stops false netchange -> tunnel drop/URL rotate on custom-domain. NOTE: only the fingerprint filter was ported; fork safeRestartTunnel custom-domain logic left intact (NOT replaced with upstream rewrite).
- Verify: eslint clean, vitest 581 passed, next build OK.
- STILL OPEN (not ported): 0850f0a kiro mitm, 38b73bf antigravity MODEL_NO_MAP, 41f94ce MiniMax-M3, 12c97ad/61d5466 qoder latest, model-test cluster (e414975/d4c3e63/dcf9bee/c980e1f), cce8a50, 40cfa63, UI/i18n lows.

> Generated 2026-06-12 (rev2, content-verified). Fork tip `74b3592` (pkg 0.4.70), branch master == antitamper/master.
> Upstream `decolua/9router` master `827e5c3` (tag v0.4.71). Divergence base `e1b821d` (v0.4.59). Fork ahead 70 / upstream ahead 57.
> Method: per-commit content inspection (not just patch-id / line-overlap). Many "conflicts" are fork re-implementations, NOT gaps.

## Fork-Only Features (not upstream)
- API key overhaul P1-P6: fusion limits, hard-cap anchor, timers, overage, per-key token saver, model/combo exposure enforcement, public /apikey page + /api/apikey/info, dashboard config modal, global mode controls. `f8758aa`..`74b3592`.
- Custom system-instruction injection (global + per-key) + holder self-service toggles. `74b3592`.
- Isolated public /apikey/info rate limiter (login-DoS / lockout protection). `4a99c39`.
- Combo routing respects disabled-models list. `c250e04`.
- Additive DB import w/ conflict prompt + per-provider account import. `055cc8b`.
- Custom domain support (disabled by default). `2241ea9`.
- Codex usage forwarding (codexUsageEnabled, gated to real Codex UA, emits max_input_tokens). `25808d3` `61c648a` `7ebbfe7` `3bf8d79`.
- Kimi: live model metadata, compact-timeout cooldown fix, OpenAI-compat entries for context_window. `9388534` `c61d201` `b444944`.
- Codex OAuth fresh-token protection + DB lease-based durable refresh (refreshLeaseId/refreshLeaseUntil/lastSuccessfulRefreshAt). `3477157` `d7973ca`.
- Provider quota-bars + bounded cancellable nonblocking quota refresh queue. `ff7b7f4` `a0fcdbd`.
- Anti-stall memory safeguards, bounded runtime caches. `42b4ca5` `e2faca2`.
- TOON / RTK / Caveman token savers (Kiro conversationState covered).
- Provider translation service. `eae117f`. open-sse standalone bundle copy `a25df9c`.

## Upstream Features ALREADY Present (verified, equivalent or superior)
- Wenyan + Lite/Full/Ultra UI: PRESENT (EndpointPageClient.js:62-90, wenyan-<intensity> encode). Image-confirmed.
- Stream stall + fetch connect timeouts: PRESENT and tuned (runtimeConfig STREAM_STALL_TIMEOUT_MS 35s, FETCH_CONNECT_TIMEOUT_MS 20s, Kimi 120s variant). Covers most of `9caea88`. codex_cli_rs originator PRESENT.
- Codex durable OAuth refresh: fork has SUPERIOR DB-lease mechanism. Upstream `c233c7c` is a competing oauthCredentialManager abstraction — DO NOT blindly port; would regress fork lease system.
- One-connection guard: PRESENT for BOTH OpenAI + Anthropic compatible (route.js:160). Mostly covers `44d8de2` (embedding-node edge may differ).
- openai-to-claude tool_choice type sanitization: PRESENT (convertOpenAIToolChoice maps function->tool, required->any, unknown->auto). Covers translator half of `c785051`.
- Qoder, antigravity (+gemini-3.5-flash-extra-low), minimax (M2.7/M2.5/M2.1), xiaomi-tokenplan (MiMo), opencode, kiro auto-slot, wenyan prompts — all PRESENT.
- json_schema fallback, Read-arg sanitize, Copilot routing, proxy-pools (deno/CF workers) — in earlier adapt range.

## GAPS — genuinely missing (content-verified)

### High value
- `c785051` (cloaking half) — claudeCloaking.js does NOT rewrite forced tool_choice.name to the suffixed tool name. Forced tool on cc/ OAuth route -> Claude 400 "Tool not found". REAL BUG in fork. Translator half already covered; port only the cloaking rewrite.
- `293cf40` tunnel virtual-iface skip — VIRTUAL_IFACE_REGEX ABSENT. utun/awdl/bridge/vmnet/veth/docker etc. flap -> false netchange watchdog restarts -> drops cloudflared tunnel + rotates quick-tunnel URL. Affects custom-domain deploy. REAL GAP.
- `4fc02e6` minimax reasoning_content echo — reasoningContentInjector has deepseek rule but NO minimax / minimax-cn keys. MiniMax follow-up turns 400. REAL GAP (3-line add).
- `0850f0a` mitm Kiro binary EventStream crash + models & TTS tool filtering — large (kiro.js +359, base.js, server.js). Verify against fork mitm; likely REAL GAP.

### Medium value
- `38b73bf` antigravity MODEL_NO_MAP (tab-autocomplete passthrough) — ABSENT. Without it broad `flash` pattern hijacks tab_jump/tab models -> laggy inline completion + quota burn per keystroke. REAL GAP.
- `41f94ce` MiniMax-M3 model + Quota Tracker coding/CN — fork has M2.7 (ahead) but NO M3. Partial GAP (add M3 entry).
- `12c97ad` + `61d5466` qoder fetch-latest-model + qmodel_latest key + dashboard import button — ABSENT (no latest handling in qoder executor; no src/lib/qoder/constants.js). REAL GAP.
- `e414975` + `d4c3e63` + `dcf9bee` + `c980e1f` model-test routing for image + STT (valid WAV, hardened ping) — fork has only models/test/route.js, NO ping.js extraction. STT/image connection test likely broken. REAL GAP.
- `cce8a50` add opencode-go + xiaomi-tokenplan to connection test route — verify; likely small GAP.
- `40cfa63` xiaomi MiMo V2.5 Pro Claude-native alias via dedicated executor — fork has xiaomi executor; alias add may be partial GAP.

### Low value (UI / i18n / docs)
- `64f5842` i18n endpoint exposure notice (multi-language) — translator strings; cosmetic GAP.
- `f161b29` dashboard menu reorg (HeaderLanguage etc.) — conflicts with fork dashboard; skip unless wanted.
- `48c37e0` wenyan locale-based level visibility — wenyan UI already present; this only gates by locale. Minor.
- `4758a00` RU README + remove testFromFile — docs. `281f292` translator tests. `2be00e2` 128MB body cap (fork already has bigger cap — verify parity).

## Port Order
1. Fork-bug fixes (small, high value): `c785051` cloaking rewrite, `4fc02e6` minimax keys, `293cf40` tunnel virtual-iface.
2. Provider correctness: `0850f0a` kiro mitm, `8ad9554`, `38b73bf` antigravity no-map.
3. Model-test routing cluster (`e414975`/`d4c3e63`/`dcf9bee`/`c980e1f`, `cce8a50`).
4. New models/aliases: `41f94ce` M3, `40cfa63`, `12c97ad`+`61d5466` qoder.
5. Codex `9caea88` Responses-terminal-event delta only (timeouts already present). Do NOT port `c233c7c` wholesale (fork lease superior); optionally lift only a staleness cap.
6. UI/i18n/docs last.

## Verify-Before-Port Rules
- NO blanket merge. Cherry-pick + manual reconcile; fork files diverged heavily.
- Preserve: Kimi context/compact, Codex usage forwarding, Codex OAuth lease+fresh-token, quota queue, quota-bars UI, API-key overhaul, custom domain, standalone asset copy.
- After each port: npm run lint, npm test, npm run build, candidate smoke; deploy via runtime/deploy-live-all-in-one.ps1 -SourceDir <fork> -Port 20128.
