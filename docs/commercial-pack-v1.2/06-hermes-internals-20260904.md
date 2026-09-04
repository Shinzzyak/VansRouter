# Appendix: Hermes Internals — session loss forensics (v0.21.0 · 7b72fd12^ → 63279301, Jakarta vs local diff)

**Sources.** Jakarta builder (172.232.242.46, x86_64, 15G, 268G free, v0.21.0 7b72fd12) vs local gefreit box (59G, 3.6G, v0.21.0 63279301 — 3 commits ahead: 63279301/58772c fix(reasoning) + 562ee8 fix(prompt)). Pulled via ssh grep/scp to /tmp/jakarta_hermes_state.py (17370L) + /tmp/jakarta_run_agent.py (10175L).

## The 3 loss classes (answer to: why mid-turn / after-compact / at-exit sessions disappear)

1. **Mid-turn loss (flush race, #47202).** `new_session()` order is memory_flush → _flush_messages_to_session_db(history) → end_session(old,'new_session') → discard_if_empty. If the context-engine boundary snapshot fails to flush, the unflushed tail is lost. Fixed by explicit pre-exit flush in #47202.
2. **Post-compaction (handoff race, #88234).** Compression rotates to child session; handoff is list_pending_handoffs() → claim → running → completed/failed polled 60s by gateway (InProcessCronScheduler.tick, flock ~/.hermes/cron/.tick.lock). /new right before exit can race claim — leg-vanish; extraction dropped. Archive has watermark + tail-clone fence to reclaim concurrent appends.
3. **Exit without finalize.** Delegated subagents cascade-delete via model_config._delegate_from marker; gateway drain _notify_interrupted_cron_jobs covers cron but no_agent script jobs bypass the drain.

## What actually changed in the 3221-commit bump for pack coverage

- `prompt_builder.py`: memory→skill routing guidance (skills first, memory narrow exception).
- `conversation_loop.py`: reasoning_mandatory 400 retry (GLM-5.3) path.
- hermes_state.py: schema v30, FTS layout, delegate/compression branches. No cron/compaction-semantic drift in the 3-commit window — pack docs remain current.

---
# Reverse: hermes_state.py compaction/session layer
Source: /tmp/jakarta_hermes_state.py (17370 lines, v0.21.0 7b72fd12, Jakarta VPS pull).
Schema source of truth lives in companion modules pulled to /home/ubuntu/.hermes/hermes-agent/:
`hermes_state_common.py` (SCHEMA_SQL, SCHEMA_VERSION=30) and `hermes_state_schema.py` (mixin).
Line refs below: bare = /tmp/jakarta_hermes_state.py; `C:` = hermes_state_common.py.

## 1. Compression lock mechanism

**Table** `compression_locks` (C:595-600): `session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL, expires_at REAL`. One row per session; imported into jakarta file via hermes_state_common import block (64-105).

**Race it closes** (docstring 9075-9094): conversation_compression.py rotates `agent.session_id` locally, but state.db is shared across all AIAgent instances. Two agents sharing one session_id that both decide to compress each end the parent and create their own child → "parent → two orphan children". Lock keyed by session_id, holder = `pid:tid:nonce`, held for compress() + rotation.

**try_acquire_compression_lock(session_id, holder, ttl=300)** (9141-9227):
- Single write tx: SELECT row → if `expires_at < now` OR holder PID proven dead → DELETE that row (reclaim, 9187-9192) → `INSERT OR IGNORE` (9195-9200) → SELECT to confirm `holder == us` (9201-9207).
- SQLite serialises writers → DELETE+INSERT+SELECT is atomic vs competitors (9160-9162).
- On sqlite3.Error returns **False** = fail-closed, caller skips compression (9220-9227).

**refresh_compression_lock** (9095-9139): `UPDATE ... SET expires_at WHERE session_id AND holder` — ownership decided by **holder column only, not expires_at** (9103-9110): a live owner whose refresher thread was starved past its own TTL may revive its still-unclaimed row. Refresh vs reclaim cannot interleave (single writer, 9112-9117). Default TTL 300s (9099).

**release_compression_lock** (9229-9253): `DELETE WHERE session_id AND holder` — holder-checked so a late-returning compressor can't clobber a new owner; idempotent.

**PID-death reclaim** — `_compression_lock_holder_process_is_dead` (204-249):
- Holder regex `(?:^|:)pid=(\d+)(?::|$)` (197). Only structured holders reclaimable.
- psutil.pid_exists() preferred (recycled PIDs report alive = conservative, TTL still applies, 229-236); POSIX `os.kill(pid,0)` fallback only when psutil missing, never on Windows (237-248).
- Same-process holder never self-reclaims (225-228). Any doubt → keep lease until TTL (214).

**Busy-wait boundary**: `_COMPRESSION_BUSY_WAIT_S = 5.0` (5225). `_execute_write` catches SessionCompressionInProgressError and retries only 5s, then re-raises (6339-6359) — the lease is a correctness boundary, not a busy signal; a writer locked out longer must be refused, not allowed to land a stale turn in a session mid/wedged-compression.

**Commit fences (lease re-verified INSIDE the publishing tx):**
- archive_and_compact: when `lock_holder` given, SELECT lock row; mismatch/expired → SessionCompressionInProgressError, no clobber of the winner's transcript (13467-13482).
- publish_compression_child: optional in-tx lease refresh (`require_lease_refresh`, 8296-8302) then hard expiry check → CompressionSessionBusyError "lease lost before publication" (8303-8315).

**session_turn_leases** (separate cross-process turn lease): durable key = compression-lineage ROOT, not current segment — `_session_turn_lease_key_on_conn` walks parents while `end_reason='compression'` (9255-9291); acquire/refresh/release resolve the key inside the same write tx (9306+, refresh 9442-9449, liveness check 9480-9481). TTL default 300, floor 0.1s (9325). Append path refreshes it inside append_message (12541, 12570-12620).


## 2. Session DB schema (SCHEMA_SQL, hermes_state_common.py:409+, SCHEMA_VERSION=30)

**sessions** (C:419-480) — id TEXT PK; source (cli/telegram/discord/...); user_id/session_key/chat_id/chat_type/thread_id/display_name/origin_json (gateway routing + IDOR scoping, jakarta 7133); expiry_finalized; model/model_config (JSON — carries lineage markers, see §4); system_prompt + system_prompt_hash FK→system_prompts(hash) (content-addressed, deduped v25, jakarta 5263-5271); parent_session_id FK→sessions(id) (self-FK = compression/delegate/branch lineage); started_at/ended_at/end_reason; message_count/tool_call_count; token cols (input/output/cache_read/cache_write/reasoning); cwd/git_branch/git_repo_root/git_metadata_generation; billing cols; estimated/actual_cost_usd + cost_status/source/pricing_version; title/title_source; last_activity_at/description/provenance; api_call_count; handoff_*; compression_* cols (failure_cooldown_until/failure_error/fallback_streak/ineffective_count/recovery_deadline — anti-thrash durable half, jakarta 8735-9056); profile_name; rewind_count; archived/pinned/hidden; last_read_at; tool_names.

**messages** (C:482-507) — id INTEGER PK AUTOINCREMENT; session_id FK→sessions(id); role; content; tool_call_id/tool_calls/tool_name; effect_disposition; timestamp; token_count; finish_reason; reasoning/reasoning_content/reasoning_details; codex_reasoning_items/codex_message_items; platform_message_id; observed; **_compressed_summary** (0/1 marker); **active** (1=live, 0=archived); **compacted** (1=summarized-away); api_content (prompt-cache sidecar); display_kind/display_metadata.

**support tables**: system_prompts(hash PK, prompt); session_model_usage (per model/billing/task, PK 6-tuple, C:509-529); state_meta (KV: fts markers, generation token); gateway_routing (scope+session_key→entry_json); gateway_hygiene_state (failure_streak); conversation_generations (source,session_key→generation, NEVER GC'd — ABA fence for prompt-cache affinity, C:571-576, bump on reset boundaries only C:8451-8488 note + jakarta 8451-8488); gateway_heartbeats (backend_id PK, pid, last_heartbeat — orphan-reap liveness, C:586-593); **compression_locks** (§1); session_turn_leases (conversation_id PK, same shape).

**FTS**: messages_fts (v23 external-content over content/tool_name/tool_calls view, tool rows excluded, tool content prefix-capped 8192 chars via high-water marker C:376-390), messages_fts_trigram (SQLite>=3.34), messages_fts_cjk (loadable libfts5_cjk.so bigram tokenizer, jakarta 4217-4281) — all trigger-maintained, id-gated by state_meta rebuild markers (jakarta 4233-4274), layout version tracked independently as fts_storage_version=2 (C:360-368). Opt-in v23 demotion via `hermes sessions optimize-storage`, never auto-started (jakarta 5644-5650).

**Indexes**: DEFERRED_INDEX_SQL applied post-init; per-table DDL (telegram_dm_topic etc.) reconciled at 16313-16394.

**Key predicates** (C:176-304): _BRANCH_CHILD_SQL (_branched_from marker OR legacy parent end_reason='branched' + started_at >= p.ended_at); _COMPRESSION_CHILD_SQL (parent end_reason='compression', 187-191); _RESET_CHILD_SQL (_reset_from marker OR same-session_key legacy reset); _LISTABLE_CHILD_SQL (roots + branch/reset children — subagent/compression continuations hidden from pickers); _ephemeral_child_sql (parented, none of the three); is_automatic_end_reason (agent_close/ws_orphan_reap/superseded_by_resume/startup_orphan_reap/tui_shutdown/ws_disconnect/idle_timeout/lru_evict, 214-253) — single owner of "accidental vs deliberate end", compression-liveness sites must use it (#88197).


## 3. How compaction reclaims

Two reclaim paths — in-place soft-archive, and rotation. Both leave pre-compaction turns ON DISK; nothing is hard-deleted by compaction itself. Reclaim of disk happens later via auto-prune/VACUUM.

### 3a. Watermark capture
`get_active_message_watermark` (13384-13400): `MAX(id) WHERE active=1`, captured at compression START, before the slow provider summary call. Everything with id > watermark at commit arrived concurrently and must survive verbatim (#75316).

### 3b. In-place compaction: archive_and_compact (13402-13612)
Soft-archive in ONE write tx, session keeps ONE id for life (#38763):
1. Optional commit fence: verify compression_locks still held by lock_holder and unexpired, else SessionCompressionInProgressError (13467-13482).
2. model_config_patch merged via _merge_model_config_json(on_missing='raise') — a prune must not commit against a vanished row (13484-13492).
3. tail_ids = concurrent appends above watermark, snapshot ids + tool_calls (13494-13513).
4. rewind_tail_ids = originals of the carried-forward verbatim tail (tail_count), taken AT/BELOW watermark, before flag flips (13524-13547). Two deliberately distinct sets (#86366): rewind targets below watermark, tail_ids above it; without the bound a concurrent append would steal a LIMIT slot.
5. Flag flips: rewind set (rewind_tail + tail_ids) → active=0, compacted=0 (superseded duplicates, hidden from search — same shape as user rewind); all other active rows → active=0, compacted=1 (13549-13573).
6. Insert compacted_messages as fresh active rows (13574-13576).
7. Re-sequence concurrent tail: pure-SQL column clone (all cols except id/active/compacted; session_id kept — same session) so tail rides AFTER the compacted set, byte-exact, new ids (13578-13595). No decode/re-encode → no field drift; FTS triggers index clones naturally (13434-13439).
8. message_count/tool_call_count set to ACTIVE post-commit counts; model_config patch applied in same tx (13597-13609).

Flag semantics: live = active=1; summarized-away = active=0,compacted=1 (searchable — search_messages includes compacted=1 by default, FTS index keeps them, recoverable via include_inactive=True, 13413-13428); rewind/undo = active=0,compacted=0 (hidden).

### 3c. Rotation: publish_compression_child (8247-8449)
Atomically closes parent + publishes child + compacted handoff in one tx — readers see live parent OR complete child, never ended parent with missing child (8266-8270):
1. Optional in-tx lease refresh then expiry check (8296-8315).
2. Parent must exist and be unended (8316-8324). Stale AUTOMATIC end stamps (tui_shutdown/ws_disconnect/orphan reap/idle/LRU) are cleared in-tx and rotation proceeds — a live lease-holder is definitionally still continuing the conversation; leaving the stamp wedges rotation forever until provider 400s (#88197, 303 msgs → 2,611 rows). Deliberate boundaries (compression/reset/explicit close) fail closed (8325-8349).
3. INSERT child session row: parent_session_id=parent, inherits cwd/git/profile (profile_name or parent's or own store's, 8369-8382) and full gateway routing columns (user_id/session_key/chat_*/thread_id/display_name/origin_json) so peer recovery survives a crash at the boundary (8372-8390). system_prompt stored content-addressed, column NULL (8352, 8356-8361).
4. _insert_message_rows for the compacted handoff (8393-8395); child handoff must not be empty (8350-8351).
5. Watermark tail clone: parent rows with active=1 AND id>watermark (bounded by watermark_ceiling = MAX(id) captured BEFORE the rotation path's own pre-publish flush — those rows are already in the handoff, cloning would duplicate, 8280-8286) cloned into the child AFTER the handoff with session_id rewritten; originals stay in the closed parent for lineage recovery (8396-8434).
6. UPDATE parent SET ended_at, end_reason='compression' WHERE ended_at IS NULL; rowcount != 1 → RuntimeError "parent changed during publication" → tx rolls back (8439-8447).

### 3d. Recovery/failure paths
- find_live_compression_child (8124-8165): stale agent observing a rotation adopts the unique live direct continuation; multiple children = ambiguous → None (fail closed). Filters _NON_CONTINUATION_CHILD_FILTER_SQL (8116-8122): marker must EQUAL the queried parent — presence-only matching misclassified delegate continuations (their model_config carries _delegate_from=<their own parent> verbatim) (8106-8115).
- reopen_orphaned_compression_session (8167-8245): closed parent with end_reason='compression', no canonical child, expired lock reclaimed in-tx (refresh-first would resurrect; recovery-first deletes holder identity, 8209-8230) → parent reopened. Any direct non-branch/delegate/tool child (any ended state) blocks reopen — no second live head (8191-8207).
- record/get/restore/clear_compression_failure_cooldown + fallback_streak + ineffective_count + recovery_deadline (8735-9056): durable anti-thrash counters on sessions.
- _dedupe_display_generations (13655-13703): compaction epochs copy the protected tail into each generation → one logical message as several rows; display reads dedupe by (role,content,timestamp,tool_*) preferring live row then newest.
- Split marker _DB_PERSISTED_MARKER stamped on known-durable dicts (48-50, 14137); append paths do NOT check compression_locks by design (#75316 redesign note, 12554) — the commit fence in archive_and_compact/publish is the enforcement point.

### 3e. Disk reclaim (later, separate cadence)
AUTO_VACUUM_MIN_FREELIST_RATIO=0.25 (117-125): auto-maintenance VACUUMs only when >=25% of file is freelist; composes with min_vacuum_interval_days. WAL size limit 64MiB journal_size_limit (985, 1254). checkpoint every 50 writes PASSIVE (5232), bounded FTS merge every 1000 (5245-5247). _prune_malformed_backups keeps 3 (2569-2570, 2985). Gateway/TUI ghost rows: prune_never_active_keyed_sessions (7627+), empty TUI ghost sessions >24h (10596), auto-prune stale open sources 5171-5179, bulk archive/prune paths 15057-16031. Delegate cascade-delete on parent delete (§4).


## 4. Delegate tracking

Marker: `model_config._delegate_from` JSON key. SQL accessor `_delegate_from_json(col)` (280-281): `json_extract(COALESCE(col,'{}'), '$._delegate_from')`.

Creation: delegate/subagent children set `_delegate_from` at creation, backfilled by v16 migration (331-337). Child row also carries `parent_session_id` → parent id, so lineage is both pointer + marker.

Cascade delete: `_collect_delegate_child_ids` (331-360) walks marker chains recursively (`_delegate_from IN frontier OR (parent_session_id IN frontier AND _delegate_from IS NOT NULL)`, 352-355) so orchestrator subagent's own delegate children go too. Cycle-safe: seeds pre-populate visited set so a looping marker never collects a parent as its own descendant (#49148, 341-348). `_delete_delegate_children` (363-375): DELETE messages of children, orphan untagged stragglers (parent_session_id=NULL), DELETE session rows, return ids.

Generic untagged children keep orphan-don't-delete contract (335) — only marked rows cascade.

Visibility: `_ephemeral_child_sql` (C:294-304) = parented AND NOT branch AND NOT compression AND NOT reset → delegate/tool runs. `_LISTABLE_CHILD_SQL` (C:288-291) surfaces only roots + branch/reset; delegate + compression continuations hidden from pickers. `find_live_compression_child` / reopen paths exclude delegate children via bound-marker filter (8106-8122). `get_resume_conversations` (14300-14303) excludes explicit /branch copies (own transcript) but lineage root walk `get_conversation_root` (14581-14593) treats delegate subagents as same conversation tree for Portal usage tagging.

Conversation generation counter ignores compression + delegates: `_bump_conversation_generation` only advances on `_RESET_END_REASONS` (8451-8488).

## 5. Transcript limits

Constants: MAX_SAFE_RESUME_MESSAGES = 20_000, MAX_SAFE_EXPORT_MESSAGES = 20_000 (117-118). Config override at call time via `_configured_transcript_limit` (128-148): `sessions.max_resume_messages` / `sessions.max_export_messages` in config.yaml, resolved through mtime-cached load_config_readonly, invalid/negative → fallback; **0 disables the guard entirely**. resolved_max_resume_messages/export (151-162).

Exceptions: SessionResumeTooLargeError (165-178, hints "export instead or set 0 to disable") and SessionExportTooLargeError (181-194).

Enforcement (bounded COUNT subqueries, stop as soon as bound exceeded — never a full COUNT on a huge lineage):
- assert_resume_safe (14402-14458): counts lineage DISPLAY set (active=1 OR compacted=1) over `_resume_lineage_ids` — branches count only themselves (14370-14371); tip_only=True counts only tip's active rows (deferred Desktop resume / tip-only model restore; the 85-segment ~29k-row lineage behind a ~700-row tip is the healthy shape and must not be rejected, 14415-14424). LIMIT max+1 probe (14443-14451). Guard disabled (0) skips COUNT entirely (14434-14439).
- get_resume_message_count (14374-14400): same two scopes without raising.
- assert_export_safe (14460-14494): single segment, active=1 only, LIMIT max+1 probe.

Companion budgets: import caps _IMPORT_MAX_SESSIONS=500 / 10k msgs per session / 50k total / 5MB+25MB (5252-5256); MAX_FTS5_QUERY_CHARS=2048 (C:396); MAX_TITLE_LENGTH=100 (10976); preview budget 60 chars / 400-char scaffold window (C:42-48); FTS tool-content prefix 8192 (C:376).

## 6. Write/lease contention envelope (context for compaction timing)

_execute_write (6311-6429): BEGIN IMMEDIATE under self._lock; time-based patience — routine 20s (_WRITE_PATIENCE_S 5210), transcript writes 60s (_TRANSCRIPT_WRITE_PATIENCE_S 5211), activity heartbeats 0.5s (5216). Jitter 20-150ms, backoff 250ms-1s after 2s (5226-5230). SessionCompressionInProgressError gets its own 5s budget (6339-6359) then re-raises — lease is a correctness boundary. BEGIN-IMMEDIATE IOERR retried exactly once pre-callback (6293-6299, 6376-6388); FTS-corruption fail-open detaches indexes and retries the canonical write (6413-6414); structural corruption quarantines handle (6418-6419). Lock-claim holder id = pid:tid:nonce (9093); per-file read-pool permits + cross-process flock live in helpers 381-660.

## Verification
All line refs read directly from the pulled source this session. Numbers to spot-check: 117-118, 197, 204-249, 280-281, 331-375, 5225-5230, 8247-8449, 9075-9253, 9255-9349, 13384-13612, 14374-14494.\n\n---\n\n# run_agent.py agent-loop reverse (Jakarta v0.21.0, 10175 lines)

Source: `/tmp/jakarta_run_agent.py`. Actual loop body lives in
`agent/conversation_loop.py::run_conversation` (called via
`AIAgent.run_conversation` forwarder, jakarta line 9258/9817);
prologue preflight in `agent/turn_context.py::build_turn_context`.
This file holds wrappers: `_compress_context` (8588), `_touch_activity`
(4491), `_emit_status` (1083), durable lease + liveness watchdog (9549+).

## 1. Compaction trigger

Canonical gate: `context_compressor.should_compress(tokens)` /
`should_compress_info()` (threshold = `threshold_tokens`, output room
pre-reserved by `_compute_threshold_tokens`). Fires at three sites:

- Turn-prologue preflight (`turn_context.py` ~1054-1201): cheap char
  gate `_should_run_preflight_estimate` first, then full
  `_preflight_request_tokens` (anchor → native-pruned → generic).
- In-loop pre-API guard (`conversation_loop.py` ~2954-3039, see §6).
- Reactive: provider 413/overflow handler + post-response
  `should_compress(real last_prompt_tokens)`.

Guards shared by all sites: `compression_enabled`, `len>1`,
`attempts < max_compression_attempts`, no failure cooldown
(`get_active_compression_failure_cooldown`), no
`should_defer_preflight_to_real_usage` (rough-estimate known-noisy,
#36718), insufficient-progress latch (`_preflight_compression_blocked`
+ `_compression_warrants_another_preflight_pass`). Timeout path
(`context_compression_timed_out`, #98722) ends turn with
`_COMPRESSION_TIMEOUT_FINAL_RESPONSE`, never sends oversized request.
## 2. Heartbeat / status contract

- `_touch_activity(desc, provenance?, force_persist?)` (4491): thread-safe
  via `_turn_liveness_activity_lock`; bumps
  `_turn_liveness_activity_generation`, stamps `_last_activity_ts/desc/
  provenance`, clears `_turn_liveness_abort_claim`. Kanban bridge
  (`heartbeat_current_worker_from_env`, 60 s, #31752) + durable
  `touch_session_activity` via `_persist_session_activity_if_due`
  (4571, SESSION_ACTIVITY_HEARTBEAT_MIN_INTERVAL_SECONDS ≥30 s).
  `force_persist` bypasses rate limit for terminal stamps.
- `_emit_status(msg)` (1083): dual-sink ` _vprint(force)+status_callback(
  "lifecycle", msg)`; gateway surfaces as lifecycle event.
- `_emit_warning` (1103): same plumbing with `"warn"`.
- `_emit_wait_notice(text)` (1210): `touch_activity` + `thinking_callback`
  (CLI prompt_toolkit / TUI `thinking.delta` / gateway
  `Working — N min` activity, #95548).
- Retry noise goes to `_buffer_status` (1245) and only flushes when all
  retries/fallbacks exhausted; otherwise silently dropped (logs still
  emitted).

## 3. Heartbeat routing through compaction

`_compress_context` forwarder (8588) wraps
`agent.conversation_compression.compress_context` in
`run_compress_context_with_progress_timeout` (8870) with idle/total
ceilings. Heartbeat touches along that path:

- Stall: `_on_timeout` (8760) calls `mark_context_compression_timed_out`
  + `_touch_activity("context compression timed out",
  AGENT_COMPRESSION_TIMEOUT)` (8781) + `_emit_warning` (cooldown ladder
  recorded via `record_timeout_failure`, #62452).
- Blocked-over-threshold: `_warn_context_overflow_blocked` (1120) →
  `_touch_activity("compression blocked (reason)",
  AGENT_COMPRESSION_COOLDOWN)` (1148) + deduped user warning.
- Timeout path inside loop refunds api_call_count + iteration budget,
  persists, breaks with timeout final response (3122-3137).
- Commit fence (`CompressionCommitFence`, 8664): `hard_interrupt`
  serializes cancel vs `begin_commit`; watchdog aborts parked in fence
  abandon at mutation edge via generation claim (4462+, 9602+).
- `force_persist=True` used for terminal compression stamps so the
  60 s persist window never drops them.

## 4. Stream cut handling

Any `finish_reason=="length"` or `incomplete_details.reason` in
`{max_output_tokens,length}` (4009) or `id==PARTIAL_STREAM_STUB_ID`
(4150) is a stream cut. Auth interceptor `PARTIAL_STREAM_STUB_ID` also
covers provider mid-tool-call stream drops (native `compaction`
transport) and content-filter terminations (`_content_filter_terminated`,
4312). Whitespace-only/echo responses suppressed.

Path: normalize via transport (`_trunc_transport.normalize_response`,
4173), classify thinking-exhaustion (4195-4242) / repetition dominance
(4244-4296) — both fail without continuation — then for
non-tool truncated turns up to 4 continuation retries: append interim
assistant fragment (`_length_continuation_fragment`, 4394) + synthetic
user ` _get_continuation_prompt(...)` (`_length_continuation_nudge`,
4429), `restart_with_length_continuation` (4436) with
`_ephemeral_max_output_tokens` boosting (2×→16×, cap 32768, 7407+);
for tool-truncated similarly. Ceiling after 4: strip fragments/nudges
from turn slice (4484), keep joined visible text or emit actionable
exhaustion message (4453-4509). Content-filter stream stall escalates
to `_try_activate_fallback` before continuation (4315-43xx).

## 5. Re-append in-flight prompt after compaction

- `conversation_history_after_compression(agent, messages, history)`
  (call sites 3175, 5973, 6304, 6472, 6670, 8297): re-baselines the
  flush cursor so the compacted rows are not re-appended (doubling
  active context). Legacy rotation → None; in-place → `list(messages)`
  (comment 3166-3174).
- `reanchor_current_turn_user_idx(messages, user_message)`
  (turn_context.py 338; call sites 7376, 1045): after compaction
  rewrote the history, exact-match lookup misses — falls back to last
  user row (`merge-summary-into-tail`). Jakarta mirrors: 2210-2219,
  2507-2517 (override must not clobber a merged summary row).
- `_restore_user_after_reference_handoff` (245): re-appends this
  turn's real user ask when compaction left only a reference-only
  handoff (#80622); `_should_skip_model_call_for_reference_handoff`
  (277) skips the model call when nothing actionable remains and
  returns `_HANDOFF_SKIP_FINAL_RESPONSE` (298).
- Preflight compaction timed out mid-prologue: `PreflightCompressionTimedOut`
  → fail-closed boundary (2133-2175) returning `compression_exhausted`
  result, `api_calls: 0`.

## 6. Pre-API compaction pressure

Per-iteration, before every provider call (2860-3039): rebuild exact
`api_messages` (MoA prepared request 2866-2881, images stripped),
`approx_tokens = estimate_messages_tokens_rough(api_messages)` (2898),
then route-aware pressure
`request_pressure_tokens = _midturn_request_pressure_tokens(agent,
api_messages, effective_system, approx)` (133-175): native Responses
eligibility → checkpoint-pruned estimate (3050), else rough + tools
(2950); then anchored override (`anchored_context_tokens`, 2917) else
`_pressure_with_real_floor` (612-639: never below last real
`prompt_tokens` except one turn post-compaction,
`awaiting_real_usage_after_compression`).

Fires when `should_compress(request_pressure_tokens)` mirrors
prologue chain (2962-2970: defer → cooldown → threshold + anti-thrash).
On fire: status via `automatic_compaction_status_message(...,
phase="pre_api")` + `_emit_status` (3095-3113), `agent._compress_context(
approx_tokens=request_pressure_tokens)` (3116), refund call/budget
(3186-3188), reset retry/empty counters, `conversation_history_after_
compression` (3175), handoff guard then `continue` for full rebuild.
Lock-skip/transient-block no-ops refund the attempt without arming the
progress blocker (3138-3156); genuine insufficient progress arms
`_preflight_compression_blocked` for the turn (2996-3017); blocked +
over-threshold warns via `_warn_context_overflow_blocked` (3231-3256);
disabled-compression overflow warns via
`_warn_uncompressed_context_overflow` (3257-3283).

## 7. Why sessions disappear mid-run / after compaction

### Context-engine boundary + deferred handoff (new_session)

Cross-session persistence is gated by
`AIAgent.reset_session_state(..., carry_over_context)` (jakarta 772-902).
The built-in `context_compressor` rebinds engines at that boundary via
`_transition_context_engine_session` (772/889). Legacy compression
rotates to a **new child session**; the compressed transcript lives
only in the child — see `conversation_compression.py`
`conversation_history_after_compression` (2840-285x) and the
`#57491` copy-marker strip (`_fresh_compaction_message_copy` 341).
In-place compaction keeps the same `session_id` via
`SessionDB.archive_and_compact()` soft-archive (see 3166-3177 mirror:
`return list(messages)` when `_last_compaction_in_place` is true, else
`None` for rotation). Parents that already rotated are adopted via
`_adopt_live_compression_child` (3909-3925) or stale-session probe
`recover_rotated_compression_session` (2195); otherwise the rotation is
skipped. Session id is also rotated on the `hermes_logging`
`threading.local` (8968-8987) and `ContextVar` (8977-8988) so later
logs/metrics use the child. Forgetting to adopt the child (e.g. a
cached gateway agent still holding the parent id) makes the session
look empty on resume, and `/new` mid-turn drops the extraction entirely.

### Heartbeat throttling on compaction

Durable `touch_session_activity` is rate-limited to
`SESSION_ACTIVITY_HEARTBEAT_MIN_INTERVAL_SECONDS >= 30 s` (4574-4595,
fail-open) and kanban heartbeat to 60 s (4509) — both swallowing
errors. During long compaction the watchdog is the only liveness
signal (`turn_liveness.py`, wired 9549-9816): `_touch_activity` bumps
`_turn_liveness_activity_generation` (4539) under
`_turn_liveness_activity_lock`; the polling watchdog
(`TurnLivenessWatchdog.schedule`, 9731) commits only when the sampled
`(generation, ts)` still matches under the same lock
(`_commit_turn_liveness_abort`, 9598/9628). Terminal compression
stamps use `force_persist=True` (4520/4567) to bypass the 60 s window
— without it the durable observer would not see compaction-complete and
the lease watchdog could reclaim the session as stalled (#95548).

### Native vs model (Hermes-side) compaction

Native Responses compaction is a **transport gate, not local history
rewrite**: a `type:"compaction"` checkpoint item is only honoured when
the current request is `native_compaction_eligible` (cursor
`codex_responses_adapter.py` 534-548, 598-608, 810-820); otherwise
`prune_pre_checkpoint_items` is skipped (834-839) so a persisted
checkpoint can never erase pre-checkpoint rows forever. To avoid
false triggers, pressure uses
`estimate_native_responses_preflight_tokens` (888-942) when eligible
(`_midturn_request_pressure_tokens` 133-175, mid-loop 2901-2909); the
estimate counts the system prompt once and native excludes stale
thinking (`_agent_stale_thinking_on_wire`, 2888-2900). Hermes-side
(model summarization) compaction rewrites local `messages` via
`_compress_context` (8588) and persists via `archive_and_compact` —
the durable transcript changes and resumable prefix cache invalidates.
Route swap mid-turn (eligibility flip) is the main divergence: one path
prunes only the wire, the other rewrites durable state, so post-turn
lookups on the wrong path see rows the other hid.

### Transcript dedup / duplicate survival

Marker ` _DB_PERSISTED_MARKER="_db_persisted"` (jakarta 314, 2475/2481)
replaced `id(msg)` dedup after CPython reuse alias #50372/#860.
`_flush_messages_to_session_db` (2358-2459) prefix-skips (2445) and
batch-writes only unstamped non-scaffold rows. One-shot
`_flushed_db_message_ids` seed translated to markers (2415-2430) then
cleared.

Copy must strip markers: `_fresh_compaction_message_copy` (ctx 341),
`_strip_persistence_markers` (ctx 404), `_sync_persisted_markers`
(jakarta 8902). Leak = rotation flush to child skips rows, child looks
empty (#57491). Orphans dedup via `has_platform_message_id` (2232).

Ephemeral ` _EPHEMERAL_SCAFFOLDING_FLAGS` (272-303) — empty, prefill,
verify, kanban-stop, dropped-toolcall — never flushed. Positional
`max(historyLen, lastFlushed)` slice removed (#46053). On pool-worker
path snapshots deep-copied (8715) so late engine cannot rewrite live
transcript (#76354). Done.

### 8. Turn lifecycle after compression

Immediately after a boundary, `run_conversation` does not resume the provider
call — it re-baselines and rebuilds the request from the compacted transcript.

**Summary injection into live history.** `ContextCompressor.compress()`
(`agent/context_compressor.py`, def at 8038) assembles
`compressed = head + [summary] + tail`: head is the `protect_first_n` block
(system + first user pinned), tail the `protect_last_n` surviving turns. Two
placements:
- standalone carrier `compressed.append({role: summary_role, ...})` (8721)
  carrying `SUMMARY_PREFIX` (251) + `_SUMMARY_END_MARKER` (525) appended at
  8718 (`summary + "\n\n" + _SUMMARY_END_MARKER`); metadata key
  `COMPRESSED_SUMMARY_METADATA_KEY` (288) marks it for frontends.
- alternation-collision merge: summary folded into `tail[_merge_target_idx]`
  (8754-8798) via `_append_text_to_content`; the `_force_user_leading` path
  prepends `summary + "\n\n" + _SUMMARY_END_MARKER + "\n\n"` (8761) to satisfy
  Anthropic user-leading templates. Either path calls `drop_stale_api_content()`
  (8797) so a stale `api_content` sidecar cannot replay pre-merge bytes.

Caller side (`agent/conversation_loop.py` pre-API guard 3116/3175; sibling
sites 5968/5973, 6270/6304, 6451/6472, 6615/6670, 8280/8297):
`messages, active_system_prompt = agent._compress_context(...)` then
`conversation_history = conversation_history_after_compression(agent, messages,
history)` (3175) — legacy rotation returns `None` (child session owns the
compacted rows), in-place returns `list(messages)` (comment 3166-3174). Loop
then `continue`s so the next iteration rebuilds `api_messages` from the
compacted `messages`; a request built before the boundary is never sent.

**Next turn's preflight view.** `build_turn_context` (turn_context.py
~1054-1201) sees the summary handoff as the leading context; pressure is
re-derived through `_midturn_request_pressure_tokens` (133-175) and the
anchor chain. `estimate_native_responses_preflight_tokens` (888-942) runs only
when the route is still native-eligible — the summary replaced local rows, not
the wire checkpoint, so the two paths estimate differently (inferred from §1
route split above). The one-turn `awaiting_real_usage_after_compression` grace
in `_pressure_with_real_floor` (612-639) lets pressure sit below the last real
`prompt_tokens` for exactly one post-compaction turn, preventing an immediate
re-compaction off a stale real-usage floor.

**Turn lease + liveness watchdog vs compression locks.** The turn prologue
(jakarta 9370-9430) serializes the full load→run→flush region cross-process:
`_turn_db.get_session(session_id)` probes durability, then
`acquire_session_turn_lease(session_id, holder, ttl_seconds=300.0,
wait_seconds=1800.0, on_wait=..., should_abort=interrupt)` (hermes_state.py
9359; try_acquire 9306). Holder `pid=…:turn=…:platform=…` (9412-9414) is
parsed by `_COMPRESSION_LOCK_HOLDER_PID_RE` (197); dead-pid holders are
reclaimed immediately. Only after admission: `_lease_waited` triggers
`resolve_resume_session_id` + full transcript reload (9457-9467) — a holder
may have compressed and rotated the session while we waited. Agent attrs
`_active_session_turn_lease_holder/_ttl` (9470-9472) are read by every
`append_messages_batch(..., compression_lock_holder=..., turn_lease_holder=...,
turn_lease_ttl_seconds=300.0)` flush (2640-2650): #75316 redesign (hermes_state
12554) — appends do NOT check compression_locks; only
`reject_active_compression_lock=True` writers do (12568-12585), so a flush
fenced in the same SQLite transaction as the transcript insert can never land
in a dead owner's window. Refresher: `_refresh_durable_turn_lease` (9727)
on the shared periodic scheduler every `_lease_refresh_interval` (60 s,
9465-9467), holder-qualified UPDATE (hermes_state 9126/9325). Lease renewal is
NOT progress (#95548 comment 9549-9567): the liveness watchdog
(`turn_liveness.TurnLivenessWatchdog` scheduled 9731, config via
`resolve_turn_liveness_settings` 9573) samples `(generation, ts)` from
`_touch_activity` (4479-4550, same `_turn_liveness_activity_lock`); commit
gate `_commit_turn_liveness_abort` (9598) revalidates the pair under that
lock, publishes `interrupt(..., require_generation=...)`, and declines
fail-closed (9646-9661) when the claim went stale — a turn that resumed
mid-observation is never hard-cancelled (#95663 rounds 3/4/6). After a
committed abort `_deactivate_turn_after_liveness_abort` (9667) stops renewal
so TTL expiry lets stale-turn cleanup reclaim the row. Long compactions keep
liveness alive via `force_persist=True` terminal stamps (§3), and compression
lock staleness mirrors the same pid-liveness reclaim (hermes_state 9141-9229).

**In-flight prompt re-append after compaction (#100818, 0ed3f9b).**
`SUMMARY_PREFIX` (context_compressor 251-285) orders: respond ONLY to the
latest user message AFTER the summary — "If no user message appears AFTER
this summary, do nothing" (260-261). A single-prompt cron session's only user
turn is the job prompt pinned in the protected head, so compaction leaves it
BEFORE the boundary → model emits `[SILENT]`, scheduler records success
(silent failure). `0ed3f9b` (cherry-picked c0ea50ac) added:
- `_find_inflight_user_task(messages)` (6818): scans the WHOLE transcript —
  `protect_first_n` hides the head from `_find_last_user_message_idx` — via
  `_is_actionable_user_turn` minus `_is_synthetic_compression_user_turn`
  (excludes inherited summary rows, #80622: idle sessions never reanimated).
  In-flight = trailing rows contain no completed text-bearing assistant reply
  without pending `tool_calls` (6830-6840); a final answer means the ask is
  done and NOT replayed (test `test_completed_exchange_is_not_replayed`).
- `_reappend_inflight_user_task(compressed, inflight)` (6871): no-op unless a
  summary carrier exists and no actionable user row follows it (6880-6890);
  if carrier text is empty after `_SUMMARY_END_MARKER` and
  `_template_visible_role(compressed[-1]) == "user"`, MERGE the replay into
  the carrier after the marker (`_INFLIGHT_TASK_REPLAY_HEADER` 549, prefix
  "[STILL IN PROGRESS — … Continue it; do not start over.]") to preserve
  user/assistant alternation (6966-6968, `_INFLIGHT_REPLAY_MERGED_KEY` 547
  guards double-merge 6850); otherwise append a `_fresh_compaction_message_copy`
  replay row (6946-6951). Post-0ed3f9b ordering note: jakarta (v0.21.0) calls
  `_reappend_inflight_user_task` BEFORE `_sanitize_tool_pairs` — shipped main
  calls it after (compress 8809-8812) because the sanitizer's trailing
  in-flight exemption (#79278) would strip a genuinely pending
  assistant(tool_calls) when a replay user row sits at the list end.
- wired at end of `compress()` assembly (8801-8812, before
  `self.compression_count += 1` 8814), regression tests
  `tests/agent/test_cron_inflight_prompt_reappend_100818.py` (214 lines:
  survives-after-handoff, idle-not-reanimated, alternation preserved).

After this point `compress()` returns; everything downstream
(`conversation_history_after_compression` re-baseline, `continue`-rebuild,
lease-fenced flushes 2640-2650) is the §8 lifecycle.

## Summary

- Compaction fires at three sites (turn-prologue preflight, per-iteration
  pre-API guard, reactive overflow) behind one shared guard chain
  (`compression_enabled`, cooldown, anti-thrash, insufficient-progress latch);
  the timeout path is fail-closed — `_COMPRESSION_TIMEOUT_FINAL_RESPONSE`,
  never an oversized request.
- Liveness is layered: in-process `_touch_activity` generation clock →
  60 s-scheduled durable lease refresher (TTL 300 s, holder-pid reclaim) →
  sampling watchdog whose aborts revalidate `(generation, ts)` under the same
  lock and decline fail-closed on staleness (#95663); lease renewal alone is
  never progress (#95548).
- The compression lock and the session-turn lease are separate SQLite rows
  with the same 300 s default TTL and the same dead-pid reclaim; transcript
  appends do NOT check compression locks (#75316) — only lease-fenced
  `append_messages_batch` writers do, in the insert's own transaction.
- After a boundary the loop never resumes the pre-compaction request: it
  re-baselines the flush cursor (`conversation_history_after_compression`),
  and `continue`s to rebuild `api_messages`; one-turn
  `awaiting_real_usage_after_compression` grace keeps the fresh transcript
  from instantly re-tripping the threshold.
- The handoff summary is injected either as a standalone marked row
  (`SUMMARY_PREFIX` + `_SUMMARY_END_MARKER`, frontends see
  `COMPRESSED_SUMMARY_METADATA_KEY`) or merged into a tail row for
  alternation/user-leading templates, with stale `api_content` dropped
  either way.
- #100818 (0ed3f9b): single-prompt (cron) compaction left the only user ask
  before the boundary, so the model obeyed SUMMARY_PREFIX's "do nothing" and
  the scheduler recorded success — fixed by re-appending the in-flight task
  after the summary (merged into the carrier when alternation requires),
  never for completed exchanges or idle inherited-summary sessions (#80622).
- Stream cuts are continuation, not failure: up to 4 retries with interim
  fragments + nudge and 2×→16× max-output boost before the ceiling path
  strips scaffolding and emits the exhaustion message; content-filter stalls
  escalate to fallback first.
- Session "disappearance" after compaction is almost always rotation
  bookkeeping: legacy compression rotates to a child session (compacted rows
  live there), and a caller that keeps the parent id — or `/new` mid-turn —
  reads an empty transcript unless it adopts the child
  (`_adopt_live_compression_child` / `recover_rotated_compression_session`).
