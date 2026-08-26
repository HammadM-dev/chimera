import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { useConnections } from './useConnections.ts';
import { useProfile } from '../useProfile.ts';
import { greetingFor } from './greeting.ts';
import { Mark } from '../assets/brand/Mark.tsx';
import type { AutomationTemplate, StepKind, StepSettings } from './CanvasView.tsx';
import { useTemplates } from './useTemplates.ts';
import './views.css';

// The opening screen. One question, one input, and three ways in — because the
// first thing a person needs from an automation builder is somewhere to say
// what they want automated.

interface Props {
  /** Opens the canvas with a draft the planner built, or with a bare goal. */
  onDescribe: (description: string, template: AutomationTemplate | null) => void;
  onBrowseAgents: () => void;
}

const STARTERS = [
  'Summarise every PDF dropped in a folder',
  'Review each pull request and post findings',
  'Extract invoice totals into a spreadsheet',
];

export function HomeView({ onDescribe, onBrowseAgents }: Props): JSX.Element {
  const [description, setDescription] = useState('');
  const { choices } = useConnections();
  const [modelKey, setModelKey] = useState('');
  const [plan, setPlan] = useState<AutomationTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  // The conversation. The home screen was a box that designed an automation and
  // forgot you the moment it had; it is now somebody you can ask about your own
  // workspace, who can still design one.
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [asking, setAsking] = useState(false);
  const { profile } = useProfile();
  const templates = useTemplates();
  const [error, setError] = useState<string | null>(null);

  const design = useCallback(async () => {
    // The chosen model, not "whichever sorted first out of 211". Picking for
    // the user is what produced a 502: OmniRoute serves a catalogue far wider
    // than the providers any one person has connected, so the first entry
    // alphabetically is usually one their gateway cannot reach.
    const chosen = choices.find((choice) => choice.key === modelKey) ?? choices[0];
    if (!chosen) {
      setError('Connect a provider first — designing an automation is a model call.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await bridge().invoke<AutomationTemplate>('automation:plan', {
        connectionId: chosen.connectionId,
        model: chosen.model,
        description: description.trim(),
      });
      setPlan(result);
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, [choices, description, modelKey]);

  const ask = useCallback(async () => {
    const question = description.trim();
    if (question === '') return;

    const chosen = modelKey === '' ? choices[0] : choices.find((choice) => choice.key === modelKey);
    if (!chosen) {
      setError('Connect a provider first — Providers, then add one.');
      return;
    }

    setAsking(true);
    setError(null);
    setDescription('');
    const asked = [...turns, { role: 'user' as const, content: question }];
    setTurns(asked);

    try {
      const answer = await bridge().invoke<{
        text: string;
        plan: AutomationTemplate | null;
      }>('assistant:ask', {
        connectionId: chosen.connectionId,
        model: chosen.model,
        message: question,
        // Everything before this message. The newest one is the task.
        history: turns,
      });

      setTurns([...asked, { role: 'assistant', content: answer.text }]);
      // A design it made along the way, offered rather than applied.
      if (answer.plan !== null) setPlan(answer.plan);
    } catch (err) {
      setError(describeError(err).message);
      setTurns(turns);
      setDescription(question);
    } finally {
      setAsking(false);
    }
  }, [choices, description, modelKey, turns]);

  return (
    <section className="home" data-testid="home-view">
      <div className="home__welcome">
        {/* The mark sits above the greeting, at the size a signature is: big
            enough to be the thing you see first on an empty screen, small
            enough that the sentence under it is still the thing you read. */}
        <Mark size={44} className="home__mark" />
        <h1 className="home__greeting" data-testid="home-greeting">
          {greetingFor(new Date().getHours(), profile?.firstName ?? '')}
        </h1>
        <p className="home__sub">What should CHIMERA automate?</p>
      </div>

      {turns.length > 0 && (
        <div className="talk" data-testid="home-talk">
          {turns.map((turn, index) => (
            <p
              key={`${turn.role}-${String(index)}`}
              className={`talk__turn talk__turn--${turn.role}`}
              data-testid={`talk-${turn.role}`}
            >
              {turn.content}
            </p>
          ))}
          {asking && (
            <p className="talk__turn talk__turn--assistant talk__turn--waiting">Looking…</p>
          )}
        </div>
      )}

      <div className="home__composer">
        <textarea
          className="home__input"
          data-testid="home-input"
          rows={3}
          value={description}
          placeholder="Ask about your automations, agents, runs and notes — or describe something to build"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter sends, shift-enter breaks the line. The composer is a
            // conversation now, and a conversation you have to reach for a
            // button to continue is one people stop having.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
        />
        <div className="home__composer-actions">
          <div className="brief__left">
            <button type="button" className="button button--ghost" onClick={onBrowseAgents}>
              Browse agents
            </button>
            {choices.length > 0 && (
              <select
                className="chat__control"
                data-testid="home-model"
                aria-label="Model to design with"
                value={modelKey === '' ? (choices[0]?.key ?? '') : modelKey}
                onChange={(event) => {
                  setModelKey(event.target.value);
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.connectionLabel} · {choice.model}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="brief__left">
            <button
              type="button"
              className="button"
              data-testid="home-blank"
              disabled={description.trim() === ''}
              onClick={() => {
                onDescribe(description.trim(), null);
              }}
            >
              Start blank
            </button>
            <button
              type="button"
              className="button"
              data-testid="home-ask"
              disabled={asking || description.trim() === ''}
              onClick={() => void ask()}
            >
              {asking ? 'Looking' : 'Ask'}
            </button>
            <button
              type="button"
              className="button button--primary"
              data-testid="home-design"
              disabled={busy || description.trim() === ''}
              onClick={() => void design()}
            >
              {busy ? 'Designing' : 'Design it for me'}
            </button>
          </div>
        </div>
      </div>

      {error !== null && (
        <p className="connections__error" data-testid="home-error">
          {error}
        </p>
      )}

      {plan && (
        <section className="plan" data-testid="home-plan">
          <h2 className="plan__name">{plan.name}</h2>
          <p className="plan__summary">{plan.summary}</p>
          <ol className="plan__steps">
            {plan.steps.map((step, index) => (
              <li key={`${step.roleId}-${String(index)}`} className="plan__step">
                <span className="plan__index">{index + 1}</span>
                <span>
                  <span className="plan__role">{step.roleId}</span> — {step.instruction}
                </span>
              </li>
            ))}
          </ol>
          <div className="home__composer-actions">
            <span className="intro__status">
              {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}, ready to edit
            </span>
            <button
              type="button"
              className="button button--primary"
              data-testid="home-open-plan"
              onClick={() => {
                onDescribe(description.trim(), plan);
              }}
            >
              Open in Automations
            </button>
          </div>
        </section>
      )}

      {templates.length > 0 && (
        <section className="gallery" data-testid="home-templates">
          <h2 className="gallery__title">Or start from one of these</h2>
          <p className="gallery__sub">
            Each one opens on the canvas as an ordinary automation. Change anything.
          </p>
          <div className="gallery__grid">
            {templates.map((item) => (
              <button
                key={item.id}
                type="button"
                className="gallery__card"
                data-testid={`template-${item.id}`}
                onClick={() => {
                  onDescribe(item.summary, {
                    name: item.name,
                    summary: item.summary,
                    steps: item.steps.map((step) => ({
                      ...(step.id === undefined ? {} : { id: step.id }),
                      ...(step.kind === undefined ? {} : { kind: step.kind as StepKind }),
                      roleId: step.roleId,
                      instruction: step.instruction,
                      ...(step.settings === undefined
                        ? {}
                        : { settings: step.settings as Partial<StepSettings> }),
                    })),
                    ...(item.edges === undefined ? {} : { edges: item.edges }),
                    ...(item.egressAllowlist === undefined
                      ? {}
                      : { egressAllowlist: item.egressAllowlist }),
                    ...(item.egressMode === undefined ? {} : { egressMode: item.egressMode }),
                  });
                }}
              >
                <span className="gallery__name">{item.name}</span>
                <span className="gallery__audience">{item.audience}</span>
                <span className="gallery__summary">{item.summary}</span>
                {item.needs.length > 0 && (
                  <span className="gallery__needs">Needs: {item.needs.join('; ')}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="home__starters">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            type="button"
            className="home__starter"
            onClick={() => {
              setDescription(starter);
            }}
          >
            {starter}
          </button>
        ))}
      </div>
    </section>
  );
}
