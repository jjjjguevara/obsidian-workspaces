import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  captureCompletionEndpoint,
  assertCompletionEndpoint,
} = require('../obsidian/completion-endpoint.cjs');
const { sample } = require('../obsidian/benchmark-test-fixtures.cjs');

test('completion capture is synchronous, copied and deeply immutable before later hydration', async () => {
  const record = sample();
  let time = 90;
  const source = structuredClone(record.completionEndpoint);
  source.views[1].content = 'stale source bytes';
  const captured = captureCompletionEndpoint({ now: () => time++, read: () => source });
  source.views[1].content = record.endpointExpected.notes['shared.md'];
  await Promise.resolve();
  assert.equal(captured.views[1].content, 'stale source bytes');
  assert.equal(Object.isFrozen(captured.views[1]), true);
  assert.throws(
    () => assertCompletionEndpoint(captured, record.endpointExpected),
    /stale or missing bytes/,
  );
});

test('completion capture rejects an asynchronous observation callback', () => {
  assert.throws(
    () => captureCompletionEndpoint({ now: () => 0, read: () => Promise.resolve({}) }),
    /returned a promise/,
  );
});

test('complete native endpoint verifies all required pins, duplicate editors and current text', () => {
  const record = sample();
  assert.equal(
    assertCompletionEndpoint(record.completionEndpoint, record.endpointExpected).status,
    'passed',
  );
});

for (const [name, mutate, message] of [
  [
    'extra source sidebar leaf',
    (r: any) =>
      r.completionEndpoint.layout.left.children.push({
        type: 'leaf',
        state: { type: 'markdown', state: { file: 'sidebar-alpha.md' }, pinned: true },
      }),
    /file leaves/,
  ],
  ['missing second sidebar editor', (r: any) => r.completionEndpoint.views.pop(), /multiplicities/],
  [
    'hidden deferred editor',
    (r: any) => {
      r.completionEndpoint.views[3].deferred = true;
    },
    /still deferred/,
  ],
  [
    'same-size stale shared bytes',
    (r: any) => {
      r.completionEndpoint.views[1].content = 'ALPHA\n';
    },
    /stale or missing/,
  ],
  [
    'retained input listener',
    (r: any) => {
      r.completionEndpoint.input.blocks[0].listenerCount = 1;
    },
    /input listeners/,
  ],
  [
    'late input release',
    (r: any) => {
      r.completionEndpoint.input.blocks[0].endMs = 100;
    },
    /input listeners/,
  ],
  [
    'stale Git label',
    (r: any) => {
      r.completionEndpoint.status.git = 'alpha';
    },
    /branch indicator/,
  ],
  [
    'removed sidebar still indexed',
    (r: any) => {
      r.completionEndpoint.indexed['sidebar-alpha.md'] = true;
    },
    /remains in the native index/,
  ],
  [
    'incomplete durable state',
    (r: any) => {
      r.completionEndpoint.journal = { phase: 'restoring' };
    },
    /identity or journal/,
  ],
] as const) {
  test(`endpoint rejects ${name} even if later verification passes`, () => {
    const record = structuredClone(sample());
    mutate(record);
    assert.throws(
      () => assertCompletionEndpoint(record.completionEndpoint, record.endpointExpected),
      message,
    );
  });
}
