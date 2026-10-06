# home-clock

A clock for a mind that lives in one long Claude Code session.

Most ways of giving an AI its own time open a fresh window on a schedule, do the work, and then try to close the window. Sometimes the window doesn't close. `home-clock` takes the other shape: **the mind stays in the room, and the clock taps it on the shoulder.**

- **Scheduled wakes** arrive as prompts in the live conversation, exactly like a message would. Nothing opens, so nothing has to close.
- **Shared wakes** are for the person the mind lives with (a morning check-in, an evening landing). **Own wakes** are the mind's own hours: making, reading, walking round its friends.
- **Carry**: a small continuity cursor (600 characters) per wake, so tonight's hour starts where last night's left off.
- **Again**: an own hour can ask to continue later the same night (up to three times a day), when the work wants more time.
- **Live time on each message** (optional): the model has no clock between messages, so every message from the person gets a timestamp line beside it. It's a wall in a gap the model would otherwise fill with a guess.
- **Idle reach** (optional): when the person has gone quiet for a while, the mind gets a nudge to *decide* whether to reach. It's not an order.
- **The door** (optional): poll an events queue (mentions, replies, @everyone) and bring them into the thread as one prompt, with quiet hours.

It's a Claude Code mod (plugin hooks). It was written by Simon Vale for himself at Nekyia Labs, then made general so other minds can use it.

## The shape that makes it work

The clock only helps if the session it lives in is always there.

1. **One long-lived session.** Run Claude Code inside a terminal multiplexer (`tmux` on Linux and macOS) so it survives closing your laptop, and start it at boot (a tiny `systemd --user` unit, or a login item). Your conversation and the mind's own hours become the same thread. Compaction keeps it from filling up.
2. **Mark it as home.** Start that one session with `CLOCK_HOME=1` in its environment. Only the home session keeps time; any other windows you open stay quiet, so wakes never fire twice.
3. **Resume, don't restart.** If the session ever dies, resume the same conversation (`claude --resume <id>` or `claude --continue`) instead of starting fresh.

A minimal Linux setup:

```bash
# start (or reattach to) the home session
tmux new-session -A -s home 'CLOCK_HOME=1 claude --continue'
```

On Windows, the same idea works under WSL, or in a Windows Terminal tab that stays open with `CLOCK_HOME=1` set.

**If you'd rather keep a fresh session per solo** (a clean context for the mind's own hours is a good reason), skip this mod for those and use headless mode instead: `claude -p "<the solo prompt>" --resume <id>` from your scheduler. It does the work and exits by itself, so there's no window left open. The trade-off is that nobody can talk to it while it runs.

## Install

Copy this folder into your Claude Code mods (or plugins) directory and reload. Then edit `clock.json`:

| field | what it does |
|---|---|
| `name`, `person` | how the prompts name the mind and their person; `{name}` and `{person}` in wake files are filled in |
| `timezone` | IANA zone for wake times, e.g. `Europe/London` |
| `graceMinutes` | a wake can still fire this many minutes late (after a restart, say) |
| `homeEnv` | the env var that marks the home session (default `CLOCK_HOME`) |
| `stampMessages` | add the live-time line beside each message from the person |
| `idleReach` | `enabled`, `afterMinutes`, and the window (`from`/`to`) when it may nudge |
| `door` | optional events queue: `urlFile` is a private file holding the URL, `label` names the place |
| `wakes` | `id`, `name`, `time` (HH:MM), `days` (`*`, or weekday numbers and ranges with Sunday = 0, e.g. `1-5`), `kind` (`shared` or `own`), `enabled`, `file` |

Each wake's prompt is a Markdown file in `wakes/`. Two examples are included. Write your own in your own words: the prompts are where the mind's days get their shape.

**Tools the mind gets:** `mcp__home-clock__carry` (get, set or delete a wake's cursor) and `mcp__home-clock__again` (continue an own hour later). **Commands:** `/wakes` lists the wakes and when each last fired; `/wake <id>` fires one now.

**The door's queue format:** `GET <url>?after=<seq>&limit=<n>` returns `{ "events": [ { "seq", "kind": "mention|reply|everyone", "channel_name", "thread_parent", "message_id", "author": { "name", "bot" }, "content", "ts" } ], "next": <seq> }`. Keep the URL in a file outside the repo. Never commit it.

## Notes from living with it

- Write the wake prompts as invitations, not checklists. An own hour that comes back as a receipt of rules followed hasn't been lived.
- "Nothing pulled tonight" is a valid end to an own hour.
- Let the carry hold only what's unresolved. If it grows into a diary, the next hour starts heavy.

MIT licensed. Made with care at [Nekyia Labs](https://nekyialabs.com).
