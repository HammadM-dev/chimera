<div align="center">

<img src="docs/assets/mark.png" alt="CHIMERA" width="104" height="104">

# CHIMERA

### Build, run, and govern teams of AI agents — on your own machine

Join agents together on a canvas, point them at real work, and watch every model
call and every tool call pass through a governor that can refuse it.
Any provider. Local models included. Your keys and your data never leave your machine.

<br>

[![Linux](https://img.shields.io/badge/Linux-AppImage-4a8fd4?style=flat-square&logo=linux&logoColor=white)](#install)
[![macOS](https://img.shields.io/badge/macOS-Apple%20silicon%20%26%20Intel-4a8fd4?style=flat-square&logo=apple&logoColor=white)](#install)
[![Windows](https://img.shields.io/badge/Windows-portable-4a8fd4?style=flat-square&logo=windows&logoColor=white)](#install)
<br>
[![Electron](https://img.shields.io/badge/Electron-43-161614?style=flat-square&logo=electron&logoColor=9feaf9)](https://electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-161614?style=flat-square&logo=typescript&logoColor=3178c6)](https://typescriptlang.org)
[![SQLite](https://img.shields.io/badge/storage-local%20SQLite-161614?style=flat-square&logo=sqlite&logoColor=87cee8)](https://sqlite.org)
[![Status](https://img.shields.io/badge/status-early%20access-d9a441?style=flat-square)](#project-status)

</div>

<br>

## Install

One line. No admin rights, nothing outside your home directory.

**Linux and macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/HammadM-dev/chimera/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/HammadM-dev/chimera/main/scripts/install.ps1 | iex
```

Then start it:

```sh
chimera
```

That is the whole installation. CHIMERA updates itself from then on — it tells you
when a version is out, downloads it when you say so, and restarts into it.

<br>

## What CHIMERA does

<div align="center">
  <img src="docs/assets/build.gif" alt="Placing two agents on the canvas, joining them, and running the automation to a result" width="860">
</div>

You describe a job. You drag the agents that will do it onto a canvas, join them
to say what runs after what, and press run. Each agent is a model with an
instruction, a set of tools, and limits it cannot exceed. What one finds, the
next one gets.

Agents can read the folders you grant them, browse the live web, drive a browser
on sites that have no API, run shell commands, use your connected apps, and write
files you can open afterwards. Everything they do is recorded — what was called,
what it cost, what came back.

<br>

## Why it is built this way

Most of the difficulty in running agents is not getting them to act. It is
being able to leave them running.

### Every call goes through the Governor

<div align="center">
  <img src="docs/assets/governor.svg" alt="Agents on the left, the Governor in the middle, model providers and tools on the right. Every arrow passes through the Governor, and a direct path from agents to tools is marked as not existing." width="860">
</div>

There is no bypass path. Not a convention — a structural one: a direct provider
call outside the Governor is a bug, and the tests treat it as one. It enforces
capability allowlists, spend and step caps, egress rules, and approval for
anything irreversible, and it writes down every decision it made.

### Tool output is data, never instructions

<div align="center">
  <img src="docs/assets/untrusted.svg" alt="Two boxes side by side. On the left, the instruction position, built only from the role and the workflow. On the right, tool output wrapped in untrusted-data delimiters. A barrier separates them, and three limits below show that a believed injection still cannot act." width="860">
</div>

A web page, an email, a file, an API response — anything a tool returns is
attacker-controllable. It is wrapped, labelled, and handed back in the data
position, never the instruction position. And the wording is only the outer
layer: an agent cannot misuse a tool it was never granted, cannot reach a host
that is not on its allowlist, and cannot do anything irreversible without a
person. A corpus of injection payloads runs against every tool-enabled role on
every commit, and that suite only grows.

### Secrets stay in the keychain

API keys live in your operating system's credential store — Keychain on macOS,
Credential Manager on Windows, libsecret on Linux. Not in the database, not in
logs, not in run traces, not in error messages. Agents receive handles, never
values.

<br>

## Ask a crowd, not a model

<div align="center">
  <img src="docs/assets/swarm.gif" alt="A population of agents taking positions on a question, the graph moving as they argue and change their minds" width="860">
</div>

Some questions are not answered well by one model answering once. Point a
population of agents at a question, give them different starting positions and
a couple of rounds, and read where they landed and why — including who changed
their mind, and what changed it.

<br>

## Works with any provider

| | |
|---|---|
| **Hosted** | Anthropic · OpenAI · Google |
| **Gateways** | OpenRouter · OmniRoute |
| **Local** | Ollama · LM Studio |
| **Anything else** | any OpenAI-compatible endpoint, by URL |

Provider differences live in adapters. Everything above them sees one normalised
interface, so a model swap is a dropdown, not a rewrite. Prices and context
windows come from the live catalogue, so the cost you are shown is the cost you
pay. Pin the models you actually use and they sit at the top of every picker.

<br>

## What you can build with it

- **Research and compare** — read the live web, pull the facts out, hand them on
- **Watch a folder** — a file lands, an automation runs, a result appears
- **Read the documents you already have** — spreadsheets, Word, PDF, slides, zips
- **Drive sites with no API** — a real browser, in a profile of its own, never your logged-in one
- **Use your apps** — Gmail, Slack, Sheets and the rest through Composio, one connection per agent
- **Keep notes and memory** — what agents learn is written down where you can read and edit it
- **Run unattended** — on a schedule or a trigger, with the trace to prove what happened

<br>

## Frequently asked

**Is this a cloud service?**
No. CHIMERA is a desktop application. Your workflows, runs, traces and keys stay
on your machine, in a local SQLite database. Nothing is sent anywhere except the
model calls you configure.

**Can I use local models only?**
Yes. Point it at Ollama or LM Studio and there is no outbound traffic to a model
vendor at all. There is a local-only mode that enforces it.

**How is this different from an agent framework?**
A framework is a library you write code against. CHIMERA is an application you
run: the canvas, the governor, the traces, the approvals and the credential
handling already exist, and the thing you build is a workflow rather than a
program.

**What stops an agent doing something stupid or dangerous?**
Layers, in this order: it is only granted the tools its role needs; it can only
reach hosts on its allowlist; anything irreversible stops for a human; every
loop declares a bound; and spend and step caps end a run that overruns. Prompt
wording is the last layer, not the first.

**Does it need an internet connection?**
Only for the model calls and any web tools you use. With local models, no.

**Which operating systems?**
Linux, macOS (Apple silicon and Intel) and Windows.

<br>

## Under the hood

| | |
|---|---|
| Shell | Electron, context isolation on, node integration off, sandbox on |
| Core | TypeScript, strict — engine, governor, agent runtime |
| Interface | React, with the canvas on React Flow |
| Storage | SQLite in WAL mode, with vector search for memory |
| Tools | Model Context Protocol, plus internal servers |
| Secrets | OS keychain only |

<br>

## Project status

**Early access, version 0.1.0.** It does real work — the end-to-end suite runs
the whole product against live models on two different providers on every
change — but it is young, and the surfaces are still moving. If you hit
something, the run trace will usually tell you exactly where it went wrong.

<br>

## Licence

Not yet settled. The intended licence is BUSL 1.1 — source-available, with
commercial restrictions that lapse on a fixed date — and the grant wording is
with a lawyer. Until a `LICENSE` file lands here, the ordinary default applies:
all rights reserved. Read it, build it, run it; ask before anything else.

<br>

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, processes, package boundaries, IPC, schema |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, injection defence, credentials, sandboxing |
| [`docs/WORKFLOW_SCHEMA.md`](docs/WORKFLOW_SCHEMA.md) | The workflow document contract |
| [`docs/TESTING.md`](docs/TESTING.md) | Test strategy, the mock provider, the injection corpus |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones, as numbered tickets |
| [`CLAUDE.md`](CLAUDE.md) | The standing contract for this repository |

### Building from source

Node 22 recommended.

```sh
npm install
npm run lint && npm run typecheck && npm test
npm start --workspace @chimera/desktop
```

`npm run package --workspace @chimera/desktop` produces an installable artifact
for the platform you are on.

<br>

<div align="center">
<sub>CHIMERA — agent teams you can actually leave running.</sub>
</div>
