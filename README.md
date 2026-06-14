# pi-feedback

A Pi extension package that adds `/feedback` for quick, structured feedback across Pi sessions.

Ratings:

- `terrible`
- `bad`
- `good`
- `great`
- `perfect`

The extension records a short global feedback log at `~/.pi/agent/FEEDBACK.md`, then analyzes the current session in the background without asking follow-up questions. It extracts granular reasons, durable memory suggestions, repeated patterns, and candidate AGENTS.md rules.

## Install

### Recommended: global install

Install once for your computer:

```bash
pi install git:github.com/dantetekanem/pi-feedback
```

Or with the full HTTPS URL:

```bash
pi install https://github.com/dantetekanem/pi-feedback
```

Then reload your active Pi session:

```text
/reload
```

Verify it loaded:

```text
/feedback status
```

Global install is the default. Do **not** pass `-l` unless you intentionally want project-local `.pi/settings.json` state.

### One-off preview

Run Pi with the extension temporarily:

```bash
pi -e git:github.com/dantetekanem/pi-feedback
```

### Local development

```bash
git clone https://github.com/dantetekanem/pi-feedback.git
cd pi-feedback
pi -e ./src/index.ts
```

## Usage

```text
/feedback
/feedback great
/feedback bad missed the requested scope and ran broad checks
/feedback bad ignored extensions to ask questions, did not try to install and let me preview extension
```

Without a rating argument, `/feedback` opens a picker. With a rating argument, it records immediately and starts background analysis. Everything after the rating is treated as optional extra feedback and included in `~/.pi/agent/FEEDBACK.md` plus the background analysis.

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
/feedback max-entries 20
```

Defaults:

- session-end nudges: on
- memory follow-up messages: off
- AGENTS.md candidate follow-up messages: off
- repeated-pattern threshold: 3
- max retained entries: 20

Settings are stored in the same global feedback file, so they apply across projects and sessions.

## Memory and AGENTS.md behavior

Pi extension APIs expose commands, session access, model calls, `sendUserMessage`, and custom session entries, but no direct external-memory API. Because of that, pi-feedback writes memory suggestions into `~/.pi/agent/FEEDBACK.md` and can optionally queue a follow-up user message asking the active agent to update memory if a memory tool is available.

AGENTS.md updates are never automatic. Repeated patterns become candidates in `~/.pi/agent/FEEDBACK.md`; optional follow-ups only summarize candidates and instruct the agent not to edit AGENTS.md without explicit user approval.

## Global FEEDBACK.md format

`~/.pi/agent/FEEDBACK.md` keeps a machine-readable JSON block between:

```text
<!-- pi-feedback:start -->
...
<!-- pi-feedback:end -->
```

The extension preserves any content outside that managed block and limits retained entries/patterns to keep the file short.

## Development

```bash
pnpm install
pnpm run typecheck
```

Pi package metadata lives in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
