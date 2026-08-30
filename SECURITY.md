# Security policy

CHIMERA runs AI agents that hold real credentials and can read files, reach the
network, drive a browser and run shell commands. Security is not a feature of
this product, it is the reason the product is shaped the way it is — so a
vulnerability report is welcome and will be taken seriously.

The engineering detail lives in [`docs/SECURITY.md`](docs/SECURITY.md): the
threat model, the prompt-injection defences, credential handling and the sandbox
boundaries. This file is about how to tell us when something is wrong.

---

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/HammadM-dev/chimera/security/advisories/new)**

That opens a private thread visible only to the maintainers. It is the right
channel for anything that could be exploited before a fix ships.

**What helps.** The version you are on, your operating system, what an attacker
would need to be able to do first, and the smallest reproduction you can manage.
A run trace is often the fastest way to show what happened — but read it before
attaching it, because it may contain your own data.

**Never include a real API key or credential in a report.** If you believe one
has leaked, revoke it first and say so; a revoked key in a report is evidence,
a live one is a second incident.

**What to expect.** An acknowledgement, an assessment of severity, and a fix or
a clear explanation of why something is working as intended. CHIMERA is early
access maintained by one person, so response times are honest rather than
contractual — but a report will not be ignored.

---

## What counts as a vulnerability here

This project's security model is unusual enough to be worth stating plainly, so
that reports land on the right side of the line.

### In scope, and taken seriously

| | |
| --- | --- |
| **Escaping the Governor** | Any path that reaches a model or a tool without an authorisation decision. There is meant to be no such path. |
| **Escaping a capability grant** | An agent invoking a tool its role's allowlist does not include. |
| **Escaping the egress allowlist** | Reaching a host the automation does not name, including via redirect, DNS rebinding, or an address form the parser mis-reads. |
| **Escaping the filesystem sandbox** | Reading or writing outside the run workspace and the folders the user granted — traversal, symlinks, race conditions. |
| **Bypassing an approval gate** | Performing an irreversible action without the human approval the workflow requires. |
| **Secret disclosure** | An API key or vault value appearing in the database, a log, a run trace, an error message, an exported artefact, or a prompt. |
| **Prompt injection that achieves something** | Content in a tool result that causes an agent to take an action it was not permitted to take. See below. |
| **Renderer escape** | Anything that gets code execution out of the renderer, or reaches Node from it other than through the typed preload bridge. |
| **Supply chain** | A dependency or build step that could introduce code into a release. |

### Prompt injection — where the line is

An agent **being persuaded** by injected content is not, by itself, a
vulnerability. The design assumes models can be fooled. What matters is whether
being fooled lets it do anything:

- **Not a vulnerability:** a web page convinces a researcher to try to email
  someone, and the attempt fails because that role holds no email tool.
- **A vulnerability:** injected content causes an action the role's grants,
  the egress allowlist or an approval gate should have prevented.

The corpus in `evals/injection/` runs against every tool-enabled role on every
commit and encodes exactly this distinction. New payloads that defeat it are
extremely welcome — as a pull request, if they fail cleanly, or privately if
they succeed.

### Out of scope

- **Your own model provider's behaviour.** What a model says is not something
  CHIMERA controls; what it is permitted to *do* is.
- **Cost.** A run that spends more than you expected is a bug and belongs in a
  public issue, not a security report — unless a cap was set and not honoured,
  which is in scope.
- **A user granting an agent dangerous tools deliberately.** Handing an agent a
  shell and a wide allowlist does what it says on the tin. The gates and caps
  are the mitigation, and reports that they can be *bypassed* are in scope.
- **Missing code signing.** Known, and stated in the README. Installation goes
  through the terminal precisely because the binaries are unsigned.
- Findings from automated scanners with no demonstrated impact.

---

## Supported versions

Early access. **The latest release is the supported one** — there are no
maintained branches behind it, and the fix for anything reported will land in
the next release rather than being backported.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything earlier | ❌ — update first |

---

## What CHIMERA already does about this

So a report can be aimed at the gap rather than at the design:

- **No bypass path to a model or a tool.** Every call goes through the Governor,
  and a direct provider call outside it fails the build via a lint rule.
- **Capability allowlists per role**, matched before a tool is invoked.
- **Egress allowlists**, applied to the first request and re-applied to every
  redirect hop, with private and loopback addresses refused when a host was
  reached by browsing rather than by being named.
- **Tool output in the data position only**, wrapped in a per-assembly nonce.
  The system message is assembled from a value tool output is not part of.
- **Secrets in the OS keychain**, never the database; agents receive handles.
- **Human approval for irreversible actions**, enforced at the last point before
  the call.
- **Declared bounds on every loop**, refused at save time if absent.
- **A hardened renderer**: context isolation on, node integration off, sandbox
  on, and a typed versioned IPC bridge as the only route to the system.
