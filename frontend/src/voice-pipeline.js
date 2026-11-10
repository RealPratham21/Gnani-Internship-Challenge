export class VoicePipelineError extends Error {
  constructor(stage, message, status = null) {
    super(message);
    this.name = 'VoicePipelineError';
    this.stage = stage;
    this.status = status;
  }
}

export function createRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `voice_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function errorFromResponse(response, fallbackStage) {
  let body = null;
  try { body = await response.json(); } catch { /* no JSON error body */ }
  const detail = body?.detail;
  const stage = detail?.stage ?? fallbackStage;
  const message = detail?.message ?? (typeof detail === 'string' ? detail : null)
    ?? `Voice ${fallbackStage} failed (${response.status}).`;
  return new VoicePipelineError(stage, message, response.status);
}

function networkError(stage, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const hint = detail === 'Failed to fetch'
    ? 'Phone could not reach /api through the current port-forward/tunnel. Keep Vite :5173 and backend :8000 running, forward the Vite port, and retry.'
    : detail;
  return new VoicePipelineError('network', hint);
}

async function fetchJson(url, options, fallbackStage, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw networkError(fallbackStage, error);
  }
  if (!response.ok) throw await errorFromResponse(response, fallbackStage);
  try {
    return await response.json();
  } catch (error) {
    throw new VoicePipelineError(fallbackStage, 'Server returned an invalid JSON response.');
  }
}

const defaultFetch = (...args) => globalThis.fetch(...args);

export async function reportVoiceEvent(event, fetchImpl = defaultFetch) {
  console.info('[Wundro voice]', event);
  try {
    await fetchImpl('/api/voice/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    });
  } catch {
    // Diagnostics must never break the user interaction.
  }
}

export async function playAudioPayload(payload, audioElement = new Audio()) {
  const binary = atob(payload.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.audio_mime }));
  audioElement.src = url;
  audioElement.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        audioElement.removeEventListener('ended', onEnded);
        audioElement.removeEventListener('error', onError);
      };
      const onEnded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Audio playback failed.')); };
      audioElement.addEventListener('ended', onEnded);
      audioElement.addEventListener('error', onError);
      audioElement.play().catch((error) => {
        cleanup();
        reject(error);
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function speakIntermediate({
  requestId,
  text,
  detectedLanguage,
  playAudio,
  fetchImpl,
  onStage,
  report,
}) {
  const trimmed = text?.trim();
  if (!trimmed) return;
  onStage('speaking', trimmed);
  const speech = await fetchJson('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      text: trimmed,
      kind: 'intermediate',
      detected_language: detectedLanguage ?? null,
    }),
  }, 'timbre', fetchImpl);
  await report('playback', 'intermediate_started', 'info', {
    spoken_text: speech.spoken_text,
    audio_format: speech.audio_mime,
  });
  try {
    await playAudio(speech);
    await report('playback', 'intermediate_completed', 'success');
  } catch (error) {
    await report('playback', 'intermediate_failed', 'error', { error: error.message });
    throw new VoicePipelineError('playback', error.message);
  }
}

export async function runVoiceInteraction({
  requestId,
  audioBlob,
  durationMs,
  scene,
  world = { status: 'idle' },
  executeCommands,
  playAudio = playAudioPayload,
  fetchImpl = defaultFetch,
  onStage = () => {},
}) {
  const totalStarted = performance.now();
  const report = (stage, event, status = 'info', metadata = {}) => reportVoiceEvent(
    { request_id: requestId, stage, event, status, metadata }, fetchImpl,
  );

  onStage('processing', 'Checking link…');
  await fetchJson('/api/health', { method: 'GET' }, 'network', fetchImpl);

  onStage('processing', 'Transcribing…');
  const form = new FormData();
  form.append('request_id', requestId);
  form.append('scene', JSON.stringify(scene));
  form.append('world', JSON.stringify(world));
  form.append('duration_ms', String(durationMs));
  form.append('audio', audioBlob, 'voice.wav');
  const plan = await fetchJson('/api/voice/plan', { method: 'POST', body: form }, 'prisma', fetchImpl);
  if (!Array.isArray(plan.actions)) throw new VoicePipelineError('cohere', 'Invalid action plan.');

  if (plan.acknowledgement) {
    await speakIntermediate({
      requestId,
      text: plan.acknowledgement,
      detectedLanguage: plan.detected_language ?? null,
      playAudio,
      fetchImpl,
      onStage,
      report,
    });
  }

  onStage('processing', plan.transcript ? `“${plan.transcript}”` : 'Applying command…');
  const before = scene;
  const worldBefore = world;
  const execution = plan.actions.length ? await executeCommands(plan.actions) : null;
  const executionStatus = execution ? (execution.success ? 'success' : 'error') : 'info';
  const worldAfter = execution?.world ?? world;
  await report('execution', 'commands_completed', executionStatus, {
    transcript: plan.transcript,
    actions: plan.actions,
    clarification: plan.clarification,
    acknowledgement: plan.acknowledgement ?? null,
    execution,
    scene_before: before,
    scene_after: execution?.snapshot ?? scene,
    world_before: worldBefore,
    world_after: worldAfter,
  });

  onStage('processing', 'Preparing reply…');
  const speech = await fetchJson('/api/voice/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      transcript: plan.transcript,
      actions: plan.actions,
      clarification: plan.clarification,
      execution,
      scene_after: execution?.snapshot ?? scene,
      world_after: worldAfter,
      detected_language: plan.detected_language ?? null,
    }),
  }, 'timbre', fetchImpl);

  onStage('speaking', speech.spoken_text);
  await report('playback', 'started', 'info', {
    audio_format: speech.audio_mime,
    audio_size_base64: speech.audio_base64.length,
    spoken_text: speech.spoken_text,
  });
  let playbackSucceeded = false;
  try {
    await playAudio(speech);
    playbackSucceeded = true;
    await report('playback', 'completed', 'success');
  } catch (error) {
    await report('playback', 'failed', 'error', { error: error.message });
    throw new VoicePipelineError('playback', error.message);
  } finally {
    await report('pipeline', 'interaction_finished', playbackSucceeded ? 'success' : 'error', {
      total_latency_ms: Math.round(performance.now() - totalStarted),
      world_status: worldAfter?.status ?? null,
    });
  }
  return { plan, execution, speech, world: worldAfter };
}
