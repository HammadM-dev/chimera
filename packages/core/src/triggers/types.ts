import { parseCron } from './cron.ts';

// What starts an automation when nobody presses Run.
//
// This is the difference the master plan calls "a tool someone opens" versus
// "infrastructure that runs the business", and every kind here is a promise
// that something happens without a person watching. Which is exactly why each
// one is validated hard at save time: a schedule that silently never fires is
// worse than no schedule, because the user believes it is running.

export type Trigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string }
  | { kind: 'webhook'; token: string }
  | { kind: 'fileWatch'; path: string }
  | { kind: 'folderDrop'; path: string };

export interface TriggerProblem {
  message: string;
}

/**
 * Everything wrong with a trigger, or nothing.
 *
 * Paths must be absolute: a relative one resolves against whatever the app's
 * working directory happens to be, which is not a place the user chose and is
 * different in development, in the packaged app, and when launched from a
 * desktop shortcut.
 */
export function validateTrigger(trigger: Trigger): TriggerProblem[] {
  switch (trigger.kind) {
    case 'manual':
      return [];

    case 'schedule': {
      const { fields, problem } = parseCron(trigger.cron);
      return fields ? [] : [{ message: problem }];
    }

    case 'webhook':
      return trigger.token.length >= 16
        ? []
        : [
            {
              message:
                'A webhook needs a long random token. Anything shorter is a URL somebody can guess.',
            },
          ];

    case 'fileWatch':
    case 'folderDrop':
      if (trigger.path.trim() === '') {
        return [{ message: 'Choose a folder to watch.' }];
      }
      if (!trigger.path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(trigger.path)) {
        return [
          {
            message: `"${trigger.path}" is not a full path. A watched folder has to be named from the root, or it means something different depending on where the app was started.`,
          },
        ];
      }
      return [];
  }
}

/** What a trigger says, in a sentence, for the UI and the run list. */
export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'When you press Run';
    case 'schedule':
      return `On a schedule: ${trigger.cron}`;
    case 'webhook':
      return 'When something posts to its webhook';
    case 'fileWatch':
      return `When anything changes in ${trigger.path}`;
    case 'folderDrop':
      return `When a file lands in ${trigger.path}`;
  }
}
