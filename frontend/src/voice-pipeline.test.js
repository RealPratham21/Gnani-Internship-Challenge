import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoiceInteraction, VoicePipelineError } from './voice-pipeline.js';

const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const audio = new Blob([new Uint8Array(48)], { type: 'audio/wav' });
const scene = { version: '0.3', activeId: null, objects: [] };
const world = { status: 'idle', pending: null, lastPlacedId: null, error: null };

function fetchSequence(items) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/voice/events') return response({ accepted: true });
    return items.shift();
  };
  return { calls, fetchImpl };
}

const health = response({ status: 'ready', version: '0.6.0' });

test('runs plan, authoritative execution, TTS and playback in order', async () => {
  const { calls, fetchImpl } = fetchSequence([
    health,
    response({ request_id: 'request-1', transcript: 'sofa chhota karo', actions: [
      { action: 'scale', target: 'active', factor: 0.8 },
    ], model: 'test' }),
    response({ request_id: 'request-1', spoken_text: 'Done.', audio_mime: 'audio/wav', audio_base64: 'AA==' }),
  ]);
  let played = false;
  const result = await runVoiceInteraction({
    requestId: 'request-1', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
    executeCommands: async () => ({
      success: true, succeeded: 1, failed: 0, snapshot: scene, world: { ...world, status: 'placed' },
    }),
    playAudio: async () => { played = true; },
  });
  assert.equal(result.execution.success, true);
  assert.equal(played, true);
  assert.deepEqual(calls.filter((item) => !item.url.endsWith('/events')).map((item) => item.url), [
    '/api/health', '/api/voice/plan', '/api/voice/complete',
  ]);
  const planCall = calls.find((item) => item.url === '/api/voice/plan');
  assert.equal(planCall.options.body.get('world'), JSON.stringify(world));
});

test('speaks acknowledgement before long asset work, then final confirmation', async () => {
  const { calls, fetchImpl } = fetchSequence([
    health,
    response({
      request_id: 'request-ack',
      transcript: 'Mujhe ek table chahiye',
      actions: [{ action: 'request_asset', query: 'table', place: false }],
      acknowledgement: 'Table dhoondh raha hoon.',
      model: 'test',
    }),
    response({
      request_id: 'request-ack',
      spoken_text: 'Table dhoondh raha hoon.',
      audio_mime: 'audio/wav',
      audio_base64: 'AA==',
    }),
    response({
      request_id: 'request-ack',
      spoken_text: 'Ready. Kahan rakhna hai?',
      audio_mime: 'audio/wav',
      audio_base64: 'AA==',
    }),
  ]);
  const spoken = [];
  await runVoiceInteraction({
    requestId: 'request-ack', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
    executeCommands: async () => ({
      success: true,
      succeeded: 1,
      failed: 0,
      snapshot: scene,
      world: {
        status: 'awaiting_placement',
        pending: { id: 'side_table_01', name: 'Side Table 01', query: 'table', provider: 'Poly Haven' },
        lastPlacedId: null,
        error: null,
      },
    }),
    playAudio: async (payload) => { spoken.push(payload.spoken_text); },
  });
  assert.deepEqual(spoken, ['Table dhoondh raha hoon.', 'Ready. Kahan rakhna hai?']);
  assert.deepEqual(
    calls.filter((item) => !item.url.endsWith('/events')).map((item) => item.url),
    ['/api/health', '/api/voice/plan', '/api/voice/speak', '/api/voice/complete'],
  );
  const complete = calls.find((item) => item.url === '/api/voice/complete');
  assert.equal(JSON.parse(complete.options.body).world_after.status, 'awaiting_placement');
});

test('attributes transcription failures to Prisma', async () => {
  const { fetchImpl } = fetchSequence([
    health,
    response({ detail: { stage: 'prisma', message: 'No speech detected.' } }, false, 422),
  ]);
  await assert.rejects(
    runVoiceInteraction({
      requestId: 'request-2', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
      executeCommands: async () => null, playAudio: async () => {},
    }),
    (error) => error instanceof VoicePipelineError && error.stage === 'prisma',
  );
});

test('surfaces Failed to fetch as a network error', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/voice/events') return response({ accepted: true });
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    runVoiceInteraction({
      requestId: 'request-net', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
      executeCommands: async () => null, playAudio: async () => {},
    }),
    (error) => error instanceof VoicePipelineError
      && error.stage === 'network'
      && /port-forward|tunnel/i.test(error.message),
  );
});

test('sends partial execution failures to TTS before speaking', async () => {
  const { calls, fetchImpl } = fetchSequence([
    health,
    response({ request_id: 'request-3', transcript: 'do both', actions: [
      { action: 'scale', target: 'active', factor: 0.8 },
      { action: 'move', target: 'missing', by: [1, 0, 0] },
    ], model: 'test' }),
    response({ request_id: 'request-3', spoken_text: 'Half victory.', audio_mime: 'audio/wav', audio_base64: 'AA==' }),
  ]);
  await runVoiceInteraction({
    requestId: 'request-3', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
    executeCommands: async () => ({
      success: false, succeeded: 1, failed: 1, snapshot: scene, world,
    }),
    playAudio: async () => {},
  });
  const complete = calls.find((item) => item.url === '/api/voice/complete');
  assert.equal(JSON.parse(complete.options.body).execution.failed, 1);
});

test('does not attempt playback when Timbre fails', async () => {
  const { fetchImpl } = fetchSequence([
    health,
    response({ request_id: 'request-4', transcript: 'rotate', actions: [], clarification: 'Which object?', model: 'test' }),
    response({ detail: { stage: 'timbre', message: 'TTS unavailable.' } }, false, 503),
  ]);
  let played = false;
  await assert.rejects(runVoiceInteraction({
    requestId: 'request-4', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
    executeCommands: async () => null, playAudio: async () => { played = true; },
  }), (error) => error.stage === 'timbre');
  assert.equal(played, false);
});

test('reports phone playback failures', async () => {
  const { fetchImpl } = fetchSequence([
    health,
    response({ request_id: 'request-5', transcript: 'remove', actions: [], clarification: 'Nothing selected.', model: 'test' }),
    response({ request_id: 'request-5', spoken_text: 'Nothing selected.', audio_mime: 'audio/wav', audio_base64: 'AA==' }),
  ]);
  await assert.rejects(runVoiceInteraction({
    requestId: 'request-5', audioBlob: audio, durationMs: 500, scene, world, fetchImpl,
    executeCommands: async () => null,
    playAudio: async () => { throw new Error('Autoplay blocked.'); },
  }), (error) => error.stage === 'playback');
});
