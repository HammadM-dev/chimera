<div align="center">

<img src="assets/mark.png" alt="CHIMERA" width="104" height="104">

# CHIMERA

### Build, run, and govern teams of AI agents — on your own machine

A desktop app for putting AI agents to work on real jobs. Join them together on a
canvas, point them at the task, and watch every model call and every tool call
pass through a governor that can refuse it.
Any model provider. Local models included. Your keys and your data never leave your machine.

<br>

[![Linux](https://img.shields.io/badge/Linux-AppImage-4a8fd4?style=flat-square&logo=linux&logoColor=white)](#install)
[![macOS](https://img.shields.io/badge/macOS-Apple%20silicon%20%26%20Intel-4a8fd4?style=flat-square&logo=apple&logoColor=white)](#install)
[![Windows](https://img.shields.io/badge/Windows-portable-4a8fd4?style=flat-square&logo=windows&logoColor=white)](#install)
[![Status](https://img.shields.io/badge/status-early%20access-d9a441?style=flat-square)](#project-status)

</div>

<br>

## Install

One line. No admin rights, nothing outside your home directory.

**Linux and macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/HammadM-dev/chimera-releases/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/HammadM-dev/chimera-releases/main/install.ps1 | iex
```

Then:

```sh
chimera
```

CHIMERA updates itself from there — it tells you when a version is out,
downloads it when you say so, and restarts into it.

Prefer to download by hand? Every build is on the
[releases page](https://github.com/HammadM-dev/chimera-releases/releases). Linux gets an AppImage, macOS a zip, Windows a
portable exe.

<br>

## What it does

<div align="center">
  <img src="assets/build.gif" alt="Two AI agents placed on a canvas, joined together, and run — producing a written comparison" width="860">
</div>

Describe a job. Drag the agents that will do it onto a canvas, join them to say
what runs after what, press run. Each agent is a model with an instruction, a
set of tools, and limits it cannot exceed. What one finds, the next one gets.

Agents can read folders you grant them, browse the live web, drive a real browser
on sites with no API, run shell commands, use your connected apps, and write
files you can open afterwards. Everything is recorded — what was called, what it
cost, what came back.

<br>

## Why it is built this way

The hard part of running AI agents is not getting them to act. It is being able
to leave them running.

### Every call goes through the Governor

<div align="center">
  <img src="assets/governor.svg" alt="Agents on the left, the Governor in the middle, model providers and tools on the right — every path crosses the Governor, and a direct route is marked as not existing" width="860">
</div>

There is no bypass. It enforces capability allowlists, spend and step caps,
egress rules, and human approval for anything irreversible — and writes down
every decision it made.

### Tool output is data, never instructions

<div align="center">
  <img src="assets/untrusted.svg" alt="The instruction position built only from the role and workflow, separated by a barrier from tool output wrapped in untrusted-data delimiters" width="860">
</div>

A web page, an email, a file, an API response — anything a tool returns is
attacker-controllable. It is wrapped, labelled, and handed back as data, never
as instruction. And the wording is only the outer layer: an agent cannot misuse
a tool it was never granted, cannot reach a host off its allowlist, and cannot
do anything irreversible without a person. A corpus of prompt-injection payloads
runs against every tool-enabled role on every commit.

### Secrets stay in the keychain

API keys live in your OS credential store — Keychain, Credential Manager,
libsecret. Not in the database, not in logs, not in traces, not in error
messages. Agents get handles, never values.

<br>

## Ask a crowd, not a model

<div align="center">
  <img src="assets/swarm.gif" alt="A population of AI agents taking positions on a question and arguing it out, the graph moving as they change their minds" width="860">
</div>

Some questions are not answered well by one model answering once. Point a
population of agents at a question, give them different starting positions and a
few rounds, and read where they landed — including who changed their mind and
what changed it.

<br>

## Works with any provider

| | |
|---|---|
| **Hosted** | Anthropic (Claude) · OpenAI (GPT) · Google (Gemini) |
| **Gateways** | OpenRouter · OmniRoute |
| **Local** | Ollama · LM Studio |
| **Anything else** | any OpenAI-compatible endpoint, by URL |

Provider differences live in adapters, so swapping models is a dropdown rather
than a rewrite. Prices and context windows come from the live catalogue, so the
cost you are shown is the cost you pay.

<br>

## What people use it for

- **Research and compare** — read the live web, pull out the facts, hand them on
- **Watch a folder** — a file lands, an automation runs, a result appears
- **Read documents you already have** — spreadsheets, Word, PDF, slides, zips
- **Drive sites with no API** — a real browser in a profile of its own, never your logged-in one
- **Use your apps** — Gmail, Slack, Sheets and more, one connection per agent
- **Run unattended** — on a schedule or a trigger, with a trace proving what happened

<br>

## Frequently asked

**Is CHIMERA a cloud service?**
No. It is a desktop application. Workflows, runs, traces and keys stay on your
machine in a local SQLite database. Nothing is sent anywhere except the model
calls you configure.

**Can I run it with local models only?**
Yes. Point it at Ollama or LM Studio and no traffic reaches a model vendor.
There is a local-only mode that enforces it.

**How is this different from an AI agent framework like LangChain or CrewAI?**
Those are libraries you write code against. CHIMERA is an application you run —
the canvas, the governor, the traces, the approvals and the credential handling
already exist, and what you build is a workflow rather than a program.

**What stops an agent doing something dangerous?**
Layers, in order: it holds only the tools its role needs; it can only reach hosts
on its allowlist; anything irreversible stops for a human; every loop declares a
bound; and spend and step caps end a run that overruns. Prompt wording is the
last layer, not the first.

**Does it need internet?**
Only for model calls and web tools. With local models, no.

**Which operating systems?**
Linux, macOS (Apple silicon and Intel), and Windows.

**Is it free?**
It is in early access and free to install today. You bring your own model keys,
so what you pay is whatever your provider charges — nothing if you run locally.

<br>

## Project status

**Early access, version 0.1.0.** It does real work — the end-to-end suite runs
the whole product against live models on two different providers on every
change — but it is young and the surfaces are still moving. If something goes
wrong, the run trace will usually tell you where.

Found a bug or want something? [Open an issue](https://github.com/HammadM-dev/chimera-releases/issues).

<br>

<div align="center">
<sub>CHIMERA — AI agent teams you can actually leave running.</sub>
</div>
