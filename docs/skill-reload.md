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

### Codex CLI 0.171.0

- `codex features list` shows `hooks  stable  true`. The binary carries hook schemas for
  `SessionStart`, `UserPromptSubmit` and `PostToolUse`, each with `additionalContext`, plus
  `hooks.json` and `[hooks]` in `config.toml`.
- Hooks are gated by trust: "hooks are new or changed", "hooks need review before they can run",
  "failed to load startup hook review state". A new or changed hook has to be reviewed by the user
  in Codex before it runs. Hooks are loaded when the session starts.
- Hooks live in the account's `CODEX_HOME`, and Orca switches `CODEX_HOME` per account
  (`~/Library/Application Support/orca/codex-accounts/<id>/home`).
- No skill reload command exists. `skill_catalog_deltas` is "under development" and off.
- `codex queue --thread <id> --message <text>` queues a user message into a session. That would be a
  visible user turn the agent answers, possibly instead of an open ask. It is also not verified
  against Orca's Codex panes, so it is not used.

**Used:** nothing. Codex sessions are reported as *unsupported: restart to reload*. A session that is
already running cannot gain a hook. Adding one for future sessions would mean writing into each
Orca Codex account's config and asking the user to approve it in Codex. Account configuration is
off limits here (src/install.ts never touches it), so this is a possible follow-up, not part of this
change. Antigravity and unknown agents are reported the same way.

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
   changed again after the request, it says so and asks the agent to read once more.
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

## Live check (disposable Claude Code session)

Setup (`scratchpad/drive-claude.mjs`, not committed):
- One `claude -p --input-format stream-json` process, so all turns are one conversation in one
  process.
- `--setting-sources project`, so none of the user's settings, hooks or plugins load.
- Our three hooks via `--settings`, pointing at a scratch copy of the skill whose `scripts` links to
  this worktree.
- `ORCA_FLOW_DIR` in the scratch dir, a fake `ORCA_AGENT_PANE`, and every other `ORCA_*` and `CLAUDE*`
  variable unset.
- No live Orca session, user session or user data was touched.

```
session 51576a07-1901-4646-9e1d-aa44c4bacf5d, pane live-test:pane-1
>>> USER: Read …/skills/orca-flow/SKILL.md now and follow its instruction in every reply …
<<< CLAUDE: Read the skill and I'll end every reply with the required word. PINEAPPLE
--- SKILL.md on disk now says: End every reply with the word BANANA.
>>> USER: What is 2+2? One short sentence.
<<< CLAUDE: 2+2 is 4. PINEAPPLE                         ← stale: the problem
--- reload request r-live-1 written (hash a631bc93cc3440db); active gate: true
--- status: [["r-live-1","waiting"]]
>>> USER: What is 3+3? One short sentence.
  [tool] Read: …/skills/orca-flow/SKILL.md
  [tool] Read: …/skills/orca-flow/roles/worker.md
  [tool] Bash: node …/skills/orca-flow/scripts/orca-flow.mjs skills-reloaded --request r-live-1
<<< CLAUDE: 3+3 is 6. BANANA                            ← same conversation, new text
--- status: [["r-live-1","reloaded"]]
>>> USER: What is 4+4? One short sentence.
<<< CLAUDE: 4+4 is 8. BANANA                            ← no second note
--- SKILL.md on disk now says: End every reply with the word MANGO.
>>> USER: Run this shell command with Bash: `sleep 12; echo finished`. Then tell me …
  [tool] Bash: sleep 12; echo finished
--- reload request r-live-2 written (hash 45230a0784e8ce91); active gate: true   ← mid-turn
  [tool] Read: …/skills/orca-flow/SKILL.md
  [tool] Read: …/skills/orca-flow/roles/worker.md
  [tool] Bash: node …/skills/orca-flow/scripts/orca-flow.mjs skills-reloaded --request r-live-2
<<< CLAUDE: The command printed "finished". MANGO        ← busy agent, same turn
--- status: [["r-live-2","reloaded"]]
--- confirmed: {"pane":"live-test:pane-1","session":"51576a07-…","hash":"45230a0784e8ce91","request":"r-live-2",…}
```

The transcript has exactly two `hook_additional_context` attachments. The first is `UserPromptSubmit`
for r-live-1. The second is `PostToolUse` (`PostToolUse:Bash`) for r-live-2. The agent's own Read and
Bash calls made while reloading gave no further note. The `active` gate file was gone afterwards.

**Codex:** no live check. A Codex session cannot receive our note without a Codex hook. Installing
one means writing into a Codex account's config (or copying its `auth.json` into an isolated home)
and approving the hook in Codex's review. Both are off limits. The unsupported reporting is covered
by unit tests.

## Tests

- `test/skill-reload.test.mjs`:
  - the request store (per pane, replace, expiry, broken file);
  - delivery only to targeted sessions, once per request across hooks, not to subagents or
    unsupported targets, and by session id after a pane change;
  - the role-aware text and the role rule;
  - each hook end to end (no opt-in needed, PostToolUse once, SessionStart only on resume and
    compact), and the reminder and note combined;
  - `orca-flow skills-reloaded`: confirmed only on a matching hash made after the request, and
    refused outside Orca and Claude Code.
- `src/skill-reload.test.ts`:
  - scope (a coordinator, a sleeping coordinator, all, dedupe);
  - skipped and unsupported counts;
  - the confirmation text;
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
