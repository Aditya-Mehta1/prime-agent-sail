# Prime Agent + SAIL

Background agents on [Sail](https://docs.sailresearch.com), built as a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

At a high level, the goal is to have one _foreground_ agent which the user converses with, responsible for managing _background_ agents - which are responsible for implementation (eg PRs) à la [Cursor Projects](https://cursor.com/blog/projects).

The background agents:

- run with balanced inference
- run with their own copy of the project, in a Sailbox

The foreground agent:

- doesn't work on PRs etc itself
- instead it manages the bg agents:
  - breaks user requests into
  - can read their state and msg them / receive msgs
- maintains a project state, user intent, tasks do[ing|ne] etc - which is then shared w the bg agents

## How it works

- `rlm.dispatch()` - new RLM primitive that starts a background worker in its own Sailbox and sets up a repo copy.

```mermaid
flowchart LR
    U[User]
    subgraph Local["Local: Prime daemon"]
        F["Foreground agent<br/>Sail ASAP inference"]
        A["Worker A<br/>Sail Balanced inference"]
        B["Worker B<br/>Sail Balanced inference"]
        F <-->|Tasks, questions, results| A
        F <-->|Tasks, questions, results| B
    end
    subgraph Remote["Remote: Sailboxes"]
        SA["Box A<br/>Repo copy + Python REPL"]
        SB["Box B<br/>Repo copy + Python REPL"]
    end
    U <--> F
    A <-->|Run code / read output| SA
    B <-->|Run code / read output| SB
```

- `rlm.dispatch()` spawns a deepseek 4.1 flash subagent on Sail Balanced
- its harness / inferences / controller run on the local prime daemon [^1]
- each subagent's **REPL / file operations** work on Sailboxes which:
  - clone the working repo and workers can write PRs to it [^2]
  - autosleep when the agent is "idle"
  - when idled can be awoken by:
    - fg agent messaging the worker
    - cron jobs by the agent itself
- each worker is also an RLM:
  - it can spawn children via `rlm.spawn()` which work on the same box
  - it can message parents / children / siblings

[^1]: "separating the hands and the brain" has many benefits here [TODO - link to docs]

[^2]: gh auth using credential injection LINK https://docs.sailresearch.com/sailboxes-credentials

**Shared context:**

```text
/workspace/
├── <repository-name>/   cloned from main
└── inputs/
    ├── project_context/   PROJECT.md + project/
    └── <name>/          anything passed as inputs={'<name>': 'path'}
```

- the foreground maintains `PROJECT.md` and detailed notes in `project/`,
  - tracking user intent and dispatched work (both ongoing and completed)
  - shared with workers

- the fg agent can share arbitrary local files with workers too
- (prime agent skills are copied too)

## Workflows that "just work"

TODO

Crons
Many agents working
Agents returning PR

## Try it

```bash
npm ci
npm link
```

```bash
cd /path/to/project
prime-agent-sail
```

Needs macOS or Linux, Node 22.8+, and Sail API key
