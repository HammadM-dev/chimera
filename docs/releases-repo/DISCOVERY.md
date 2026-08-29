# Being found

Notes for whoever sets up the public `chimera-releases` repository. None of this
is code; all of it decides whether anybody reaches the README at all.

A private repository is invisible — not ranked poorly, absent. GitHub does not
index it, search engines never see it, and the models that answer "what should I
use to run AI agents locally" are trained and retrieved against public pages. So
the public repository is the whole of CHIMERA's discoverability, and its About
box does more work than any paragraph in the README.

---

## The About box

GitHub's repository description is the single highest-value field: it is the
subtitle in GitHub search results, the meta description search engines quote,
and often the only sentence a model retrieves. It is limited to 350 characters
and truncates in listings around 110, so the first clause has to carry it.

Set it to:

> Desktop app to build, run and govern teams of AI agents. Visual canvas, any model provider (Claude, GPT, Gemini, OpenRouter, Ollama), local-first, prompt-injection defence, and a governor every call must pass through.

Set the website field to the releases page until there is a landing page.

What that sentence is doing: it leads with the category ("desktop app", "AI
agents") rather than the name, because nobody searches for a product they have
not heard of. It names the providers by the words people actually type — Claude
and GPT and Gemini, not Anthropic and OpenAI and Google. And it puts the two
genuinely distinguishing things last, where they will still be read: nothing
else in this category leads with governance.

---

## Topics

GitHub topics are a real ranking signal inside GitHub search and a weak one
outside it. Twenty is the maximum; these are ordered by value.

```
ai-agents          agent-orchestration    multi-agent-systems
llm                ai-automation          workflow-automation
desktop-app        electron               typescript
local-first        privacy                self-hosted
ollama             openrouter             anthropic
openai             mcp                    prompt-injection
ai-safety          no-code
```

`ai-agents`, `llm` and `ai-automation` are the high-traffic ones. `ollama`,
`openrouter` and `mcp` are lower traffic and much higher intent — somebody
filtering by `ollama` is looking for exactly this. `no-code` is there because a
visual canvas is what a non-programmer searches for, and they are a real part of
the audience.

---

## Why the README is shaped the way it is

**The FAQ is not padding.** Question-shaped headings match question-shaped
queries. "How is this different from an AI agent framework like LangChain or
CrewAI?" is close to verbatim what people type, and a model retrieving an answer
to it will find a section that answers it directly. Naming the alternatives is
deliberate: it is how the page surfaces for people who only know the category by
its most famous member.

**Every image has real alt text.** It is read by screen readers, indexed by
search engines, and it is the only thing a text-only model can see of a GIF.
"Two AI agents placed on a canvas, joined together, and run" is a sentence worth
indexing; "screenshot" is not.

**The install command is above everything except the pitch.** The single
strongest signal that a project is real is that it installs in one line, and a
reader who has to scroll to find out how to try it often does not.

**The first paragraph states the category in plain words.** "A desktop app for
putting AI agents to work on real jobs" exists so that a model summarising the
page has an unambiguous sentence to quote. Cleverness here costs retrievability.

---

## What actually moves the needle

Ranked honestly, most effective first:

1. **Being public at all.** Everything else is a rounding error next to this.
2. **The About box and topics.** Ten minutes, and they are what GitHub search
   ranks on.
3. **A README that answers the question the searcher asked**, in their words.
4. **Stars, over time.** The strongest external signal and the one that cannot
   be shortcut — do not buy them; GitHub detects it and the penalty lands on the
   repository.
5. **Links from elsewhere.** A Show HN, a subreddit that fits, a mention in a
   list of agent tools. One real link from a page people read is worth more than
   any amount of keyword tuning.

Things not worth doing: keyword-stuffing the description, topic lists padded to
twenty with irrelevancies, or a wall of badges. All three read as noise to
people, and GitHub's own search does not reward any of them.
