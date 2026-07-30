<p align="center">
  <img src="docs/banniere.png" alt="Orchestrator" width="720">
</p>

<h1 align="center">Orchestrator</h1>

<p align="center"><b>A judge decides, an agent executes, proof settles it.</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-informational" alt="Node 20 or later">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="PolyForm Noncommercial 1.0.0 license">
  <img src="https://img.shields.io/badge/database-local%20SQLite-lightgrey" alt="Local SQLite database">
</p>

An orchestration loop for coding agents. It removes the copy-pasting between the
conversation where you think — with a model that judges the work — and the
harnesses that actually touch the repository. It reads the instruction, runs it,
derives cost and deliverables from the traces, attaches the renders, and posts
the report back. The judge accepts or rejects, and the loop carries on.

And it **refuses to close an objective until its proof is in.**

## The idea

"Done" is not a field an agent writes, it is a **condition you evaluate**. An
objective closes only if:

- its proof criterion is written down — without one, nobody may claim it;
- its sub-objectives are closed — a chapter never closes before its parts;
- a `pass` proof exists, and **an image if the criterion is about seeing**;
- a high blast radius has been answered with real-world proof, not a green build;
- the project's judge has ruled — and a rejection **revokes** its earlier approval;
- no halt that requires a human is still open.

Everything else is **derived, never declared**: cost comes from the transcripts,
deliverables from the files actually written during the session, liveness from an
attempt that has no end. An agent cannot forget to report what is read on its
behalf — and cannot award itself a success.

## Getting started

The package is not published on npm yet; install it from source.

```bash
git clone https://github.com/chaibialaa/orchestrator.git
cd orchestrator
npm install            # the server
npm --prefix web i     # the interface
npm run build          # builds the interface into public/
npm start              # http://localhost:4747
```

One process serves the interface **and** the API. Data lives in a SQLite file
under `~/.orchestrator/` — no database to install, and a backup is a copy of that
file; `orchestrator where` tells you which one.

## Declaring a project

In the root of **every repository you drive**, an `.orchestrator.json` declares
what is local to this machine. The server itself never stores a command to run:
that separation is what will make it safe to host without it being able to
execute anything on anyone's machine.

```json
{
  "project": "my-project",
  "blastRadius": ["src/payments/**", "migrations/*"],
  "proofs": {
    "build": "npm run build",
    "test": "npm test -- --run"
  },
  "probes": {
    "migrations_touched": "git status --porcelain -- migrations | grep -c . || true"
  },
  "binaries": { "codex": "/path/to/codex" },
  "env": { "NODE_ENV": "test" },
  "secrets": { "RUNPOD_API_KEY": "" }
}
```

| key | what it decides |
| --- | --- |
| `project` | which server-side project this repository belongs to |
| `blastRadius` | the sensitive paths: touching them demands real-world proof |
| `proofs` | the **only** commands that may ever run — nothing else is executable |
| `probes` | diagnostic readings, attached to the report |
| `binaries` | where to find a harness; `ORCHESTRATOR_CODEX_BIN` wins, otherwise the PATH decides |
| `env`, `secrets` | what gets injected into the agent's environment (an empty secret overrides nothing) |
| `deliverableDirs`, `deliverableIgnore` | narrow the deliverable sweep when the default is not enough |

This file holds machine paths and keys, so it is **git-ignored** — keep it local.

## The loop

```bash
cd my-project
orchestrator chapter --objective 42 --budget 60 --max-turns 8 --post
```

`--post` commands **execution as well as writing**: without it the loop reads and
runs nothing. And the guardrail that matters is not the budget but
`--budget-sans-progres` (40 $ by default): what you tolerate spending without a
single objective being proven. Neither dollars nor turns measure progress; that
one does.

A loop started in the background of a terminal dies with it. Detach it:

```bash
nohup orchestrator chapter --objective 42 --budget 60 --post \
  > chapter-42.log 2>&1 < /dev/null & disown
```

## Commands

```
orchestrator serve            the interface and the API
orchestrator chapter          the loop: judge, execute, prove, report
orchestrator plan --watch     break a free-form brief into provable steps
orchestrator do <harness>     a single instruction, outside the loop (--probe: no objective)
orchestrator agents:check     establish what is reachable on this machine
orchestrator inventory        what the repository actually contains
orchestrator prove <id> <key> run a declared proof and file it as evidence
orchestrator import <json>    restore an export
orchestrator where            where the database lives
```

`orchestrator` with no argument lists everything else.

## Development

```bash
npm run dev          # interface with hot reload
npm run build        # builds the interface into public/
npm test             # the gate rules, locked down
```

The tests cover what must never give way: the conditions under which an objective
closes, and how verdicts are read. A rule loosened by accident is a promise
broken.

Note for contributors: the code comments, the CLI output and the interface are in
French. The README is not.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free for any **noncommercial
purpose**: study, personal projects, public research, schools, charities,
government. Any commercial use needs a separate license; get in touch.

This is **not** an open source license under the OSI definition, which forbids
restricting fields of use — it is source available, readable and modifiable,
under a noncommercial condition.

© 2026 Chaibi Alaa
