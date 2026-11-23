# Reload skills

Skill files change on disk all the time: a plugin update repoints `<Claude profile>/skills/orca-flow`,
`~/.agents/skills/orca-flow` and the Gemini link at the new release (src/install.ts), and
`orca skills update` refreshes Orca's bundled skills (orchestration, orca-cli). A running agent does
not notice. It read `SKILL.md` and its role file earlier, and that text stays in its conversation.
Refreshing the files does not fix that. The agent has to read them again in the same conversation.

**Reload skills** in the sidebar asks it to. Delivery uses our hooks in Claude Code and in Codex:
nothing is typed into a terminal, and no Orca mail is sent.

## Codex: approve Orca Flow's hooks once

Codex runs a hook only after you trust it. The installed Orca Flow adds three hooks named **Orca
Flow: Reload skills** to each Orca-managed Codex account. They go into the account's `hooks.json`,
next to Orca's own. Until you approve them, the sidebar counts that account's Codex sessions as
unsupported and says why.

1. Start a Codex session in Orca (any workspace), after Orca Flow has updated.
2. Codex opens with **Hooks need review** · "3 hooks are new or changed" · "Hooks can run outside
   the sandbox after you trust them".
3. Choose **2. Trust all and continue**. To see them first, choose **1. Review hooks**: each event
   lists *Orca Flow: Reload skills* with its command (`node ~/.agents/skills/orca-flow/scripts/…`).
   `t` trusts all, `esc` closes. Option 3 or `esc` skips them, and they won't run.
4. In a session that is already open, `/hooks` opens the same list.
5. Restart Codex sessions that were already running. Codex loads hooks when a session starts, so a
   session started before you approved never gets the note.

You do this once per Codex account. Orca Flow never writes Codex's trust state: Codex records your
choice in that account's `config.toml`. The sidebar reads it (read-only) and calls the account ready
when all three hooks are trusted with the hash of their current command.

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
  (`<Orca data>/codex-accounts/<id>/home`, marked `.orca-managed-home`). Orca fills every event there
  with its own status hook (`: orca-agent-hook-form=2; …`).
  - When Orca rewrites the file it removes only its own commands and keeps the rest (read from Orca
    1.4.265's bundle, `hook-trust-promotion`).
  - The input matches Claude Code's (`session_id`, `cwd`, `transcript_path`; for PostToolUse
    `tool_name: "Bash"`, `tool_input.command`). The output (`hookSpecificOutput.additionalContext`)
    reaches the model as a `developer` message.
  - Codex panes get `ORCA_PANE_KEY`, and our scripts accept it as the pane.
- **Trust.** A hook runs only once trusted. `config.toml` holds one table per hook:
  `[hooks.state."<realpath>/hooks.json:<event>:<group>:<handler>"]` with
  `trusted_hash = "sha256:…"` and `enabled`.
  - The hash is sha256 of the key-sorted JSON of
    `{event_name, hooks:[{type, command, timeout, async, statusMessage?}], matcher?}`. The matcher is
    included for tool events only.
  - Our implementation reproduces Codex's hash for all nine Orca-trusted entries of a real account.
    It also reproduces the three that Codex wrote for ours after "Trust all and continue".
  - Orca pre-trusts its own hooks. Ours are trusted by the user (see above). The trust key includes
    the position, so if Orca reorders the entries, the sidebar falls back to "approve once" until the
    user trusts them again.
- **Sandbox.** Codex's default `workspace-write` sandbox refuses writes to `~/.orca-flow` (`EPERM`).
  Hooks run outside it, so the PostToolUse hook records the confirmation when it sees
  `orca-flow skills-reloaded` run.
- **Hooks load at session start.** A session started before our hooks were in `hooks.json` did not
  pick them up later, even with the trust already in place (live check below).
- No skill reload command exists. `codex queue` would put a visible user turn in front of the agent.

**Used:** the same three scripts as for Claude Code, through `~/.agents/skills/orca-flow` (the Codex
user skill link), installed by `src/codex-hooks.ts` into every Orca-managed Codex account, installed
copy only. The installer is idempotent and updates in place, so the trust key stays put. It keeps
Orca's and every other entry, never creates `hooks.json`, and never touches `config.toml`,
`auth.json` or any trust state. The worker checks the selected Codex account (`orca account list`,
every 5 minutes). A Codex session counts only when that account is ready. Otherwise it is unsupported
with the reason and one action:

| State | Reason in the sidebar |
| --- | --- |
| not installed | Orca Flow's hooks are not installed in this Codex account yet; update Orca Flow |
| needs approval | approve Orca Flow's hooks once; start Codex, choose Trust all and continue (or /hooks) |
| disabled | Orca Flow's hooks are turned off; turn them on in Codex with /hooks |
| unreadable | its hooks.json cannot be read; restart to reload |
| unmanaged | the selected Codex login is not an Orca-managed account, where Orca Flow installs its hooks |

When Codex sessions are asked, the confirmation adds: "A Codex session started before you approved
Orca Flow's hooks reloads only after a restart." A Codex row that is waiting says the same in its
tooltip.

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
   installed and trusted (`codexReload`). Every other session is listed as unsupported, with its
   reason and the action to take.
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

### Codex 0.171, in a real Orca pane, with an isolated `CODEX_HOME`

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
- `src/codex-hooks.test.ts`:
  - Codex's trust hash against a real account's Orca-trusted entries;
  - the installer next to Orca's entries: idempotent, other entries kept, `config.toml` and
    `auth.json` untouched, a missing or broken `hooks.json` left alone, nothing from a development
    copy;
  - readiness (not installed, needs approval, two of three trusted, wrong position, ready, disabled,
    changed command, unreadable, unmanaged);
  - the `hooks.state` reader.
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
- Codex sessions that started before the hooks were installed or approved need a restart. They show
  as waiting, never as reloaded.
- Not tested live: a Codex session started by Orca itself (as opposed to one I started in an Orca
  terminal), Orca's structured Codex chat (no TUI review there), Orca rewriting `hooks.json` with
  ours in it, and Codex's SessionStart `resume` path.
