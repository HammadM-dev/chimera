import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { firedInLastMinute, parseCron, type RunBrief, type Trigger } from '@chimera/core';
import { workflowsRepository } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';
import { startRun } from '../runs/service.ts';

// M9-1. What starts an automation when nobody is watching.
//
// One ticker for every schedule, one watcher per folder, one HTTP listener for
// every webhook. The alternative — a timer per trigger — drifts, wakes the
// machine more often, and makes "what is scheduled" something you have to
// reconstruct from a pile of handles.

interface Registration {
  workflowId: string;
  name: string;
  trigger: Trigger;
}

const registrations: Registration[] = [];
const watchers: fs.FSWatcher[] = [];
/** The minute each schedule last fired, so a ticker that runs twice fires once. */
const lastFired = new Map<string, number>();
let ticker: NodeJS.Timeout | undefined;
let webhookServer: Server | undefined;
let webhookPort = 0;

/** Recently seen files, so an editor writing in three bursts is one drop. */
const settling = new Map<string, NodeJS.Timeout>();
const SETTLE_MS = 750;

function keyOf(registration: Registration, index: number): string {
  return `${registration.workflowId}:${String(index)}`;
}

/**
 * Starts the automation a trigger belongs to.
 *
 * Reads the definition fresh each time rather than holding the one loaded at
 * registration: a schedule that kept firing last week's version of an
 * automation, silently, is the worst kind of bug — everything looks fine.
 */
function fire(registration: Registration, extra: { attachmentPath?: string } = {}): void {
  const db = getStore();
  const version = workflowsRepository.get(db, registration.workflowId);
  if (!version) return;

  let brief: RunBrief;
  try {
    brief = JSON.parse(version.definitionJson) as RunBrief;
  } catch {
    return;
  }

  // A dropped file is what the run is about, so it arrives the way an attached
  // file does — read here, at the moment it landed, and handed to the first
  // step as data.
  if (extra.attachmentPath !== undefined) {
    let content = '';
    let note = '';
    try {
      const stat = fs.statSync(extra.attachmentPath);
      if (stat.size > 2_000_000) {
        note = 'too large to read';
      } else {
        content = fs.readFileSync(extra.attachmentPath, 'utf8');
      }
    } catch {
      note = 'could not be read';
    }

    brief = {
      ...brief,
      attachments: [
        ...brief.attachments,
        {
          name: path.basename(extra.attachmentPath),
          path: extra.attachmentPath,
          kind: 'text',
          content,
          note,
        },
      ],
    };
  }

  try {
    startRun(brief, registration.trigger.kind);
  } catch {
    // A trigger that fires an automation the validator now refuses must not
    // take the whole trigger runtime down with it. The refusal is already
    // visible in the editor; a crashed scheduler would not be.
  }
}

function tick(): void {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);

  registrations.forEach((registration, index) => {
    if (registration.trigger.kind !== 'schedule') return;
    const { fields } = parseCron(registration.trigger.cron);
    if (!fields) return;

    const key = keyOf(registration, index);
    if (lastFired.get(key) === minute) return;

    if (firedInLastMinute(fields, now)) {
      lastFired.set(key, minute);
      fire(registration);
    }
  });
}

function watchFolder(registration: Registration, folder: string, dropOnly: boolean): void {
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(folder, { persistent: false }, (_event, filename) => {
      if (filename === null) return;
      const full = path.join(folder, filename.toString());

      // Debounced: a save from most editors is a rename, a write and a chmod,
      // and a run per filesystem event would start three.
      clearTimeout(settling.get(full));
      settling.set(
        full,
        setTimeout(() => {
          settling.delete(full);
          if (!fs.existsSync(full)) return;
          fire(registration, dropOnly ? { attachmentPath: full } : {});
        }, SETTLE_MS),
      );
    });
  } catch {
    // A folder that is not there yet is not an error worth stopping for: an
    // automation watching a drop folder on a drive that is not mounted should
    // start working when it is, not refuse to load.
    return;
  }

  watchers.push(watcher);
}

function startWebhookServer(): void {
  if (webhookServer) return;

  webhookServer = createServer((req, res) => {
    const token = (req.url ?? '').replace(/^\/hook\//, '').split('?')[0] ?? '';
    const match = registrations.find(
      (registration) =>
        registration.trigger.kind === 'webhook' && registration.trigger.token === token,
    );

    if (!match || token === '') {
      // The same answer either way: a 404 that distinguished "no such webhook"
      // from "wrong token" would let someone enumerate the tokens.
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    res.writeHead(202, { 'content-type': 'text/plain' }).end('Accepted');
    fire(match);
  });

  // Loopback only. A webhook listener on 0.0.0.0 would be a way to start
  // somebody's automations from their coffee shop's network.
  webhookServer.listen(0, '127.0.0.1', () => {
    webhookPort = (webhookServer?.address() as AddressInfo | null)?.port ?? 0;
  });
}

export interface TriggerSummary {
  workflowId: string;
  name: string;
  kind: Trigger['kind'];
  detail: string;
  /** The full URL for a webhook, so the user can paste it somewhere. */
  url: string;
}

/** What is armed right now, for the UI. */
export function listTriggers(): { triggers: TriggerSummary[]; webhookPort: number } {
  return {
    webhookPort,
    triggers: registrations.map((registration) => ({
      workflowId: registration.workflowId,
      name: registration.name,
      kind: registration.trigger.kind,
      detail:
        registration.trigger.kind === 'schedule'
          ? registration.trigger.cron
          : registration.trigger.kind === 'fileWatch' || registration.trigger.kind === 'folderDrop'
            ? registration.trigger.path
            : '',
      url:
        registration.trigger.kind === 'webhook' && webhookPort > 0
          ? `http://127.0.0.1:${String(webhookPort)}/hook/${registration.trigger.token}`
          : '',
    })),
  };
}

/**
 * Rebuilds every registration from what is saved.
 *
 * Called at startup and after every save. Rebuilding wholesale rather than
 * diffing: the set is small, and a diff that got one case wrong would leave a
 * watcher armed for an automation that no longer exists.
 */
export function reloadTriggers(): void {
  for (const watcher of watchers) watcher.close();
  watchers.length = 0;
  registrations.length = 0;

  const db = getStore();
  for (const summary of workflowsRepository.list(db)) {
    const version = workflowsRepository.get(db, summary.id);
    if (!version) continue;

    let brief: RunBrief;
    try {
      brief = JSON.parse(version.definitionJson) as RunBrief;
    } catch {
      continue;
    }

    for (const trigger of brief.triggers ?? []) {
      if (trigger.kind === 'manual') continue;
      const registration = { workflowId: summary.id, name: summary.name, trigger };
      registrations.push(registration);

      if (trigger.kind === 'fileWatch') watchFolder(registration, trigger.path, false);
      if (trigger.kind === 'folderDrop') watchFolder(registration, trigger.path, true);
      if (trigger.kind === 'webhook') startWebhookServer();
    }
  }

  const wantsSchedule = registrations.some(
    (registration) => registration.trigger.kind === 'schedule',
  );
  if (wantsSchedule && !ticker) {
    // Every 20 seconds, not every minute: a minute-resolution ticker that
    // drifts by a second misses a minute entirely, and the firing check is
    // already idempotent within a minute.
    ticker = setInterval(tick, 20_000);
    // Never the reason the app stays alive.
    ticker.unref?.();
  }
}

export function stopTriggers(): void {
  for (const watcher of watchers) watcher.close();
  watchers.length = 0;
  for (const timer of settling.values()) clearTimeout(timer);
  settling.clear();
  registrations.length = 0;
  if (ticker) clearInterval(ticker);
  ticker = undefined;
  webhookServer?.close();
  webhookServer = undefined;
  webhookPort = 0;
}

/** Test seam: fires the schedule check immediately rather than on the ticker. */
export function checkSchedulesNow(): void {
  tick();
}
