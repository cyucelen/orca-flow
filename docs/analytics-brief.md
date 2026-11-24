# Analytics: product and measurement brief

Status: design draft, 2026-11-23. Nothing here is built. Interactive prototype: `docs/analytics-draft/index.html`, published at https://claude.ai/artifact/ScBD1dTBSuN822Z3gk1MbD (private until shared). All numbers in the prototype are sample data, computed from one data object; a footer check confirms every level adds up.

## 1. Problem and goal

Token Speed answers "how fast are the agents writing right now". Analytics optimises for two things, in this order (agreed with the user, "A + curiosity"):

**A. Tune routing and delegation.** The decisions are made in Settings → Models (which model, effort and fallback each kind row and task type starts on) and in when work is split into workers. The questions:

1. **Which kinds of task cost what, and do they succeed?** Per Settings → Models row: tasks finished, median tokens and cost per task, how often they fail and are retried, whether the fallback ran.
2. **Where did a workstream's tokens go?** Lead vs workers, which model, retries.
3. **Did a change in delegation policy help?** Comparable work finished more cheaply, faster, at equivalent quality.

**Curiosity second:** a glanceable strip of facts (tokens this window, biggest workstream, model share, cache share, most expensive task) that informs no single decision.

Token Speed cannot answer any of this. It keeps only output tokens, only per model, only for 24 h, and knows nothing about who spent them (§3).

## 2. Proposal: Analytics replaces Token Speed

**(a) Compact sidebar section "Analytics"**, in Token Speed's place and with its fold/range behaviour (`src/token-speed-view.ts:155-159`):

- Keeps the glanceable throughput: output tok/s of all agents over the last minute and the per-model rate glance (`token-speed-view.ts:162-165`, `:191-194`).
- Keeps network access as it is: agent traffic (nettop) as a headline stat and the internet line with its Test button (`token-speed-view.ts:162-173`). The traffic chart (`:196-211`) stays one click away behind "Agent traffic chart".
- Adds **one usage line**: "This week 52.4M tokens · ≈ $48 · Usage ›" ("at API prices, not your bill" is its tooltip, so it fits 340 px). No breakdowns or warnings in the sidebar.
- Settings → Features keeps one switch, renamed from Token Speed (`src/settings.ts:14`, `:80-83`; `src/panel/app.ts:132-150`).

**(b) Usage view, top to bottom.** The order follows the goal: the strip is small and first because it costs one glance; the routing table is the main block because it is what the user changes; delegation (lead overhead, then the policy comparison) next; the biggest-workstream list last, as context.

0. **Curiosity strip**: tokens in the window with "≈ $X at API prices · not your bill", biggest workstream, model share (one thin bar), share of input served from cache, most expensive single task. No controls.
1. **By task kind**: one row per Settings → Models row (simple, normal, hard, each user task type) plus a Lead row. Columns: model and effort, tasks finished, median tokens, median est. cost, failed %, median time. A row says when its fallback ran; under 3 tasks it says "few tasks" instead of medians. A task counts on the row it **ran on** (kind or type, one up for high risk, at least normal for large context, one more per retry, as `src/routing.ts` decides), not the kind it was dispatched as. A row opens its tasks (task · tokens · cost · result), each opening its workstream.
2. **Lead overhead**: median share of a workstream's tokens spent by its lead, over finished workstreams with workers, and the three heaviest. High = coordination costs more than the work.
3. **Policy comparison**: the four-row Baseline/Variant/Change table with its caveat; other labelled pairs as links. An incomparable pair is one sentence saying why.
4. **Biggest workstreams**: the five largest finished in the window, by whole-run tokens, one line each.

One window toggle (7 days · 30 days · All) sets the activity totals and which finished tasks and workstreams are counted (§5). The **workstream** screen is one line of figures and one row per lead session, worker and retry, with model badge, the task's kind → row, tokens and est. cost. The **comparison** screen is the same four-row table.

**What the UI shows vs what lives in Details.** Each block shows only what its question needs. The four token categories, handover and dedupe notes, how each task's row was derived, the per-run comparison table and the metric definitions sit behind closed "Details" toggles; partial coverage, Unattributed, prices and "no estimate" are quiet chips or tooltips. The rules in §3–§8 are unchanged: the screens apply them without displaying them.

## 3. Current capability vs required instrumentation

What Token Speed reads today (`src/token-speed.ts`):

- Claude Code logs `<profile>/projects/**/*.jsonl` and Codex rollouts `<home>/sessions/**/*.jsonl`, read incrementally with one cursor per file in `token-speed-cursor.json` (`token-speed.ts:4-17`, `:29`, `:58-73`).
- From each line it keeps only type, timestamp, model, message id and **output** token count: `Response = { model, out, start, end }` (`:6-7`, `:52`). Claude reads `usage.output_tokens` only (`:111`); Codex reads `token_usage_record.usage.output_tokens` (`:159-168`), falling back to `token_count.info.last_token_usage` (`:170-177`). Input and cache fields are on the same lines and are parsed past.
- Claude responses are grouped by `message.id`; each content block is a line with the usage so far, and the last line wins (`:112-115`).
- History is 1-minute buckets for 24 h (tokens per model, responses per model, agent bytes up/down) plus rate histograms (`:22-24`, `:272-284`); pruned after 24 h (`:358-362`); cursors dropped after 25 h (`:47-48`). Responses over 10 min are dropped (`MAX_RESPONSE_MS`, `:37`, `:332`); under 50 tokens stay out of medians (`:39`, `:342`).
- Network: nettop snapshot of agent sockets every 30 s, diffed (`src/worker.ts:1880`, `:1966`); `networkQuality -c` only on Test (`worker.ts:2001`).

| Need | Token Speed now | Missing | New instrumentation records |
|---|---|---|---|
| Output tokens | per model, 1-min buckets, 24 h | per session, beyond 24 h | per response, kept 90 d (proposal) |
| Input (uncached) | parsed past | all | `input_tokens` normalised (§6) |
| Cache read | parsed past | all | `cache_read_input_tokens` / `cached_input_tokens` |
| Cache write | parsed past | all | `cache_creation_input_tokens` (+ 5m/1h split) / `cache_write_input_tokens` |
| Provider | implied by log root | not stored | `claude` / `codex` |
| Session | none | all | provider session id (file name / rollout id) |
| Dedupe key | message id held only while parsing | not stored | provider + session + message/response id |
| Timestamp | start/end, bucketed | exact per response | response end (and start, for speed) |
| Model | yes | — | model id as logged |
| Attribution | none | session → dispatch → task → workstream | join at read time (§4) |

**Routing inputs already exist.** `routes.jsonl` already records, per dispatch, the requested kind, risk, context, task type, attempt, the chosen agent/model/effort and the decision source (kind, type, fallback, role, override, default) with its reason ("normal task, high risk → Claude Opus · high"); `src/routing.ts` derives the row from those fields. "By task kind" needs no new routing data, only the join from dispatch to usage (§4).

**The existing rolling data cannot be upgraded.** It is per model, output only, and 24 h deep. It cannot reconstruct historical per-run input, cache use or cost. A backfill is possible only by re-reading provider logs that are still on disk; where logs were rotated or deleted, that period stays "not recorded".

Proposed store: one append-only file of normalised observations (`~/.orca-flow/usage/YYYY-MM.jsonl`), written by the same incremental reader that feeds the speed chart, so logs are still read once. Content stays unread, as today.

## 4. Attribution model

Every usage observation is counted exactly once, along one chain:

```
provider session ─▶ Orca session / pane ─▶ dispatch ─▶ task ─▶ workstream (run / worktree)
```

What each source can and cannot give (checked on this machine):

- **Provider logs.** Give the provider session id and every response with its usage. Give nothing about Orca.
- **`src/transcripts.ts`.** Maps a pane to its provider session: the hook entry per pane in `agent-hooks/last-status.db` (`transcripts.ts:20-27`, `:34-47`), checked against `agent-identities.db` `provider_links` (orca_session_id ↔ provider_session_id, `:76-91`), or the structured chat journal in `agent-session-domain.db` (`:102-115`). **Limit:** it holds the current binding of a pane, not its history. A pane reused for another session overwrites it, so Analytics must snapshot the binding while the dispatch is live (at dispatch, and on each sample).
- **Orchestration dispatch records** (`orca orchestration worker-show --dispatch <id> --json`). Give `task_id`, `run_id`, `assignee_handle`, `assignee_pane_key`, `creator_dispatch_id` (the parent), `retry_of_dispatch_id`, `depth`, `dispatched_at`, `completed_at`. This is the join from pane to task. **Limit:** `assignee_orca_session_id` was null on the dispatch checked, so pane key → transcripts binding is the working path. The outcome (`worker_done --outcome`) is in the message, not on the dispatch.
- **`~/.orca-flow/routes.jsonl`** (written by `skills/orca-flow/scripts/dispatch.mjs:222-240`; coordinators by `src/coordinator-launch.ts:52-57`). One line per start: `at, role (lead|worker|coordinator), taskId, dispatchId, workspace "<repoId>::<worktree>", choice {agent, model, effort}, kind, risk, context, attempt`. Gives the routed model, the policy inputs and the attempt number. **Limits:** it stores no `retry-of` field (`--retry-of` is read from it to rebuild a request, `dispatch.mjs:334-342`); it has no pane or session; "choice.model" is the requested alias (`opus`), not the model the log reports. On this machine it starts 2026-11-23 09:26 (18 lines), so it is not a long history.
- **`src/handover.ts`.** The handover record (`.orca-flow-handover.json`, `handover.ts:8-25`) names the source, the new launch's terminal handle and session id, and the runs moved. Gives the predecessor → successor link for a coordinator.

**Definitions**

- **Session**: one provider session (Claude session file / Codex rollout). The unit usage is recorded in.
- **Workstream**: one Orca run (`run_id`) in one worktree; its lead dispatch and every dispatch below it. The row Q1 ranks.
- **Parent dispatch**: `creator_dispatch_id`. A worker's usage rolls up into the lead's workstream total. In the breakdown the lead row shows only the lead's own sessions; worker rows are separate lines. Never added twice.
- **Retries**: a dispatch with `retry_of_dispatch_id` (or a higher `attempt` for the same task) is a separate attempt. Listed under the same task, marked "retry n", included in the workstream and task totals.
- **Handovers**: usage stays with the session that spent it. The successor is linked ("continued in …"), nothing is moved or re-attributed.
- **Duplicates**: dedupe key = provider + session id + message/response id. Claude writes one line per content block with the usage so far: take the last line for an id (as `token-speed.ts:112-115` already does for output). A resumed session that replays earlier lines hits the same keys and is dropped. Codex: count `token_usage_record` (or `last_token_usage`), never `total_token_usage`, which is cumulative.
- **Unattributed**: usage from a session with no Orca binding (a plain terminal, a session older than any dispatch). A visible bucket in every total.
- **Unknown**: usage that is attributed but missing a field (model, or a category the provider did not report). A visible bucket. Neither bucket is folded into another row or hidden.

## 5. Window activity vs whole-run totals

- **Window activity**: usage whose timestamp falls inside the window. A run that spans the window edge contributes only its in-window part (clipped). Used for the window totals.
- **Whole-run total**: everything the workstream ever spent, regardless of window. Used in the workstream breakdown and comparisons.
- The UI labels both every time: "In window" vs "Whole run".
- **The window does two jobs, stated in the window toggle's tooltip:** (a) activity, clipped: the "recorded in window" total; (b) selection: which completed runs are listed, by finish date (the run's last recorded activity), each with its whole-run total. A ranking by in-window tokens is not offered: a window slice mixes running work, half-finished runs and partial coverage, so its order answers no decision.
- A run that spans the window edge (e.g. a 9-day run finishing yesterday) appears in the 7-day list at its whole-run total; only its in-window part counts toward the activity total.
- **Partial coverage**: a run that started before instrumentation, or whose logs were rotated, shows "Partial · 62 % covered" (covered = share of the run's active time for which logs were read). Its numbers are a floor, never extrapolated.

## 6. Token categories and normalisation

Four categories, shown separately and as a total: **input (uncached)**, **cache read**, **cache write**, **output**. Total = the sum of the four.

| Provider | Raw fields (seen in local logs) | Normalised |
|---|---|---|
| Anthropic (Claude Code) | `input_tokens` excludes cache; `cache_read_input_tokens`; `cache_creation_input_tokens` with `cache_creation.ephemeral_5m/1h_input_tokens`; `output_tokens` (thinking inside, `output_tokens_details.thinking_tokens`) | input = `input_tokens`; read = `cache_read_input_tokens`; write = `cache_creation_input_tokens` (keep the 5m/1h split for pricing); output = `output_tokens` |
| OpenAI (Codex) | `input_tokens` **includes** `cached_input_tokens`; `cache_write_input_tokens`; `output_tokens` includes `reasoning_output_tokens`; `total_tokens = input + output` | read = `cached_input_tokens`; write = `cache_write_input_tokens`; input = `input_tokens − cached − write`; output = `output_tokens` |

Rule: no raw field is added if another already contains it. Thinking/reasoning tokens are a detail of output, never added to it. Whether Codex's `cache_write_input_tokens` is a subset of `input_tokens` is an assumption to confirm (it was 0 in every rollout checked).

**Output rate (tok/s) is a speed, not a total.** It stays in the sidebar throughput glance and is never summed into usage.

## 7. Estimated cost

- Shown only for models in a price table. The table is versioned and dated in the app (e.g. "prices v1, 2026-11-03"). A model not in it shows "no estimate", and totals say "estimate excludes 1.2M tokens with no price".
- Always labelled **"Estimated at API list prices"**. Claude Max and ChatGPT plans are flat subscriptions; the estimate is not what the user pays and is never called a charge or a bill.
- cost = input × in + cache read × read + cache write (5m) × 1.25 in + cache write (1h) × 2 in + output × out.

Anthropic list prices per MTok (from the claude-api reference, cached 2026-11-03; confirm before shipping):

| Model | Input | Cache read | Cache write 5m / 1h | Output |
|---|---|---|---|---|
| `claude-opus-5-5` | $4.00 | $0.20 | $5.00 / $8.00 | $20.00 |
| `claude-sonnet-5-5` | $2.00 | $0.10 | $2.50 / $4.00 | $10.00 |
| `claude-haiku-5-5` | $0.10 (≤100K prompt) | assumed $0.01 | $0.125 / $0.20 | $0.50 |
| `claude-fable-5-2` | $8.00 | $0.20 | $10.00 / $16.00 | $40.00 |

OpenAI prices for `gpt-6.2-astra` and `gpt-6-astra` (the Codex models in the local logs) are **assumptions to confirm**; the prototype uses an assumed rate for one and "no estimate" for the other.

## 8. Comparisons (delegation policy)

- **What is compared**: two arms on the same starting task and the same acceptance checks, with model choices held fixed; only the splitting/delegation policy differs (e.g. "lead does it alone" vs "lead + 3 workers").
- **Per arm**: total tokens (four categories) and estimated cost, including every worker and retry; elapsed wall time (first dispatch → last worker_done); acceptance passed / failed; sample count n.
- **Denominator**: per completed accepted run. Tokens (or cost) per accepted run = all tokens of the arm, failed runs and retries included, ÷ accepted runs; wall time is the median of accepted runs. Failed runs are counted and shown ("1 of 3 failed acceptance"), and their tokens are listed, never dropped.
- **Delta** = variant − baseline. Negative means cheaper or faster. Colour shows good or bad, not the sign; an icon and the word ("cheaper", "slower") carry it too.
- **Honest gaps**: "not comparable: model changed" when model choices differ; "n too small" below n = 3 per arm; "missing data: arm partially recorded" when coverage < 100 %.
- Ordinary trends over time are descriptive only and never presented as savings.
- **Running experiments is out of scope.** Analytics reads runs the user labels as a pair and arm.

## 9. Open questions and non-goals

Decisions for the user:

1. Retention for normalised observations: 90 days (proposal), or forever (small files)?
2. Backfill from provider logs still on disk at first launch: yes / no? It reads up to ~1 GB per day of Claude logs once.
3. How are arms labelled: a flag on `orca-flow dispatch` (`--arm baseline|variant --pair <id>`), or in the Usage view after the fact?
4. Show OpenAI cost at all before prices are confirmed, or "no estimate" for every Codex model?
5. Does the sidebar usage line show tokens or estimated cost? (Proposal: tokens; cost only in the Usage view.)

Non-goals: billing or plan usage limits; actual charges; running A/B experiments; per-prompt or content analysis; team or cross-machine aggregation; changes to how agents are routed.
