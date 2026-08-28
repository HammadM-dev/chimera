// What the tour actually teaches.
//
// Content first, and separate from the machinery that shows it, because the
// hard part of a tutorial is not the overlay — it is knowing what a person
// needs to be told and in what order. Ten steps that each earn their place
// beats thirty that narrate the sidebar.
//
// Three rules held throughout:
//
//   Every step names the thing you would do next, not the thing on screen. "A
//   run is where you find out what it cost" is worth reading; "this is the Runs
//   section" is a label somebody can already see.
//
//   The order is the order somebody actually works in — build, run, read the
//   result — rather than the order the sidebar happens to be in. A tour that
//   walks a menu top to bottom is a menu being read aloud.
//
//   Nothing here promises a feature that is not there. A tutorial is the first
//   thing a new user trusts, and the first place they find out whether they
//   should.

export type TourView =
  | 'home'
  | 'build'
  | 'runs'
  | 'agents'
  | 'swarm'
  | 'apps'
  | 'notes'
  | 'memory'
  | 'providers'
  | 'chat';

export interface TourStep {
  /** Which section to open before showing this. */
  view: TourView;
  /** The element to point at. A `data-testid`, or '' to sit in the middle. */
  target: string;
  title: string;
  /** Two or three sentences. Longer than that and nobody finishes it. */
  body: string;
  /** The one thing to try here, when there is one. */
  tip?: string;
  /**
   * Something the person has to actually do before the tour will move on.
   *
   * Only the last step uses it. A tour somebody finishes having done nothing is
   * a tour they have forgotten by the next screen, and pinning is the single
   * setting that most improves the next hour: a router connection puts several
   * hundred models in every dropdown and the two anybody uses are in the middle
   * of it.
   */
  requires?: 'pinnedModel';
}

export const TOUR: TourStep[] = [
  {
    view: 'home',
    target: '',
    title: 'CHIMERA runs teams of agents for you',
    body: 'An agent is a model with a job, a set of tools, and limits it cannot exceed. You join a few of them together into an automation, press run, and read what came back. Everything else here exists to make that safe to leave running.',
    tip: 'This takes about two minutes. You can stop at any point and pick it up again from Home.',
  },
  {
    view: 'home',
    target: 'home-input',
    title: 'Describe what you want and it gets designed',
    body: 'Type the job in plain words — “read my unpaid invoices and draft chasers” — and choose Design it for me. An automation is built on the canvas for you to look at before anything runs. Ask instead, and the assistant answers questions about this workspace: what a run cost, which agents can send email, what it has remembered.',
    tip: 'Nothing here spends money until you press run.',
  },
  {
    view: 'build',
    target: 'palette',
    title: 'Automations are built by dragging agents onto a canvas',
    body: 'Each block is one agent doing one job. Lines say what runs after what: left side takes input, right side sends output on. Branches, loops, fan-outs and approval gates are in the same palette.',
    tip: 'Drag a Researcher onto the canvas, then click it — that is where you choose its model.',
  },
  {
    view: 'build',
    target: 'brief-input',
    title: 'The brief is what the whole automation is working on',
    body: 'It reaches the first step and any step you have not given its own instruction. Attach files here too — contracts, invoices, a spreadsheet — and the agents read them.',
    tip: 'A step with its own instruction still gets the brief. It is context, not a replacement.',
  },
  {
    view: 'agents',
    target: '',
    title: 'Agents are editable, and their limits are the real protection',
    body: 'Every agent carries a prompt, a list of tools it may call, and caps on turns and spend. An agent cannot misuse a tool it was never granted — that is a limit enforced in the engine, not a request in a prompt. You can change the ones CHIMERA ships and write your own.',
    tip: 'Anything that sends, buys, publishes or deletes stops for your approval before it happens.',
  },
  {
    view: 'runs',
    target: '',
    title: 'Every run is kept, with what it cost and what it did',
    body: 'Each one records every model call, every tool call, and the result of each step. When something goes wrong this is where the answer is — not in a summary of what went wrong, but in the actual sequence.',
    tip: 'Costs add up by automation, by agent and by model, so you can see where the money goes.',
  },
  {
    view: 'apps',
    target: '',
    title: 'Connect the apps you already use',
    body: 'One Composio account puts Gmail, Slack, Notion, Jira, HubSpot and several hundred others behind a single sign-in. The sign-in happens on that app’s own site — CHIMERA never sees the password, and the token stays with Composio rather than reaching this machine.',
    tip: 'Point each App operator at particular apps and it is given only those. The one reading your mail then has no Slack tool to misuse — that is a limit in the engine, not a line in a prompt.',
  },
  {
    view: 'swarm',
    target: '',
    title: 'Put something to a simulated crowd',
    body: 'A swarm writes a cast of people with genuinely different starting views, reads up on your question first, and lets them argue for a few rounds. Watch the graph while it runs: each dot is a person, the ring means they think for themselves, and the colour is their opinion changing as answers land.',
    tip: 'Two dials decide the bill. “People” is how many exist; “Ask everyone up to” is how many get a real model call — above it the rest follow by arithmetic, and the report always says which happened.',
  },
  {
    view: 'notes',
    target: '',
    title: 'A board you and your agents both write on',
    body: 'The only surface here with two kinds of author. You write on it, and so can the assistant and your automations — a licence expiring, something to chase, anything noticed mid-run gets left where you will find it instead of buried in a trace nobody opens.',
    tip: 'A line an agent left says so underneath it; yours are unmarked. You can edit or delete any of it whoever wrote it.',
  },
  {
    view: 'memory',
    target: '',
    title: 'What the agents have learned, in the open',
    body: 'Different from Notes, and the difference matters: Notes is written for you, Memory is written for prompts. This is what agents recorded so a later run starts better informed, and every entry carries who wrote it and how sure they were.',
    tip: 'When an agent keeps getting something wrong, look here first. A bad memory is a row you delete, not a mystery you debug.',
  },
  {
    view: 'chat',
    target: '',
    title: 'Test a model before you build on it',
    body: 'A direct conversation with one provider, with the token count and cost of every exchange underneath it. Worth doing when a model is new to you, and worth doing first when an automation behaves oddly — it is the fastest way to tell whether the model or the automation is at fault.',
    tip: 'The cost line here is the same arithmetic the Governor uses to enforce a spend cap, so what you see is what a run would be charged.',
  },
  {
    view: 'providers',
    target: '',
    title: 'Where models come from, and what they cost',
    body: 'Connect Anthropic, OpenAI, Google, OpenRouter, or a local Ollama or LM Studio. Keys go to your operating system’s keychain — never the database, the logs, a run trace, or an agent’s prompt. Each connection lists its models with real prices and context windows, so a choice is informed rather than a guess at a name.',
    tip: 'A model with no published price shows as “Unpriced”, and the Governor will not enforce a spend cap on a price nobody verified. Prefer a priced model for anything that runs unattended.',
  },
  {
    // The one step that asks for something rather than explaining something.
    //
    // Last, and interactive, because a tour people finish having done nothing
    // is a tour they forget by the next screen. Pinning is also the single
    // setting that most improves the next hour of use: a router connection
    // puts four hundred models in every dropdown, and the two anybody uses are
    // somewhere in the middle of it.
    view: 'providers',
    target: 'catalogue-models',
    title: 'Pin the models you will actually use',
    body: 'Open a connection below and press Pin next to a model. Pinned models sit at the top of every picker — the canvas, the swarm, the chat — under their own heading, in the order you pinned them.',
    tip: 'Pin at least one to finish. You can unpin from the same button, and pin more whenever you like.',
    requires: 'pinnedModel',
  },
];
