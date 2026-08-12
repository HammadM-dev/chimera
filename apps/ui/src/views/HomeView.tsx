import { useState } from 'react';
import type { JSX } from 'react';
import './views.css';

// The opening screen. One question, one input, and three ways in — because the
// first thing a person needs from an automation builder is somewhere to say
// what they want automated.

interface Props {
  onDescribe: (description: string) => void;
  onBrowseAgents: () => void;
}

const STARTERS = [
  'Summarise every PDF dropped in a folder',
  'Review each pull request and post findings',
  'Extract invoice totals into a spreadsheet',
];

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomeView({ onDescribe, onBrowseAgents }: Props): JSX.Element {
  const [description, setDescription] = useState('');

  return (
    <section className="home" data-testid="home-view">
      <div>
        <h1 className="home__greeting">{greeting(new Date().getHours())}</h1>
        <p className="home__sub">What should CHIMERA automate?</p>
      </div>

      <div className="home__composer">
        <textarea
          className="home__input"
          data-testid="home-input"
          rows={3}
          value={description}
          placeholder="Describe the automation — what should happen, and what should be checked before it counts as done"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <div className="home__composer-actions">
          <button type="button" className="button button--ghost" onClick={onBrowseAgents}>
            Browse agents
          </button>
          <button
            type="button"
            className="button button--primary"
            data-testid="home-build"
            disabled={description.trim() === ''}
            onClick={() => {
              onDescribe(description.trim());
            }}
          >
            Start building
          </button>
        </div>
      </div>

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
