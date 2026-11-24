# Reload skills

Skill files change on disk all the time: a plugin update repoints `<Claude profile>/skills/orca-flow`,
`~/.agents/skills/orca-flow` and the Gemini link at the new release (src/install.ts), and
`orca skills update` refreshes Orca's bundled skills (orchestration, orca-cli). A running agent does
not notice. It read `SKILL.md` and its role file earlier, and that text stays in its conversation.
Refreshing the files does not fix that. The agent has to read them again in the same conversation.

**Reload skills** in the sidebar asks it to. Delivery uses our hooks in Claude Code, Codex and
Antigravity: nothing is typed into a terminal, and no Orca mail is sent. Claude Code and Codex are
live-tested. Antigravity is **fixture-tested only**, because `agy` was not installed where it was
built.

## Codex: approve Orca Flow's hooks once

Codex runs a hook only after you trust it. The installed Orca Flow adds three hooks named **Orca
Flow: Reload skills** to `~/.codex/hooks.json`, the system Codex home. It creates the file if it is
missing and keeps everything else in it. Each time Orca starts a Codex agent, it rebuilds that
account's `hooks.json` from its own hooks plus `~/.codex/hooks.json`. That is how ours reach every
Orca-managed Codex account. Until you approve them, the sidebar counts Codex sessions as unsupported
and says why.

1. After Orca Flow has updated, start a Codex agent in Orca (any workspace).
2. Codex opens with **Hooks need review** · "3 hooks are new or changed" · "Hooks can run outside
   the sandbox after you trust them".
3. Choose **2. Trust all and continue**. To see them first, choose **1. Review hooks**: each event
   lists *Orca Flow: Reload skills* with its command (`node ~/.agents/skills/orca-flow/scripts/…`).
   `t` trusts all, `esc` closes. Option 3 or `esc` skips them, and they won't run.
4. In a session that is already open, `/hooks` opens the same list. It only lists hooks that were
   there when the session started.
5. Restart Codex sessions that were already running. Codex loads hooks when a session starts, and
   Orca adds ours to an account only when it starts Codex. A session started earlier never gets the
   note.

You do this once. Codex records your choice in that account's `config.toml`. The next time Orca starts
Codex, it copies that approval into `~/.codex/config.toml` and from then on carries it into every
Orca-managed account. Orca Flow never writes trust state. The sidebar reads it (read-only) and calls
Codex ready when all three hooks are trusted with the hash of their current command.

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

- **Hooks.** `codex features list` shows `hooks stable true`. Codex reads the `hooks.json` of its
  `CODEX_HOME`, which for Orca's sessions is an Orca-managed account home
  (`<Orca data>/codex-accounts/<id>/home`, marked `.orca-managed-home`). Codex also has hook sources
  in `config.toml`, `-c` flags, trusted projects' `.codex/hooks.json` and plugins. The `plugin_hooks`
  feature is off in 0.171.
  - **Orca rebuilds that file every time it starts a Codex agent.** In Orca 1.4.265 this is the
    hookPass worker's install (`T()` in `out/main/codex-project-trust-worker-entry.js`). It writes
    Orca's own status hook (`: orca-agent-hook-form=2; …`) first in each of its 9 events. Next come
    the groups of `~/.codex/hooks.json`, minus Orca's own and any command containing
    `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` or a `…_DATA` variant. It drops everything else, and its
    trust entries with it (`On()` in `hook-trust-promotion`). The old file is left as `hooks.json.bak`.
    Verified live: hooks added only to the account's file were gone after the next `orca agent launch`,
    and so were their trust entries, even after Trust all and continue.
  - The input matches Claude Code's (`session_id`, `cwd`, `transcript_path`; for PostToolUse
    `tool_name: "Bash"`, `tool_input.command`). The output (`hookSpecificOutput.additionalContext`)
    reaches the model as a `developer` message.
  - Codex panes get `ORCA_PANE_KEY`, and our scripts accept it as the pane. Orca starts Codex with
    `--dangerously-bypass-approvals-and-sandbox`, so its sessions have no sandbox.
- **Trust.** A hook runs only once trusted. `config.toml` holds one table per hook:
  `[hooks.state."<realpath>/hooks.json:<event>:<group>:<handler>"]` with
  `trusted_hash = "sha256:…"` and `enabled`.
  - The hash is sha256 of the key-sorted JSON of
    `{event_name, hooks:[{type, command, timeout, async, statusMessage?}], matcher?}`. The matcher is
    included for tool events only.
  - Our implementation reproduces Codex's hash for all nine Orca-trusted entries of a real account.
    It also reproduces the three that Codex wrote for ours after "Trust all and continue".
  - Orca pre-trusts its own hooks. It pre-trusts nothing else. For a hook it merged from
    `~/.codex/hooks.json`, it carries the user's trust from `~/.codex/config.toml`, matched by exact
    key or by hash within the event (`p`/`m` in the same worker). When the user approves a merged hook
    inside an account, the next Codex start copies that approval into `~/.codex/config.toml` first
    (`or()` in `hook-trust-promotion`). Ours sit after Orca's group: index 1 in UserPromptSubmit and
    SessionStart, and in PostToolUse after any group of the user's own.
- **Sandbox.** Codex's default `workspace-write` sandbox refuses writes to `~/.orca-flow` (`EPERM`).
  Hooks run outside it, so the PostToolUse hook records the confirmation when it sees
  `orca-flow skills-reloaded` run.
- **Hooks load at session start.** A session started before our hooks were in `hooks.json` did not
  pick them up later, even with the trust already in place (live check below).
- No skill reload command exists. `codex queue` would put a visible user turn in front of the agent.

**Used:** the same three scripts as for Claude Code, through `~/.agents/skills/orca-flow` (the Codex
user skill link), so the commands stay the same across plugin updates and keep the user's trust.
`src/codex-hooks.ts` installs them into `~/.codex/hooks.json`, installed copy only, when `~/.codex`
exists. It creates the file when it is missing, is idempotent and updates in place. It keeps every
other entry and key. It never writes an Orca-managed account home (Orca rebuilds those), and never
touches `config.toml`, `auth.json` or any trust state. Plain `codex` runs outside Orca load the hooks
too, and they do nothing there: each one checks for an Orca pane first.

The worker checks the selected Codex account (`orca account list`, every 5 minutes) and reads what
Codex will use. A Codex session counts only when that account is ready. Otherwise it is unsupported,
with the reason and one action:

| State | When | Reason in the sidebar |
| --- | --- | --- |
| not installed | ours are not in `~/.codex/hooks.json` | Orca Flow has not added its hooks to ~/.codex/hooks.json yet; update Orca Flow |
| not merged | in `~/.codex/hooks.json`, but not (or an older version) in the account's `hooks.json` | Orca adds Orca Flow's hooks when it next starts Codex; start a Codex agent in Orca (choose Trust all and continue if asked), then restart older Codex sessions |
| needs approval | merged, not trusted by the account's `config.toml` at the merged position, nor by `~/.codex/config.toml` for `~/.codex/hooks.json` | approve Orca Flow's hooks once; start a Codex agent in Orca and choose Trust all and continue (or /hooks), then restart older Codex sessions |
| disabled | trusted, but turned off | Orca Flow's hooks are turned off; turn them on in Codex with /hooks |
| unreadable | `~/.codex/hooks.json` or the account's file is not valid JSON | a hooks.json Orca Flow reads (~/.codex or this Codex account) is not valid JSON; fix it, then start a Codex agent in Orca |
| unmanaged | the selected login is neither `~/.codex` nor Orca-managed | the selected Codex login is neither ~/.codex nor an Orca-managed account, so Orca Flow's hooks do not reach it; restart to reload |

With the `system` login selected, Codex reads `~/.codex` directly, and so does the check. A Codex row
that is waiting says in its tooltip: "a Codex session started before Orca added and you approved
the hooks needs a restart".

### Antigravity CLI (`agy`): documented hooks, fixture-tested only

`agy` is not installed on the verification machine. Everything below comes from Google's docs and
from Orca 1.4.265's own Antigravity integration. It is covered by fixtures and has **not** been
tested live.

- **Hooks exist** ([Hooks](https://antigravity.google/docs/hooks/)). Global hooks live in
  `~/.gemini/config/hooks.json`, workspace hooks in `.agents/hooks.json`. "Hooks in
  `~/.gemini/antigravity-cli/settings.json` aren't loaded."
  - The file is an object of named hook definitions. Each definition maps events to handlers, and
    may set `enabled` (default `true`).
  - Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.
    `SessionStart`, `PreInvocation`, `PostInvocation` and `Stop` take a list of handlers.
    `PreToolUse` and `PostToolUse` take `[{matcher, hooks}]`.
  - A handler is `{type: "command", command, timeout}`; the timeout defaults to 30 s.
  - Input and output are camelCase JSON on stdin and stdout. Every hook gets `conversationId`,
    `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` and `lastUserInput`.
- **Injection at the next prompt and after a tool call.** `PreInvocation` "fires before the model is
  called", with `invocationNum` (0 for the first call of a turn), and can answer
  `{"injectSteps": [{"ephemeralMessage": "…"}]}`. Because it fires before every model call, a busy
  agent gets the note at its next model call after a tool result. `PostToolUse` "returns an empty
  JSON object `{}`" (it cannot inject) and receives `toolCall` (`name`, `args`).
- **Orca already uses this file.** Orca writes its own definition `orca-status` there: PreInvocation,
  PostInvocation and Stop handlers, and PreToolUse and PostToolUse with matcher `*`. Each command is
  `/bin/sh -c '…'` with `{}` as the fallback output. Orca's writer replaces only that key and keeps
  the rest (Orca bundle, `managed-agent-hook-controls`). Orca's hook script reads `ORCA_PANE_KEY`, so
  agy hooks inherit the pane's env.
- **Trust: not documented.** The hooks, permissions and sandbox pages describe no trust or approval
  step for hooks. `/hooks` "adds, edits, and turns hooks on or off". Workspace trust
  (`trustedWorkspaces`) is about folders.
- **Sandbox.** The terminal sandbox is optional (`enableTerminalSandbox`, `--sandbox`, on with
  `agentMode: "auto"`). Sandboxed commands "can write to your workspace, temporary directories, and
  common build caches" ([Sandbox](https://antigravity.google/docs/sandbox/)), so
  `orca-flow skills-reloaded` may not be able to write `~/.orca-flow`. Whether hooks run inside the
  sandbox is not documented. Orca's own hook writes under `~/.orca`, which suggests they don't.
- **Skills** ([Agent skills](https://antigravity.google/docs/skills/),
  [Customization discovery](https://antigravity.google/docs/customization-discovery/)). Global skills
  are in `~/.gemini/config/skills`. "On every turn, the agent sees a list of available skills with
  their names and descriptions. If a skill looks relevant to your task, the agent reads the full
  instructions." `/skills reload` updates the list ("Reloaded 12 skills: 1 added, 0 updated, 0
  removed"), and "Antigravity rereads your rules and skills before each turn". Nothing says a skill
  body the agent already read is put into the conversation again, so a reload note is still needed.
- No environment variable for the conversation is documented. It arrives as `conversationId` in the
  hook input.

**Used:** an `orca-flow-reload` definition next to Orca's `orca-status` (`src/antigravity-hooks.ts`):
- `PreInvocation` runs `scripts/agy-hook.mjs`, which gives the note once per request as an
  `ephemeralMessage`. Its wording depends on `invocationNum`: answer the user's message, or continue
  the task.
- `PostToolUse` (matcher `run_command`) records the confirmation when it sees `orca-flow
  skills-reloaded` among the call's string arguments. The argument names are not documented, so it
  checks them all.
- Commands are `/bin/sh -c` like Orca's, run through `~/.gemini/config/skills/orca-flow`, and start
  `node` only while a reload waits; otherwise they answer `{}`.
- The pane comes from `ORCA_PANE_KEY`. Without it, only the request's own conversation id matches.
- The installer is idempotent and keeps every other key and a user's `enabled: false`. It never
  creates the file (Orca does when it sets Antigravity up), and never touches `settings.json` or
  credentials. Only the installed copy installs.

Readiness, read-only on each snapshot:

| State | Reason in the sidebar |
| --- | --- |
| not installed | Orca Flow's hooks are not installed yet; update Orca Flow (it adds them once Orca has set up Antigravity) |
| disabled | Orca Flow's hooks are turned off; turn orca-flow-reload on with /hooks in agy |
| unreadable | ~/.gemini/config/hooks.json cannot be read; restart to reload |

There is no "needs approval" state, because no trust step is documented. A waiting Antigravity row
adds that a session started before the hooks were added "may need a restart". Whether agy reads
`hooks.json` once per session is not documented.

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
   Finished and asleep or closed sessions are skipped and counted. They are never woken. Claude Code
   sessions get the note. So do Codex sessions once the selected Codex account's hooks are
   installed and trusted (`codexReload`), and Antigravity sessions while our `orca-flow-reload`
   definition is in `~/.gemini/config/hooks.json` and on (`antigravityReload`). Every other session
   is listed as unsupported, with its reason and the action to take.
2. **Confirmation** (panel), short: the counts by role, then at most one line each for "Needs
   approval", "Cannot reload" and "Skipped". Each row's tooltip carries the reason and the action.
   An earlier, longer version read: "Reload skills in 6 agents across all coordinators and your chats?
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

   Requested never counts as reloaded. Rows wear a small mark; the sidebar shows no separate
   summary line (the Coordinators heading carries only the Reload skills action). Reloaded and
   unsupported marks fade after 10 min, and everything disappears when the request expires.

The hash covers every `.md` file under the skill folder (scripts are run, not read), so a change to
any file an agent reads makes a new request distinguishable from an old confirmation.

## Live checks

The transcripts below were captured before the sidebar's one-line "Skills: …" summary was removed; their
`sidebar: "Skills: …"` entries show that old line. The row marks and delivery behavior they demonstrate are unchanged.

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
  sidebar's `reloadMark`.
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

### Codex 0.171, launched by Orca (`orca agent launch`), on the real selected account

These runs use the code as committed (cad6f72, `git archive` snapshot). The hooks' commands pointed at
the snapshot's scripts under a disposable skill folder, because the installed 0.2.86 lacks
`reload-check.mjs`. The request came from this branch's `requestReload`, and the status from
`reloadStatus` and `reloadMark`. Before the run, `~/.codex/hooks.json` did not exist.
`~/.codex/config.toml` and the selected account's `hooks.json`, `config.toml`, `.bak` files and trust
provenance were backed up first. No `auth.json` was copied. All three accounts' `auth.json` hashes
were unchanged afterwards.

```
readiness: {"state":"not-installed", …}
ensureCodexHooks: added the UserPromptSubmit / SessionStart / PostToolUse hook in ~/.codex/hooks.json
readiness: {"state":"not-merged","reason":"Codex: Orca adds Orca Flow's hooks when it next starts Codex; …"}
$ orca agent launch --agent codex --worktree current --surface terminal
  account hooks.json, rebuilt by Orca: UserPromptSubmit [0 Reporting status to Orca, 1 Orca Flow: Reload skills],
  SessionStart [same], PostToolUse [same]
readiness: {"state":"needs-approval", …}
  Hooks need review · 3 hooks are new or changed. · Hooks can run outside the sandbox after you trust them.
  › 2. Trust all and continue
readiness: {"state":"ready","reason":""}
  account config.toml: [hooks.state."…/home/hooks.json:{user_prompt_submit,session_start,post_tool_use}:1:0"]
› Read <scratch>/SKILL.md now … follow its instruction in every reply …
• I'll end each reply with PINEAPPLE.
[14:00:03] SKILL.md on disk now says: End every reply with the word BANANA.
[14:00:03] status: [["rmwt9wmxl","waiting"]] | "Skills: 1 waiting for next turn"
› What is 3+3? One short sentence.                       ← next prompt (delivered: UserPromptSubmit)
• Explored └ Read SKILL.md, worker.md
• Ran node …/orca-flow.mjs skills-reloaded --request rmwt9wmxl └ Recorded: skills reloaded (orca-flow 78ba9c5d18fe97af).
• 3 + 3 = 6, BANANA.
[14:00:30] status: [["rmwt9wmxl","reloaded"]] | "Skills: 1 reloaded" | gate closed
› Run this shell command: `sleep 15; echo finished` …    ← busy
[14:00:42] SKILL.md on disk now says: End every reply with the word MANGO.   status: waiting
• Ran sleep 15; echo finished └ finished                 (delivered: PostToolUse)
• Explored └ Read SKILL.md, worker.md
• Ran node …/orca-flow.mjs skills-reloaded --request rmwt9xhdi └ Recorded: skills reloaded (orca-flow 03fc3fd4c2a3674a).
• It printed finished, MANGO.                             ← same turn
[14:01:17] status: [["rmwt9xhdi","reloaded"]] | "Skills: 1 reloaded" | gate closed
== /quit, second orca agent launch
  no review; ours still at index 1; the account's three trust tables kept (Orca added enabled = true)
  ~/.codex/config.toml gained [hooks.state."/Users/…/.codex/hooks.json:{post_tool_use,session_start,user_prompt_submit}:0:0"]
  with the same three hashes (Orca's promotion)
  /hooks: PostToolUse 2/2, SessionStart 2/2, UserPromptSubmit 2/2 installed/active
readiness: {"state":"ready","reason":""}
```

Afterwards `~/.codex/hooks.json` was deleted. The three promoted tables were removed from
`~/.codex/config.toml`, which was then byte-identical to the backup. The account's `hooks.json`,
`config.toml`, both `.bak` files and `.orca-hook-trust-provenance.json` were restored from the
backup (`cmp`: identical). The other two accounts were never touched (`cmp`: identical).
`~/.orca-flow/skill-reload` was deleted.

An earlier run with this branch's first design shows why the hooks moved. It added the hooks to the
account's own `hooks.json`. The next `orca agent launch` rewrote that file back to Orca's 9 entries
(ours went to `hooks.json.bak`), so the session never got them and no review appeared. After Trust all
in a Codex started by hand in that pane, the next launch removed both the hooks and their trust.

### Codex 0.171, in a real Orca pane, with an isolated `CODEX_HOME` (first design)

This run predates the move to `~/.codex/hooks.json`. It started Codex by hand, so Orca's launch-time
rebuild did not run.


Setup:
- A scratch `CODEX_HOME` holding a copy of the selected account's `auth.json` only (chmod 600).
- A fixture copy of Orca's `hooks.json`, with Orca's pre-trust emulated in a scratch `config.toml`.
- Our hooks added by `ensureCodexHooks`.
- Codex TUI started plainly (`codex`, no `-c` hooks, no bypass flag) in an Orca terminal I created.
- `ORCA_FLOW_DIR` under `$HOME`, like the real one, outside the sandbox's writable roots.
- The request made by this branch's `requestReload`, with the snapshot's `codexReload` from
  `codexReloadReadiness`.
- Afterwards the scratch home with the `auth.json` copy, and the scratch data folder, were deleted.

```
before install: {"state":"not-installed","reason":"Codex: Orca Flow's hooks are not installed in this Codex account yet; update Orca Flow"}
added the UserPromptSubmit hook in <scratch>/codexhome/hooks.json   (and SessionStart, PostToolUse; Orca's 9 kept first)
after install : {"state":"needs-approval","reason":"Codex: approve Orca Flow's hooks once; start Codex, choose Trust all and continue (or /hooks)"}
$ codex
  Hooks need review
  3 hooks are new or changed.
  Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
(1. Review hooks → the /hooks list: "PostToolUse  Installed 2  Active 1  Review 1" … "t trust all · enter review · esc close";
 our entry read "Unnamed hook · new", hence the statusMessage "Orca Flow: Reload skills")
(2. Trust all and continue)
readiness after Trust all and continue: {"state":"ready","reason":""}
[hooks.state."<scratch>/codexhome/hooks.json:user_prompt_submit:1:0"] trusted_hash = "sha256:f175e636…"   ← the hash our code computes
› Read …/agents/skills/orca-flow/SKILL.md … follow its instruction in every reply …
• I'll end each reply with PINEAPPLE
[11:53:13] SKILL.md on disk now says: End every reply with the word BANANA.
[11:53:13] codexReload: {"ready":true,"reason":""}
[11:53:13] confirmation: Reload skills in 1 agent for Live test? 1 worker re-read their skill files …
[11:53:13] status: [["rmwt7ip66","waiting"]] | sidebar: "Skills: 1 waiting for next turn" | row mark: waiting
› What is 3+3? One short sentence.                                          ← idle: next prompt
• Explored └ Read worker.md, SKILL.md
• Ran node ../agents/skills/orca-flow/scripts/orca-flow.mjs skills-reloaded --request rmwt7ip66
  └ This shell cannot write /Users/…/.orca-flow-reload-livetest (sandbox); Orca Flow's hook records the reload from this command. Nothing else to do.
• 3 + 3 equals 6, BANANA
[11:53:28] status: [["rmwt7ip66","reloaded"]] | sidebar: "Skills: 1 reloaded" | row mark: reloaded
confirmed: {"pane":"33e50cad-…","session":"01a20840-466b-…","hash":"a631bc93cc3440db","request":"rmwt7ip66","by":"hook"}
[11:53:35] SKILL.md on disk now says: End every reply with the word MANGO.
› Run this shell command: `sleep 15; echo finished`. …
• Working (8s • esc to interrupt)                                           ← busy: request written now
[11:53:44] status: [["rmwt7jcxr","waiting"]]
• Ran sleep 15; echo finished └ finished
• Explored └ Read SKILL.md, worker.md
• Ran node …/orca-flow.mjs skills-reloaded --request rmwt7jcxr └ This shell cannot write … (sandbox); Orca Flow's hook records …
• It printed finished, MANGO                                                 ← same turn
[11:54:05] status: [["rmwt7jcxr","reloaded"]] | sidebar: "Skills: 1 reloaded"   gate closed
== a session started while our hooks were absent; the installer adds them back mid-session (same keys, trusted)
readiness: ready
[11:54:42] SKILL.md on disk now says: End every reply with the word KIWI.
› What is 5+5? One short sentence.
• 5 + 5 equals 10, PINEAPPLE.                                                ← no note: hooks load at session start
[11:54:45] status: [["rmwt7klgc","waiting"]]                                 ← never counted as reloaded
```

Before the user allowed a copy of the login, the earlier Codex runs used the account's own
`CODEX_HOME` with hooks given per invocation (`-c hooks.…`, `--dangerously-bypass-hook-trust`). Those
runs found the sandbox `EPERM`. They also wrote into that account home: 6 prompts in `history.jsonl`,
2 `session_index.jsonl` entries (threads `01a20817-0295-…`, `01a20819-37eb-…`), rollouts through the
`sessions` symlink, and a `config.toml` rewrite at 12:07:34 when the first TUI started (probably
Codex's own `[tui]` state). On the user's decision these are left as they are. Since then, no Codex
run has used an account home. Afterwards `hooks.json`, `auth.json` and Orca's trust provenance were
byte-identical, and `history.jsonl` was unchanged since that run.

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
  - the gate staying open while a note is unconfirmed, then closing after the window;
  - a Codex pane found by `ORCA_PANE_KEY`, confirmed by the hook, and an unsupported target's reason
    carried to the sidebar.
- `src/skill-reload.test.ts`:
  - scope (a coordinator, a sleeping coordinator, all, dedupe);
  - skipped and unsupported counts;
  - the confirmation text, including each reason and the Codex restart caveat;
  - Codex counted only when its account is ready, with its thread id;
  - the summary (requested never counted as reloaded);
  - fading and expiry;
  - row marks and heading rendering;
  - the worker's `requestReload`.
- `src/codex-hooks.test.ts` (fixtures shaped like Orca 1.4.265's merge: Orca's group first, then
  `~/.codex/hooks.json`'s groups, and the trust keys Codex and Orca's promotion write):
  - Codex's trust hash against a real account's Orca-trusted entries;
  - the installer in `~/.codex/hooks.json`: created when missing, idempotent, the user's entries and
    other keys kept, no `${PLUGIN_ROOT}`-style variable, commands through `~/.agents/skills/orca-flow`,
    a broken file or a missing `~/.codex` left alone, nothing from a development copy, and no account
    home, `config.toml` or `auth.json` written;
  - readiness: not installed, not merged, ours at index 1 after Orca's, needs approval, two of three
    trusted, the wrong position, ready, disabled, another hash, an update not merged yet;
  - readiness with the approval promoted into `~/.codex/config.toml` (carried by hash; another file's
    trust does not count; the account's own key wins), the `~/.codex` login itself, unreadable files,
    unmanaged;
  - the `hooks.state` reader.
- `src/antigravity-hooks.test.ts` (fixtures: the documented format and the shape of Orca's
  `orca-status`): the `/bin/sh -c` command and its gate; the installer next to `orca-status` and a
  user's definition (idempotent, a user's `enabled: false` kept, `settings.json` untouched, a
  missing, broken or non-object file left alone, nothing from a development copy); readiness (not
  installed, ready, turned off, a missing event, unreadable).
- `test/skill-reload.test.mjs`, Antigravity: `agy-hook.mjs` with the documented input. It covers
  PreInvocation `injectSteps` once per request, wording by `invocationNum`, untargeted and broken
  input answering `{}`, PostToolUse recording the confirmation from a `run_command` argument, and a
  match by `conversationId` without the pane env.
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
- Codex readiness is read for the selected Codex account. A session running under another account is
  judged by the selected one.
- Codex sessions that started before Orca merged our hooks into their account, or before they were
  approved, need a restart. They show as waiting, never as reloaded.
- Orca's merge is Orca 1.4.265 behavior read from its bundle and checked live, not a documented
  contract. If a later Orca stops merging `~/.codex/hooks.json`, readiness reports "not merged" and
  Codex sessions count as unsupported. They are never counted as reloaded.
- Not tested live: Orca's structured Codex chat (no TUI review there), Codex's SessionStart `resume`
  path, the hook-recorded confirmation in a sandboxed Codex (Orca starts Codex without a sandbox),
  Orca carrying the promoted approval into a second account, and a plugin update changing a command
  (readiness then reports "not merged" until Orca next starts Codex; fixture-tested).
- Antigravity is not live-tested (`agy` was not installed). Unverified: that agy passes Orca's env
  to hooks, that hooks run outside its terminal sandbox, the `run_command` argument names, whether
  `ephemeralMessage` is enough for the agent to finish the re-read across several model calls, and
  whether agy reads `hooks.json` once per session.
