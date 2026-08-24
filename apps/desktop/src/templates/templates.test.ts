import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STARTER_ROLES } from '@chimera/core';
import { listTemplates, setTemplateDirectory, type ShippedTemplate } from './service.ts';

// CLAUDE.md: "Every shipped template runs as a golden eval on each commit."
//
// A template is the first thing a new user touches, and it is the one part of
// this product where a mistake is silent: a step naming an agent that does not
// exist is skipped when the canvas builds it, so the automation simply arrives
// with a hole in it and runs anyway, producing something plausible and wrong.
// Nothing in the type system catches that — the file is valid JSON either way.

const templatesDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'templates');
setTemplateDirectory(templatesDir);

const { templates } = listTemplates();
const roleIds = new Set(STARTER_ROLES.map((role) => role.id));

/** The node kinds the canvas can build. Anything else arrives as nothing. */
const KINDS = new Set([
  'agent',
  'condition',
  'loop',
  'transform',
  'approval',
  'subworkflow',
  'fanout',
  'aggregate',
  'swarm',
]);

test('there are templates, and they were read', () => {
  assert.ok(
    templates.length >= 10,
    `expected the shipped library, found ${String(templates.length)} — is the path right?`,
  );
});

test('every template names agents this build actually ships', () => {
  const problems: string[] = [];
  for (const template of templates) {
    for (const step of template.steps) {
      const kind = step.kind ?? 'agent';
      if (kind !== 'agent') continue;
      if (!roleIds.has(step.roleId)) {
        problems.push(`${template.id}: step "${step.id ?? '?'}" wants agent "${step.roleId}"`);
      }
    }
  }
  // Skipped silently by the canvas, so the automation arrives with a hole in it
  // and runs anyway. This is the failure worth a test.
  assert.deepEqual(problems, []);
});

test('every non-agent step is a kind the canvas can build', () => {
  const problems: string[] = [];
  for (const template of templates) {
    for (const step of template.steps) {
      const kind = step.kind ?? 'agent';
      if (!KINDS.has(kind)) problems.push(`${template.id}: unknown kind "${kind}"`);
      // An agent step needs an agent; every other kind must not name one, since
      // a fan-out with a roleId reads as a mistake somebody will copy.
      if (kind !== 'agent' && step.roleId !== '') {
        problems.push(`${template.id}: ${kind} step names agent "${step.roleId}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every edge joins two steps that exist', () => {
  const problems: string[] = [];
  for (const template of templates) {
    const ids = new Set(template.steps.map((step, index) => step.id ?? `step-${String(index)}`));
    for (const [from, to] of template.edges ?? []) {
      if (!ids.has(from)) problems.push(`${template.id}: edge from unknown step "${from}"`);
      if (!ids.has(to)) problems.push(`${template.id}: edge to unknown step "${to}"`);
      if (from === to) problems.push(`${template.id}: step "${from}" is joined to itself`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every step is reachable, and the graph goes somewhere', () => {
  const problems: string[] = [];
  for (const template of templates) {
    if ((template.edges ?? []).length === 0) continue; // A list runs in order.

    const ids = template.steps.map((step, index) => step.id ?? `step-${String(index)}`);
    const targets = new Set((template.edges ?? []).map(([, to]) => to));
    const sources = new Set((template.edges ?? []).map(([from]) => from));

    const entries = ids.filter((id) => !targets.has(id));
    const exits = ids.filter((id) => !sources.has(id));

    if (entries.length === 0)
      problems.push(`${template.id}: every step has an input — it is a cycle`);
    if (exits.length === 0)
      problems.push(`${template.id}: every step feeds another — no last step`);
    // An island is a step nobody feeds and which feeds nobody: it runs, costs
    // money, and its answer reaches nothing.
    for (const id of ids) {
      if (!targets.has(id) && !sources.has(id) && ids.length > 1) {
        problems.push(`${template.id}: step "${id}" is joined to nothing`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('a loop or fan-out declares its bound', () => {
  // CLAUDE.md: "No unbounded loops. Every loop node declares max iterations, an
  // exit condition, or a verified-goal predicate."
  const problems: string[] = [];
  for (const template of templates) {
    for (const step of template.steps) {
      const settings = step.settings ?? {};
      if (step.kind === 'loop' && typeof settings['maxIterations'] !== 'number') {
        problems.push(`${template.id}: loop "${step.id ?? '?'}" declares no maximum`);
      }
      if (step.kind === 'fanout') {
        if (typeof settings['maxItems'] !== 'number') {
          problems.push(`${template.id}: fan-out "${step.id ?? '?'}" declares no maxItems`);
        }
        if (typeof settings['concurrency'] !== 'number') {
          problems.push(`${template.id}: fan-out "${step.id ?? '?'}" declares no concurrency`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('a template that sends anything asks a person first', () => {
  // CLAUDE.md: "Irreversible actions require a gate." A template is the one
  // place a user has not read the instructions, so a shipped one that emails
  // strangers on their behalf without an approval node is the worst version of
  // that mistake — it is our mistake, shipped, on their account.
  const problems: string[] = [];
  let examined = 0;

  // Sentence-initial, because these instructions are written as imperatives and
  // the bare verbs are far too common in prose. The first version matched
  // "publish" anywhere and flagged a research step that said "where a company
  // does not publish prices, say so" — a step that sends nothing and was being
  // careful. A test that cries wolf about the safest instruction in the library
  // is one somebody eventually silences.
  const imperative = /(?:^|[.!?]\s+)(send|reply to|publish|post)\b/i;

  for (const template of templates) {
    const sending = template.steps.filter(
      (step) => (step.kind ?? 'agent') === 'agent' && imperative.test(step.instruction),
    );
    if (sending.length === 0) continue;
    examined += 1;

    const hasGate = template.steps.some((step) => step.kind === 'approval');
    if (!hasGate) {
      problems.push(
        `${template.id}: steps ${sending.map((step) => `"${step.id ?? '?'}"`).join(', ')} send something, and no approval node stands before them`,
      );
    }
  }
  assert.deepEqual(problems, []);

  // A rule that never looks at anything passes for the wrong reason. If the
  // detector stops matching — a template rewords its send step, the regex is
  // tightened once too often — this says so instead of going quietly green.
  assert.ok(
    examined >= 2,
    `the gate rule examined ${String(examined)} templates; it should see the sending ones`,
  );
});

test('every template says what it is, who it is for, and what it needs first', () => {
  const problems: string[] = [];
  for (const template of templates) {
    if (template.name.trim() === '') problems.push(`${template.id}: no name`);
    if (template.audience.trim() === '') problems.push(`${template.id}: no audience`);
    if (template.summary.trim().length < 40) {
      problems.push(`${template.id}: the summary is too short to choose by`);
    }
    // `needs` may be empty — plenty need nothing — but a template that reads a
    // folder or a mailbox has to say so before somebody picks it and watches it
    // fail. Checked against what its instructions actually do.
    const text = template.steps.map((step) => step.instruction).join(' ');
    const wantsFolder = /granted (folder|invoices folder)|granted folder/i.test(text);
    const wantsMail = /\binbox\b|\bmailbox\b|unread messages/i.test(text);
    const needs = template.needs.join(' ').toLowerCase();
    if (wantsFolder && !needs.includes('folder')) {
      problems.push(`${template.id}: reads a granted folder and does not say so in needs`);
    }
    if (wantsMail && !needs.includes('email')) {
      problems.push(`${template.id}: reads a mailbox and does not say so in needs`);
    }
  }
  assert.deepEqual(problems, []);
});

test('ids are unique, and the file name matches the id', () => {
  const seen = new Set<string>();
  for (const template of templates) {
    assert.equal(seen.has(template.id), false, `duplicate template id "${template.id}"`);
    seen.add(template.id);
  }
});

test('the library covers more than one kind of person', () => {
  // Ten templates for developers is a library for developers. The point of
  // shipping a set is that somebody who is not a developer finds one too.
  const audiences = new Set<ShippedTemplate['audience']>(
    templates.map((template) => template.audience.toLowerCase()),
  );
  assert.ok(audiences.size >= 8, `only ${String(audiences.size)} distinct audiences`);
});
