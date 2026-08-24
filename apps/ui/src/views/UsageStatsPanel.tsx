import type { JSX } from 'react';
import { useProfile } from '../useProfile.ts';

// The switch the setup screen promised was here.
//
// A consent given once during setup, in a flow people click through, is not
// consent anybody can act on later. The disclosure is repeated in full rather
// than summarised: somebody reading this months afterwards should not have to
// remember what a checkbox said on their first afternoon.

export function UsageStatsPanel(): JSX.Element {
  const { profile, save } = useProfile();

  if (profile === null) return <p className="agent-card__prompt">Loading.</p>;

  return (
    <div data-testid="usage-stats">
      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="usage-stats-enabled"
          checked={profile.usageStats}
          onChange={(event) => {
            void save({ usageStats: event.target.checked });
          }}
        />
        <span>Count this copy as an active install.</span>
      </label>

      <p className="agent-card__prompt">
        Once a day CHIMERA says “still here”: a random ID that means nothing outside this app, the
        version you are on, and your operating system. That is the whole message.
      </p>
      <p className="agent-card__prompt">
        It never sends your name, your automations, your prompts, what any agent read or wrote, your
        files, or your API keys. None of those leave this machine. The ID is not built from anything
        about you or your computer, so it cannot be tied back to you — it exists to answer “how many
        people use this”, and it cannot answer anything else.
      </p>
    </div>
  );
}
