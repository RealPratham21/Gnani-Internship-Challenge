import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretAndExecute } from './natural-language.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('executes interpreted actions only through executeCommands', async () => {
  const actions = [
    { action: 'scale', target: 'active', factor: 0.8 },
    { action: 'appearance', target: 'active', appearance: { color: 'blue' } },
  ];
  const calls = [];
  const result = await interpretAndExecute({
    instruction: 'Make the sofa smaller and blue',
    scene: { version: '0.3', activeId: 'sofa-1', objects: [] },
    world: { status: 'idle' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ actions, clarification: null, model: 'test' });
    },
    executeCommands: async (commands) => {
      calls.push(commands);
      return { success: true, results: [] };
    },
  });
  assert.equal(calls[0].body.world.status, 'idle');
  assert.deepEqual(calls[1], actions);
  assert.equal(result.execution.success, true);
  assert.deepEqual(result.interpreted.actions, actions);
});

test('returns clarification without executing commands', async () => {
  let executed = false;
  const result = await interpretAndExecute({
    instruction: 'Play music',
    scene: { version: '0.3', activeId: null, objects: [] },
    fetchImpl: async () => jsonResponse({
      actions: [],
      clarification: 'Only scene operations are supported.',
      model: 'test',
    }),
    executeCommands: async () => { executed = true; },
  });

  assert.equal(executed, false);
  assert.equal(result.execution, null);
  assert.equal(result.interpreted.clarification, 'Only scene operations are supported.');
});

test('preserves Scene Manager execution failures in the debug result', async () => {
  const executionFailure = {
    success: false,
    failed: 1,
    results: [{ success: false, error: { code: 'TARGET_NOT_FOUND' } }],
  };
  const result = await interpretAndExecute({
    instruction: 'Rotate it',
    scene: { version: '0.3', activeId: 'sofa-1', objects: [] },
    fetchImpl: async () => jsonResponse({
      actions: [{ action: 'rotate', target: 'active', by: [0, 45, 0], unit: 'degrees' }],
      clarification: null,
      model: 'test',
    }),
    executeCommands: async () => executionFailure,
  });

  assert.equal(result.execution.success, false);
  assert.equal(result.execution.results[0].error.code, 'TARGET_NOT_FOUND');
});

