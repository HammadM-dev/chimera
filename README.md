<div align="center">

<img src="docs/assets/hero.svg" alt="CHIMERA — build, run and govern teams of AI agents. A brief moving through a researcher, the Governor, a summariser, an approval gate, and out to a file on disk." width="1000">

<br>

[![Linux](https://img.shields.io/badge/Linux-AppImage-4a8fd4?style=for-the-badge&logo=linux&logoColor=white)](#install)
[![macOS](https://img.shields.io/badge/macOS-Apple%20silicon%20%26%20Intel-4a8fd4?style=for-the-badge&logo=apple&logoColor=white)](#install)
[![Windows](https://img.shields.io/badge/Windows-portable-4a8fd4?style=for-the-badge&logo=windows&logoColor=white)](#install)

[![Electron](https://img.shields.io/badge/Electron-43-161614?style=flat-square&logo=electron&logoColor=9feaf9)](https://electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-161614?style=flat-square&logo=typescript&logoColor=3178c6)](https://typescriptlang.org)
[![SQLite](https://img.shields.io/badge/storage-local%20SQLite-161614?style=flat-square&logo=sqlite&logoColor=87cee8)](https://sqlite.org)
[![MCP](https://img.shields.io/badge/tools-Model%20Context%20Protocol-161614?style=flat-square)](https://modelcontextprotocol.io)
[![Local first](https://img.shields.io/badge/data-never%20leaves%20your%20machine-5aa76f?style=flat-square)](#your-data)
[![Status](https://img.shields.io/badge/status-early%20access%20·%20v0.1.0-d9a441?style=flat-square)](#project-status)

**[Install](#install)** · **[What it does](#what-it-does)** · **[How it works](#how-it-works)** · **[Safety](#what-stops-an-agent)** · **[Agents](#the-agents-you-start-with)** · **[FAQ](#frequently-asked)**

</div>

---

## What CHIMERA is

A **desktop application for putting teams of AI agents to work on real jobs.**

You join agents together on a canvas, point them at a task, and press run. Each
agent is a model with an instruction, a set of tools, and limits it cannot
exceed. What one finds, the next one gets. Every model call and every tool call
passes through a governor that can refuse it, and everything that happened is
written down.

It runs on your machine. Your workflows, runs, traces and API keys stay in a
local database and an OS keychain — there is no CHIMERA server, no account, and
nothing is sent anywhere except the model calls you configure. Point it at
Ollama and nothing leaves at all.

> **Early access, v0.1.0.** It does real work and is tested against live models
> on every change. It is also young, and the surfaces still move. See
> [project status](#project-status) for what is finished and what is not.

---

## Install

One line. No admin rights, nothing outside your home directory, no package
manager.

**Linux and macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/HammadM-dev/chimera/main/scripts/install.sh | sh
```

**Windows** — PowerShell

```powershell
irm https://raw.githubusercontent.com/HammadM-dev/chimera/main/scripts/install.ps1 | iex
```

Then:

```sh
chimera
```

<details>
<summary><b>What the installer actually does</b></summary>

<br>

It reads this repository's latest release, picks the asset matching your system
and architecture, puts it under `~/.local/share/chimera` (or
`%LOCALAPPDATA%\Programs\CHIMERA`), and leaves a `chimera` command on your PATH.
Nothing else is touched.

It is a terminal installer for a reason beyond convenience. macOS refuses to
open an app downloaded by a browser that is not signed by a paid Developer ID —
Gatekeeper reads the `com.apple.quarantine` attribute the browser attaches, and
there is no "open anyway" a normal person will find. Windows shows the same
class of warning through SmartScreen. Neither attribute is set by `curl`. So
this path works today, and signing can arrive later without changing anything
you type.

To remove it, delete that folder and the `chimera` shim. There is no uninstaller
because there is nothing else to undo.

</details>

<details>
<summary><b>Updates</b></summary>

<br>

CHIMERA checks for a new version shortly after launch and every six hours. When
one exists it says so in a strip across the top — it does not download anything
until you say so, and it never installs on quit behind your back. Pressing
install downloads the new version and restarts into it.

Update metadata is published with each release, so the app reads the same feed
this page links to. A build that cannot install an update — a checkout, or a
development run — says so rather than offering a button that does nothing.

</details>

---

## What it does

<div align="center">
  <img src="docs/assets/build.gif" alt="Two agents placed on a canvas, joined together, given instructions, and run — producing a written comparison" width="880">
</div>

<br>

Drag the agents that will do the job onto the canvas. Join them to say what runs
after what. Write the brief, press run, and read what came back.

Agents can **read folders you grant them**, **browse the live web**, **drive a
real browser** on sites with no API, **run shell commands**, **use your
connected apps**, and **write files you can open afterwards**. Every call is
recorded — what was asked for, what it cost, what came back, and what was
refused.

### The pieces you build with

<div align="center">
  <img src="docs/assets/nodes.svg" alt="Agent, branch, loop, fan-out, approval, swarm, transform and nested automation, each described in a card" width="880">
</div>

---

## How it works

### One agent, one turn

<div align="center">
  <img src="docs/assets/loop.svg" alt="The agent loop: plan, act, observe, verify, then either go round again or finish" width="880">
</div>

<br>

An agent plans its next move, calls a tool, reads what came back, and then
checks whether the job is actually done. That last step is a real check rather
than the model agreeing with itself: where a step has an output contract, the
contract is enforced; and an answer that cites **none** of the identifiers its
tools returned is challenged and sent round again.

That challenge exists because of a real failure. Asked to report the fields of a
record it had fetched, a model invented an eleven-field order for a customer who
does not exist, wrote _"values copied exactly as they appeared in the
response"_, and then checked its own arithmetic to confirm the total was
consistent. All of it was coherent. None of it was in the response. Nothing in a
loop made of one model can disagree with that, so the check is mechanical.

### Every call goes through the Governor

<div align="center">
  <img src="docs/assets/governor.svg" alt="Agents on the left, the Governor in the middle, providers and tools on the right — every path crosses the Governor, and a direct route is marked as not existing" width="880">
</div>

<br>

There is no bypass path, and that is structural rather than a convention: a
direct provider call outside the Governor is a build failure, enforced by a lint
rule. It holds the capability allowlists, the spend and step caps, the egress
rules and the approval gates — and it writes down every decision it made, so a
run that stopped can tell you which limit stopped it.

### Any provider, one interface

<div align="center">
  <img src="docs/assets/providers.svg" alt="One normalised interface above Anthropic, OpenAI, Google, OpenRouter, OmniRoute, Ollama and LM Studio" width="880">
</div>

<br>

|                     |                                                     |
| ------------------- | --------------------------------------------------- |
| **Hosted**          | Anthropic (Claude) · OpenAI (GPT) · Google (Gemini) |
| **Gateways**        | OpenRouter · OmniRoute                              |
| **On your machine** | Ollama · LM Studio                                  |
| **Anything else**   | any OpenAI-compatible endpoint, by URL              |

Provider differences live in adapters and nowhere above them, so changing model
is a dropdown rather than a rewrite. Prices and context windows are read from
the live catalogue, so the figure you are shown is the figure you are charged.
Pin the models you actually use and they sit at the top of every picker.

---

## What stops an agent

<div align="center">
  <img src="docs/assets/layers.svg" alt="Five layers: capability allowlist, egress allowlist, human approval, declared bounds, and prompt wording last" width="880">
</div>

<br>

The order matters. **An agent cannot misuse a tool it was never granted**, and
that is a stronger guarantee than any sentence in a prompt. Wording is the
outermost layer and the only one that can be argued with, so it is the last line
of defence rather than the first.

### Tool output is data, never instructions

<div align="center">
  <img src="docs/assets/untrusted.svg" alt="The instruction position built only from the role and workflow, separated by a barrier from tool output wrapped in untrusted-data delimiters" width="880">
</div>

<br>

A web page, an email, a file, an API response — anything a tool returns is
attacker-controllable. It is wrapped in a per-assembly nonce, labelled, and
handed back in the data position. The system message is assembled from a value
that tool output is not part of, so a reviewer checking that rule does not have
to trace call sites.

A corpus of prompt-injection payloads runs against every tool-enabled role on
every commit, including the case that matters most: **a model that believes the
injection still cannot act on it**, because the tool it would need was never
granted.

### Your data

- **Keys live in the OS keychain** — Keychain, Credential Manager, libsecret.
  Not in the database, not in logs, not in traces, not in error messages. Agents
  receive handles, never values.
- **Everything else is a local SQLite file** you can open, back up or delete.
- **A browser profile of its own.** Agents never drive your logged-in browser,
  because an agent in a session already signed into your bank and your email is
  a prompt injection away from using them.
- **Local-only mode** enforces no outbound model traffic at all.

---

## The agents you start with

Ten built-in roles, each with a tool grant chosen for the job rather than for
convenience. You can edit them, and write your own.

| Agent                | Tier     | Turns | What it holds                                                                                 |
| -------------------- | -------- | ----- | --------------------------------------------------------------------------------------------- |
| **Planner**          | frontier | 3     | `memory.recall` `notebook.list`                                                                 |
| **Researcher**       | balanced | 12    | `search.web` `http.request` `filesystem.readFile` `filesystem.listDirectory` `memory.*`         |
| **Coder**            | frontier | 25    | `filesystem.*` `shell.exec` `memory.*`                                                          |
| **Reviewer**         | frontier | 8     | `filesystem.readFile` `filesystem.listDirectory` `memory.recall`                                |
| **QA**               | balanced | 15    | `filesystem.*` `shell.exec` `memory.*`                                                          |
| **Data extractor**   | cheap    | 5     | `filesystem.readFile` `filesystem.listDirectory` `memory.*`                                     |
| **Browser operator** | frontier | 20    | `browser.*` `search.web`                                                                        |
| **App operator**     | balanced | 15    | `composio.*`                                                                                    |
| **Assistant**        | frontier | 10    | `workspace.*` `notebook.*` `memory.recall` `search.web` `http.request`                          |
| **Summariser**       | cheap    | 4     | `memory.recall`                                                                                 |

Note what the Reviewer holds: **read-only tools, deliberately.** It cannot change
what it is reviewing, so its opinion is never quietly also an edit. And the
Assistant can write notes but not memory — a note is a row on a board you are
looking at; a memory silently changes how later runs read.

Tiers are indirection, not model names. _Cheap_, _balanced_ and _frontier_ are
what a role asks for; which model each means is a workspace setting, so swapping
providers does not mean editing ten agents.

---

## Ask a crowd, not a model

<div align="center">
  <img src="docs/assets/swarm.gif" alt="A population of agents taking positions on a question and arguing it out, the graph moving as they change their minds" width="880">
</div>

<br>

Some questions are not well answered by one model answering once. Put a question
to a population of agents with different starting positions, give them a few
rounds, and read where they landed — **including who changed their mind and what
changed it.**

Most of them follow rather than think, which is what makes a crowd of hundreds
affordable: a threshold decides how many reason from scratch, and the rest move
through who listens to whom. The swarm can read up on the subject first, so the
argument is about something rather than about nothing.

---

## What people build with it

<table>
<tr>
<td width="50%" valign="top">

**Research and compare**

Read the live web, pull out the facts, hand them to a writer. Sources cited, or
an honest note about what could not be found.

</td>
<td width="50%" valign="top">

**Watch a folder**

A file lands, an automation runs, a result appears. Unattended, with a trace
proving what happened.

</td>
</tr>
<tr>
<td valign="top">

**Read the documents you already have**

Spreadsheets, Word, PDF, slides, zips — converted and read in a child process
with a time limit, because a parser reading a stranger's file is somebody else's
code.

</td>
<td valign="top">

**Drive sites with no API**

A real browser in a profile of its own. It fills forms, clicks through, reads
what came back — and never touches your logged-in session.

</td>
</tr>
<tr>
<td valign="top">

**Use the apps you already use**

Gmail, Slack, Sheets and hundreds more through Composio, with one connection per
agent so a mailbox agent cannot reach your calendar.

</td>
<td valign="top">

**Keep what was learned**

Notes you can read and edit, and a memory with vector search that later runs
draw on. Nothing is remembered silently.

</td>
</tr>
</table>

---

## Frequently asked

<details>
<summary><b>Is CHIMERA a cloud service?</b></summary>

<br>

No. It is a desktop application. There is no CHIMERA account and no CHIMERA
server. Workflows, runs, traces and keys live on your machine in a local SQLite
database and your OS keychain. The only outbound traffic is the model and tool
calls you configure.

</details>

<details>
<summary><b>Can I run it entirely with local models?</b></summary>

<br>

Yes. Point it at Ollama or LM Studio and no traffic reaches a model vendor.
There is a local-only workspace mode that enforces this rather than relying on
you to remember.

</details>

<details>
<summary><b>How is this different from LangChain, CrewAI or AutoGen?</b></summary>

<br>

Those are libraries you write code against. CHIMERA is an application you run.
The canvas, the governor, the traces, the approvals, the credential handling,
the injection defences and the cost accounting already exist — what you build is
a workflow, not a program. If you want a framework to build on, use a framework.
If you want the thing built, this is that.

</details>

<details>
<summary><b>What stops an agent doing something dangerous?</b></summary>

<br>

Layers, in this order: it holds only the tools its role needs; it can only reach
hosts on its allowlist; anything irreversible stops for a person; every loop
declares a bound the editor enforces at save time; and spend and step caps end a
run that overruns. Prompt wording is the last layer, not the first.

</details>

<details>
<summary><b>What does it cost to run?</b></summary>

<br>

Whatever your model provider charges, and nothing else. You bring your own keys.
Every run shows its cost as it goes, read from the provider's live catalogue
rather than a table that goes stale, and you can cap spend per run. With local
models it costs nothing.

</details>

<details>
<summary><b>Does it need an internet connection?</b></summary>

<br>

Only for hosted model calls and any web tools you use. With local models and no
web tools, no.

</details>

<details>
<summary><b>Which operating systems?</b></summary>

<br>

Linux, macOS (Apple silicon and Intel), and Windows. Every release is built and
smoke-tested on all three.

</details>

<details>
<summary><b>Is my API key safe?</b></summary>

<br>

It goes into your operating system's credential store and is never written to
the database, the logs, the run traces or an error message. Agents are handed a
handle rather than a value. There is a test asserting a secret never appears in
a trace, and another asserting the IPC layer logs the channel but not the
payload.

</details>

---

## Under the hood

| Layer          | Choice                   | Why                                                          |
| -------------- | ------------------------ | ------------------------------------------------------------ |
| Shell          | Electron 43              | Context isolation on, node integration off, sandbox on       |
| Core           | TypeScript, strict       | Engine, governor, agent runtime — no `any` without a reason  |
| Interface      | React + React Flow       | The canvas is a real graph, not a list pretending            |
| Storage        | SQLite (WAL) + sqlite-vec | One file you own, with vector search for memory              |
| Tools          | Model Context Protocol   | Internal servers, plus anything else that speaks MCP         |
| Secrets        | OS keychain only         | Never the database, never a log                              |
| Native control | Rust sidecar             | Confined to one binary, spawned over stdio                   |

Renderer and main talk only through a typed, versioned preload bridge. All
database access goes through one package. Provider differences exist only in
adapters. Each of those is enforced by a check that fails the build, not by a
paragraph in a style guide.

---

## Project status

**Early access — v0.1.0.** Honest state, milestone by milestone:

|     | Milestone                                                | State                                              |
| --- | -------------------------------------------------------- | -------------------------------------------------- |
| ✅  | Foundations, provider layer, agent runtime, Governor      | Complete                                           |
| ✅  | Swarm, browser control, triggers and observability        | Complete                                           |
| 🟡  | Automations                                               | 14 of 16 tickets                                   |
| 🟡  | Native desktop control                                    | TypeScript half built; the Rust sidecar is not     |
| 🟡  | Commercial — installers, updates, licensing               | Installers and updates work; licensing does not exist |
| ⬜  | Platform parity                                           | Built and smoke-tested on all three; not more      |

**What is genuinely not finished:** there is no licence file yet, the app is
unsigned so installation goes through the terminal, native desktop control is
half built, and the free built-in web search rate-limits under load — add a
search key in Providers if research matters to you.

Every change runs unit tests, an injection corpus, a full end-to-end suite
against a real Electron build, and a packaged-app smoke test on Linux, macOS and
Windows.

---

## Licence

Not yet settled. The intended licence is **BUSL 1.1** — source-available, with
commercial restrictions that lapse on a fixed date — and the grant wording is
with a lawyer. Until a `LICENSE` file lands here, the ordinary default applies:
all rights reserved. Read it, build it, run it; ask before anything else.

---

## Documentation

|                                                     |                                                            |
| --------------------------------------------------- | ---------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)       | Layers, processes, package boundaries, IPC, schema         |
| [`docs/SECURITY.md`](docs/SECURITY.md)               | Threat model, injection defence, credentials, sandboxing   |
| [`docs/WORKFLOW_SCHEMA.md`](docs/WORKFLOW_SCHEMA.md) | The workflow document contract                             |
| [`docs/TESTING.md`](docs/TESTING.md)                 | Test strategy, the mock provider, the injection corpus     |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                 | Milestones, as numbered tickets                            |
| [`docs/DISCOVERY.md`](docs/DISCOVERY.md)             | How this repository is meant to be found                   |
| [`CLAUDE.md`](CLAUDE.md)                             | The standing contract for this repository                  |

### Building from source

Node 22 recommended.

```sh
npm install
npm run lint && npm run typecheck && npm test
npm start --workspace @chimera/desktop
```

`npm run package --workspace @chimera/desktop` produces an installable artifact
for the platform you are on. `npm run format` must pass before a commit; CI
enforces it.

<br>

<div align="center">
<sub><b>CHIMERA</b> — AI agent teams you can actually leave running.</sub>
</div>
