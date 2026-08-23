import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutReasoning } from './normalised.ts';

// Several open-weight families put their working in <think> tags in the same
// field as the answer. Hammad watched a run finish and show him three
// paragraphs of a model talking itself in circles, then "</think>", then the
// answer.

test('a closed block of reasoning is removed', () => {
  const reply = '<think>Maybe the selector is wrong. Let us try again.</think>The price is £4,995.';
  assert.equal(withoutReasoning(reply), 'The price is £4,995.');
});

test('a reply that begins mid-thought loses everything up to the close', () => {
  // What arrives when the provider has already trimmed the opening tag, which
  // is the shape that reached the screen.
  const reply = [
    'We need to output final answer. The verification keeps failing.',
    'Let us try a different approach: maybe browser.read with no selector?',
    '</think>',
    'I have completed the steps: navigated to Autotrader and searched.',
  ].join('\n');

  const cleaned = withoutReasoning(reply);
  assert.equal(cleaned, 'I have completed the steps: navigated to Autotrader and searched.');
  assert.doesNotMatch(cleaned, /verification keeps failing/);
});

test('several blocks all go', () => {
  assert.equal(withoutReasoning('<think>one</think>A<think>two</think>B'), 'AB');
});

test('an ordinary answer is left exactly as it is', () => {
  const answer = 'The agreement renews on 28 February 2027.';
  assert.equal(withoutReasoning(answer), answer);
});

test('an answer that merely mentions thinking is not cut', () => {
  // No closing tag, so nothing is removed: cutting a real answer because of a
  // word in it would be worse than leaving a stray tag in a rare one.
  const answer = 'I think the renewal date is 28 February 2027.';
  assert.equal(withoutReasoning(answer), answer);
});
