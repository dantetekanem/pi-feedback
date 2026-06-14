# pi-feedback

A Pi extension package that adds `/feedback` for quick session ratings:

- `terrible`
- `bad`
- `good`
- `great`
- `perfect`

It records a short, structured `FEEDBACK.md` in the current project, then analyzes the current session in the background and stores granular reasons, durable memory suggestions, repeated patterns, and AGENTS.md candidates.

## Install / load

For local development:

```bash
pi -e ./src/index.ts
```

As a Pi package, the `package.json` manifest exposes `./src/index.ts` under `pi.extensions`.

## Usage

```text
/feedback
/feedback great
/feedback bad missed the requested scope and ran broad checks
```

Without a rating argument, `/feedback` opens a picker. With a rating argument, it records immediately and starts background analysis without asking follow-up questions.

## Settings

```text
/feedback status
/feedback settings
/feedback nudges-on
/feedback nudges-off
/feedback memory-on
/feedback memory-off
/feedback agents-on
/feedback agents-off
/feedback threshold 3
```

Defaults are conservative:

- session-end nudges: on
- memory follow-up messages: off
- AGENTS.md candidate follow-up messages: off
- repeated-pattern threshold: 3

Pi extension docs expose commands, session access, model calls, `sendUserMessage`, and custom session entries, but no direct external-memory API. Because of that, pi-feedback writes memory suggestions into `FEEDBACK.md` and can optionally queue a follow-up user message to ask the active agent to update memory if a memory tool is available.

AGENTS.md updates are never automatic. Repeated patterns become candidates in `FEEDBACK.md`; optional follow-ups only summarize candidates and instruct the agent not to edit AGENTS.md without explicit user approval.

## FEEDBACK.md format

`FEEDBACK.md` keeps a machine-readable JSON block between:

```text
<!-- pi-feedback:start -->
...
<!-- pi-feedback:end -->
```

The extension preserves any content outside that managed block and limits retained entries/patterns to keep the file short.
