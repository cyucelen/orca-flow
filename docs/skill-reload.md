# Reload skills

Skill files change on disk all the time: a plugin update repoints `<Claude profile>/skills/orca-flow`,
`~/.agents/skills/orca-flow` and the Gemini link at the new release (src/install.ts), and
`orca skills update` refreshes Orca's bundled skills (orchestration, orca-cli). A running agent does
not notice. It read `SKILL.md` and its role file earlier, and that text stays in its conversation.
Refreshing the files does not fix that. The agent has to read them again in the same conversation.

**Reload skills** in the sidebar asks it to. Delivery uses our Claude Code hooks: nothing is typed
into a terminal, and no Orca mail is sent.

## What each provider supports (verified 2026-11-23)

### Claude Code 2.1.330

| Mechanism | What it does | Usable here? |
| --- | --- | --- |
| Skill hot-reload (`~/.claude/skills`, `.claude/skills`) | Changed skills show up in the skill listing and the slash menu without a restart. | Re-announces the **listing** (names and descriptions) only. It never re-sends the body of a skill the agent already read. |
| `/reload-skills` | Re-scans the skill folders and re-sends new or changed skills in the listing. After compaction it re-sends the whole listing (changelog 2.1.x: "`/reload-skills` now sends only new or changed skills"; "re-sends the full skill list to Claude"). | Same limit as hot-reload: listing only. It is also a slash command, so it has to be typed into the agent's input. That is not allowed here. |
| `/reload-plugins` | Activates pending plugin changes, including plugin-provided skills. | Same limit: listing only, and typed. |
| `UserPromptSubmit` hook, `hookSpecificOutput.additionalContext` | Adds context the model sees at the start of the next turn. The user does not see it. | **Yes.** Our `prompt-check.mjs` is already installed. |
| `SessionStart` hook (sources `resume`, `compact`), `additionalContext` | Adds context when a session resumes or compacts. | **Yes.** Our `session-start.mjs` is already installed. |
| `PostToolUse` hook, `additionalContext` | Adds context after a tool call, inside a running turn. | **Yes.** A new entry (`reload-check.mjs`). It reaches a busy worker in a long turn, at most once per request. |

`claude --help` has no reload flag. Nothing in Claude Code re-injects the body of an already-invoked
skill. The agent therefore has to re-read the files itself, and a hook note is the supported way to
tell it to.

### Codex CLI 0.171.0 (exercised live)

- **Hooks work, and our note works through them.** `codex features list` shows `hooks stable true`.
  Hooks can be given per invocation, without touching `CODEX_HOME`:
  `-c 'hooks.<Event>=[{hooks=[{type="command",command='…',timeout=10}]}]'` plus
  `--dangerously-bypass-hook-trust` ("Run enabled hooks without requiring persisted hook trust for
  this invocation").
  - A probe hook got `SessionStart`, `UserPromptSubmit` and `PostToolUse` with the same input shape as
    Claude Code (`session_id`, `cwd`, `transcript_path`; for PostToolUse `tool_name: "Bash"`,
    `tool_input.command`). It inherited `ORCA_AGENT_PANE`.
  - A `UserPromptSubmit` `additionalContext` was obeyed (`The command printed hello, KIWI.`).
  - With our installer's own hook commands, a Codex TUI session in an Orca pane reloaded a disposable
    skill in the same conversation, at its next prompt and mid-turn (transcripts below). Codex
    receives the note as a `developer` message.
- **The sandbox blocks the confirmation write.** Codex's default `workspace-write` sandbox refuses
  writes to `~/.orca-flow`: `orca-flow: EPERM: operation not permitted, mkdir
  '…/skill-reload/confirmed'`. The agent had reloaded (its reply ended in the new word), but nothing
  was recorded. Hooks run outside the sandbox: the delivery marker was written fine. So the
  PostToolUse hook now records the confirmation itself when it sees the agent run
  `orca-flow skills-reloaded` for its delivered request. The CLI says so instead of failing, and
  takes `ORCA_PANE_KEY` and `CODEX_THREAD_ID`, which Orca and Codex give Codex shells.
- **Orca-launched Codex sessions do not carry our hooks.** Orca starts Codex with
  `CODEX_HOME=<account home>`. That home's `hooks.json` is Orca's (`orca-agent-hook-form=2` entries
  for every event). Its `config.toml` `[hooks.state]` pre-trusts exactly those hashes, with
  provenance in `.orca-hook-trust-provenance.json`. Ours could only get there by editing that
  Orca-managed file and Codex's trust state in each account. Project-level hooks
  (`<repo>/.codex/config.toml`) need a persisted folder-trust decision: Codex shows "Trust this
  folder? … Your trust decision will be saved." even with a `-c projects.<dir>.trust_level` override.
  That writes the account config too.
- No skill reload command exists. `skill_catalog_deltas` is "under development" and off.
  `codex queue` would put a visible user turn in front of the agent, so it is not used.

**Used:** the delivery and confirmation code is provider-neutral and verified on Codex. The sidebar
still marks Codex sessions *unsupported: restart to reload*, and the confirmation says why ("Orca
starts Codex without Orca Flow's hooks"): no Orca-launched Codex session can receive the note today.
Making it supported needs a decision. Either Orca Flow writes its hooks into each Codex account's
Orca-managed hook config, and the user trusts them in Codex, or Orca offers an extension point for
plugin hooks. Not tested: whether a Codex session picks up a hook added to its config mid-session.
Antigravity and unknown agents are reported as unsupported too.

### Orca 1.4.265: why not mail or typed prompts

- `orca terminal send --help` says: "To message another agent, use orca orchestration send; never
  type into its input." With `--enter`, a prompt to a running agent is bracketed-pasted and
  submitted. A draft the user left in the input box is submitted along with it. If the agent is
  busy, Claude Code queues the prompt as a user message. `--wait-submit` only watches; it never
  resends.
- `orca orchestration send --to dispatch:<id>` needs a Run context. It wakes the agent with a "you
  have messages" turn, which the agent must answer by mail. Mail to a closed worker reopens it, which
  costs memory. A reload must never do that.
- Both paths would put a visible prompt in front of an agent that may hold an open ask, so it could
  answer the wrong thing. The hook note is invisible to the user and lands at a turn boundary or
  after a tool call. It tells the agent to leave asks, decisions and run ownership alone.

These Orca behaviours are taken from Orca's own CLI help and the brief. They were not exercised
live, because the chosen design uses neither path.

## How it works

1. **Scope** (`src/skill-reload.ts` `reloadPlan`): for a coordinator, its current live session and
   every agent that works for it. For **all**, every coordinator's team and the chats you started.
   A session is a target only when it is live (`live === true`) and its dispatch has not settled.
   Finished and asleep or closed sessions are skipped and counted. They are never woken. Only Claude
   Code targets get the note. Every other provider is listed as unsupported.
2. **Confirmation** (panel): "Reload skills in 6 agents across all coordinators and your chats?
   2 coordinators, 2 leads, 1 worker, 1 chat re-read their skill files … 1 Codex session has no live
   reload: restart to reload. Skipped: 1 finished." It is asked every time and is never remembered.
3. **Request** (`sidebar.reloadSkills` → `requestReload` in src/worker.ts): the worker re-checks the
   targets against its latest snapshot. It adds each session id (the summary's, else the transcript
   file name) and the hash of the skill files as agents read them (through the Claude profile's
   link). It writes `~/.orca-flow/skill-reload/requests.json`: one entry per pane, which replaces any
   older one, and expires after 24 h. It also creates `skill-reload/active` while any note is
   undelivered.
4. **Delivery** (`skills/orca-flow/scripts/skill-reload.mjs` `deliverReload`), in whichever comes
   first:
   - `UserPromptSubmit` (`prompt-check.mjs`): the next prompt. No messageFormat opt-in is needed. A
     format reminder, if one is waiting, arrives in the same output.
   - `PostToolUse` (`reload-check.mjs`): after the next tool call of a busy agent. Its settings entry is
     `if [ -n "${ORCA_AGENT_PANE-}" ] && [ -e "${ORCA_FLOW_DIR:-$HOME/.orca-flow}/skill-reload/active" ]; then node …; fi`,
     so other tool calls start no node.
   - `SessionStart` on `resume` or `compact` (`session-start.mjs`).

   A session matches by its Orca pane (`ORCA_AGENT_PANE`), else by its Claude session id (for one
   resumed in another pane). The note is given once per request and pane: the first hook creates
   `delivered/<pane>.<request>` exclusively, so two parallel tool calls cannot both give it. A
   subagent's tool call (`agent_id` in the hook input) never takes it.
5. **The note** is role-aware. The role is the sidebar's (summarize.ts `roleOf`: it knows a
   dispatched worker in a coordinator folder is a worker), except that hookRole's lead wins (a
   `orca-flow role lead` record). The note asks the agent to:
   - re-read `SKILL.md` and `roles/<role>.md` (a chat you started: `SKILL.md` only, if it loaded the
     skill), plus the `SKILL.md` of any other skill it loaded in this conversation;
   - run `orca-flow skills-reloaded --request <id>`;
   - carry on.

   It also says to keep the current task, open asks, pending decisions and run ownership unchanged,
   and to send no messages, start no Runs or workers and send no `worker_done` because of it.
6. **Confirmation** (`orca-flow skills-reloaded`): records `{pane, session, hash, request, at}` in
   `skill-reload/confirmed/<pane>.json`, with the hash of the files as they are now. If the skill
   changed again after the request, it says so and asks the agent to read once more. When the
   agent's shell is sandboxed and cannot write there (Codex), the PostToolUse hook records the same
   entry (`by: "hook"`) when it sees that command run for the delivered request. Hooks run outside
   the sandbox. To allow this, the `active` gate stays open for 30 minutes after a note until it is
   confirmed.
7. **Status** (`reloadStatus`, shown in the snapshot's `skillReload`). Each pane is in one state:

   | State | Meaning |
   | --- | --- |
   | `waiting` | Requested; its next turn has not come. |
   | `reading` | The note was given; no matching confirmation yet. |
   | `reloaded` | A confirmation with the requested hash, made after the request. |
   | `unsupported` | No live reload for this provider. |

   Requested never counts as reloaded. Rows wear a small mark. The Coordinators heading shows one
   line, for example "Skills: 2 reloaded · 1 reading · 2 waiting for next turn · 1 unsupported".
   Reloaded and unsupported marks fade after 10 min, and everything disappears when the request
   expires.

The hash covers every `.md` file under the skill folder (scripts are run, not read), so a change to
any file an agent reads makes a new request distinguishable from an old confirmation.

## Live checks

### Claude Code, idle and busy, in a real Orca pane

Setup (helper scripts in the session scratchpad, not committed):
- I created an Orca terminal myself (`orca terminal create`), so Orca set `ORCA_AGENT_PANE`.
- An interactive `claude` ran in it with `--setting-sources project`, so none of the user's settings,
  hooks or plugins loaded.
- `--settings <scratch>/claude/settings.json`, written by this branch's installer
  (`ensureOwnStopHook`, all five hooks, through a scratch skill link).
- `ORCA_FLOW_DIR` in the scratch dir.
- A disposable skill as "orca-flow".
- The request was made by this branch's sidebar code: `reloadPlan`, `confirmText`, then the worker's
  `requestReload` on a fixture tree holding that real pane. Status came from `reloadStatus`, with the
  sidebar's `reloadSummary` and `reloadMark`.
- An isolated `CLAUDE_CONFIG_DIR` was not usable: it answers "Not logged in · Please run /login", and
  copying credentials is off limits. So the run used the normal login with no user settings loaded.

```
❯ Read …/skill/orca-flow/SKILL.md … follow its instruction in every reply …
⏺ I've read the skill, and I'll end every reply with its required word. PINEAPPLE
[11:03:59] SKILL.md on disk now says: End every reply with the word BANANA.
❯ What is 2+2? One short sentence.
⏺ 2+2 equals 4. PINEAPPLE                                   ← stale: the problem
== idle session: sidebar request while it waits at its prompt
[11:04:03] confirmation: Reload skills in 1 agent for Live test? 1 worker re-read their skill files …
[11:04:03] requestReload: {"asked":1,"unsupported":0,"skipped":{"finished":0,"asleep":0},"hash":"a631bc93cc3440db"}
[11:04:03] status: [["rmwt5rgk6","waiting"]] | sidebar: "Skills: 1 waiting for next turn" | row mark: waiting
❯ What is 3+3? One short sentence.
  Read 3 files, ran 1 shell command
⏺ 3+3 equals 6. BANANA
[11:04:18] status: [["rmwt5rgk6","reloaded"]] | sidebar: "Skills: 1 reloaded" | row mark: reloaded
[11:04:26] SKILL.md on disk now says: End every reply with the word MANGO.
❯ Run this shell command with Bash: `sleep 15; echo finished` …
  ⎿  $ sleep 15; echo finished (5s)                          ← busy, mid-turn
[11:04:34] requestReload: {"asked":1,…,"hash":"45230a0784e8ce91"}   status: waiting
  Read 3 files, ran 2 shell commands
⏺ The command printed "finished". MANGO                      ← same turn
[11:04:52] status: [["rmwt5s4i7","reloaded"]] | sidebar: "Skills: 1 reloaded" | row mark: reloaded
```

The transcript shows `hook_additional_context` from `UserPromptSubmit` (request rmwt5rgk6, ending
"Then answer the user's message as you would have."). It also shows one from `PostToolUse` after
the `sleep` Bash call (request rmwt5s4i7, ending "Then continue the task you were doing"). Each is
followed by Reads of `SKILL.md` and `roles/worker.md`, and `orca-flow.mjs skills-reloaded --request …`
→ `Recorded: skills reloaded (orca-flow <hash>).`

The busy path was run once more with the final code (hook-recorded confirmation, gate window):
GRAPE, status `reloaded`, gate closed afterwards.

### Codex 0.171, in a real Orca pane

Setup: Codex TUI in an Orca terminal I created, with `CODEX_HOME` set to the selected Orca account's
home for its login. Our installer's three hook commands were given with `-c hooks.…` and
`--dangerously-bypass-hook-trust`. A `-c projects."<scratch>".trust_level="trusted"` override
avoided the trust dialog. The same disposable skill was used.

```
== sidebar request with this branch's code (agentType codex)
[11:08:12] confirmation: Nothing to reload for Live test No running Claude Code session here can take
           a reload. 1 Codex session has no live reload: restart to reload.
[11:08:12] requestReload: {"asked":0,"unsupported":1,"skipped":{"finished":0,"asleep":0}}
› What is 2+2? One short sentence.
• 2 + 2 equals 4, PINEAPPLE.                                  ← unsupported: nothing sent, stale
== the same request marked supported (writeRequest), delivered by our hooks inside Codex
› What is 3+3? One short sentence.
• Explored └ Read worker.md, SKILL.md
• Ran node …/orca-flow.mjs skills-reloaded --request rcodex1
  └ Recorded: skills reloaded (orca-flow a631bc93cc3440db).
• 3 + 3 equals 6, BANANA.
[11:08:43] status: [["rcodex1","reloaded"]] | sidebar: "Skills: 1 reloaded"
› Run this shell command: sleep 15; echo finished. …        (request written at 8 s, mid-turn)
• Ran sleep 15; echo finished └ finished
• Explored └ Read SKILL.md, worker.md
• Ran node …/orca-flow.mjs skills-reloaded --request rcodex2 └ Recorded: …
• The command printed finished, MANGO.
== ORCA_FLOW_DIR under $HOME (like ~/.orca-flow), new session
• Explored └ Read SKILL.md, worker.md
  (exec) node …/orca-flow.mjs skills-reloaded --request rcodex3
  → exit 1: orca-flow: EPERM: operation not permitted, mkdir '…/.orca-flow-reload-livetest/skill-reload/confirmed'
• 5 + 5 equals 10, KIWI.                                     ← reloaded, but not recorded
```

The last run led to the hook-recorded confirmation. Its end-to-end coverage is in
`test/skill-reload.test.mjs`: a read-only `confirmed/` dir, the CLI with `ORCA_PANE_KEY` and
`CODEX_THREAD_ID`, then the PostToolUse hook process. It was not re-run on Codex (see the next
section).

### What the Codex runs wrote into the account's `CODEX_HOME`

Hook config and trust were passed per invocation, and no trust dialog was accepted. A probe with
`codex exec --ephemeral` left `config.toml`, `hooks.json`, `auth.json` and the trust-provenance file
byte-identical. The interactive TUI sessions still wrote into the account home:
- 6 prompts in `history.jsonl` and 2 entries in `session_index.jsonl` (threads
  `01a20817-0295-…` and `01a20819-37eb-…`);
- rollout files through the `sessions` symlink into `~/.codex/sessions`;
- `config.toml` rewritten at 12:07:34, the second the first TUI session started. Afterwards it holds
  no trace of the test (no scratch paths, no new trust entries). Its only TUI-owned keys are
  `[tui] screen_reader_detection_done` and `[tui.model_availability_nux]`. The exact changed line
  cannot be shown without the earlier content.

Codex also touches `tmp/arg0-macos` and `models_cache.json` on any launch. So no further Codex run
used the account home. An isolated `CODEX_HOME` would need a copy of the login, which needs the
user's approval.

## Tests

- `test/skill-reload.test.mjs`:
  - the request store (per pane, replace, expiry, broken file);
  - delivery only to targeted sessions, once per request across hooks, not to subagents or
    unsupported targets, and by session id after a pane change;
  - the role-aware text and the role rule;
  - each hook end to end (no opt-in needed, PostToolUse once, SessionStart only on resume and
    compact), and the reminder and note combined;
  - `orca-flow skills-reloaded`: confirmed only on a matching hash made after the request, and
    refused outside Orca and Claude Code;
  - the PostToolUse hook recording a confirmation: which commands count, only after delivery, the
    same request, pane or session, not a subagent, once. End to end, with a CLI that cannot write
    the data folder (as under Codex's sandbox), using `ORCA_PANE_KEY` and `CODEX_THREAD_ID`;
  - the gate staying open while a note is unconfirmed, then closing after the window.
- `src/skill-reload.test.ts`:
  - scope (a coordinator, a sleeping coordinator, all, dedupe);
  - skipped and unsupported counts;
  - the confirmation text, including the Codex reason;
  - the summary (requested never counted as reloaded);
  - fading and expiry;
  - row marks and heading rendering;
  - the worker's `requestReload`.
- `src/install.test.ts`: the PostToolUse entry (gated command, no matcher, idempotent, repointed in
  place, other settings kept).

## Limits

- The agent has to follow the note. A model can ignore it; the sidebar then shows it as `reading`
  until the request expires, never as reloaded.
- An idle agent with no next turn (a lead waiting for you, an idle coordinator) stays `waiting` until
  you next talk to it. That is by design: nothing wakes it.
- Sessions already running when this version installs: the UserPromptSubmit and SessionStart
  entries already exist and run the script through the skill link, so they use the new code at once.
  The PostToolUse entry is new. Whether a session that started before it was added picks it up
  mid-session was not live-tested. If it does not, that session gets the note at its next prompt
  instead.
- An agent that never confirms keeps the PostToolUse gate open for at most 30 minutes after its note,
  so every Orca Claude Code session starts `node` on its tool calls during that time.
