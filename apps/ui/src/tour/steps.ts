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
    body: 'Gmail, Slack, Notion, Jira, HubSpot and several hundred others, through one Composio account. Sign in once here and an App operator step can act in them — and you can point each operator at particular apps, so the one reading your mail is not also the one that can post in Slack.',
    tip: 'Each app’s How button spells out exactly what signing in will ask you for.',
  },
  {
    view: 'swarm',
    target: '',
    title: 'Put something to a simulated crowd',
    body: 'A swarm writes a population of people with different starting views, tells them your question, and lets them influence each other for a few rounds. What comes back is where they landed and why. Useful for a price change, an announcement, a policy — anything where the disagreement is the finding.',
    tip: 'It always says whether every agent was asked directly or most of them followed the loud ones.',
  },
  {
    view: 'notes',
    target: '',
    title: 'A board you and your agents both write on',
    body: 'Notes and reminders. You write on it, and so can the assistant and your automations — something noticed during a run gets left where you will find it rather than buried in a trace. Anything on the board can be edited by you, whoever wrote it.',
    tip: 'Set a date and it becomes a reminder. Leave it blank and it stays a note.',
  },
  {
    view: 'memory',
    target: '',
    title: 'What the agents have learned, in the open',
    body: 'Separate from notes: this is what agents recorded so later runs work better, and every entry says who wrote it and how sure they were. You can read it and forget anything that is wrong.',
    tip: 'A wrong memory is a row to delete, not a mystery to debug.',
  },
  {
    view: 'providers',
    target: '',
    title: 'Where models come from, and what they cost',
    body: 'Connect Anthropic, OpenAI, Google, OpenRouter, or a local Ollama or LM Studio. Keys go into your operating system’s keychain and never into the database, the logs, or an agent’s prompt. Each connection lists its models with prices, so you can see what a run will cost before it does.',
    tip: 'Pin the models you actually use and they stay at the top of every picker.',
  },
  {
    view: 'chat',
    target: '',
    title: 'Test a model before you build on it',
    body: 'A direct conversation with one provider. Worth doing when a model is new to you, or when an automation behaves oddly and you want to know whether the model or the automation is at fault.',
    tip: 'That is the tour. Everything in it is reachable from the sidebar whenever you need it.',
  },
];
