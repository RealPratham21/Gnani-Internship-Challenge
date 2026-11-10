import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { AimPlacementController } from './aim-placement.js';
import { AssetLoader } from './asset-loader.js';
import { interpretAndExecute } from './natural-language.js';
import { SceneManager } from './scene-manager.js';
import { WavRecorder } from './wav-recorder.js';
import {
  createRequestId,
  playAudioPayload,
  reportVoiceEvent,
  runVoiceInteraction,
} from './voice-pipeline.js';
import { WorldController } from './world-controller.js';
import './style.css';

const MIN_HOLD_MS = 420;
const SILENCE_RMS = 0.012;
const SILENCE_PEAK = 0.04;
const HINT_MS = 2200;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 20);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.35));

const appRoot = document.querySelector('#app');
appRoot.innerHTML = `
  <section class="landing" aria-label="Wundro home">
    <div class="landing-brand">
      <img class="landing-logo" src="/wundro-logo.png" alt="" width="148" height="148" decoding="async" />
      <img class="landing-wordmark" src="/wundro-name.png" alt="Wundro" width="320" height="120" decoding="async" />
      <p class="landing-tag">Speak the world into place</p>
    </div>
  </section>
  <div class="brand-chip" aria-hidden="true">
    <img src="/wundro-name.png" alt="" decoding="async" />
  </div>
  <button id="exit-ar" type="button" aria-label="Close AR">
    <span class="exit-icon" aria-hidden="true"></span>
  </button>
  <div class="aim-crosshair" data-mode="inactive" aria-hidden="true"></div>
  <div id="placement-status" class="placement-chip" data-mode="inactive"></div>
  <div id="status-pill" class="status-pill" data-visible="false" role="status" aria-live="polite">
    <span class="pulse" aria-hidden="true"></span>
    <span id="voice-status" class="copy">Checking…</span>
  </div>
  <div class="action-dock start-dock">
    <span class="start-label">Start AR</span>
    <button id="start-ar" class="circle-btn" type="button" aria-label="Start AR">
      <span class="ar-icon" aria-hidden="true"><span></span></span>
    </button>
  </div>
  <div class="action-dock voice-dock">
    <button id="push-to-talk" class="circle-btn" type="button" aria-label="Hold to talk">
      <span class="mic-icon" aria-hidden="true"></span>
    </button>
  </div>
`;

const arButton = ARButton.createButton(renderer, {
  optionalFeatures: ['hit-test', 'dom-overlay', 'local-floor'],
  domOverlay: { root: appRoot },
});
arButton.setAttribute('aria-hidden', 'true');
arButton.tabIndex = -1;
document.body.appendChild(arButton);

const aimPlacement = new AimPlacementController({ scene, distance: 2 });
const sceneManager = new SceneManager({
  scene,
  placementProvider: () => aimPlacement.getPlacement(),
});

const statusPill = document.querySelector('#status-pill');
const voiceStatus = document.querySelector('#voice-status');
const pushToTalk = document.querySelector('#push-to-talk');
const startAr = document.querySelector('#start-ar');
const exitAr = document.querySelector('#exit-ar');
const crosshair = document.querySelector('.aim-crosshair');
const placementStatus = document.querySelector('#placement-status');
const phoneAudio = new Audio();
phoneAudio.playsInline = true;

function triggerArSession() {
  arButton.click();
}
startAr.addEventListener('click', async () => {
  haptic(10);
  await unlockPhoneAudio();
  triggerArSession();
});
exitAr.addEventListener('click', () => {
  haptic(8);
  stopPlayback();
  if (recorder) {
    cancelRequested = true;
    try { recorder.cancel(); } catch { /* ignore */ }
  }
  triggerArSession();
});

let recorder = null;
let interactionBusy = false;
let currentRequestId = null;
let interactionStartedAt = 0;
let holdStartedAt = 0;
let releaseRequested = false;
let cancelRequested = false;
let activePointerId = null;
let hintTimer = null;
let pillHideTimer = null;
let latestWorld = { status: 'idle' };

function haptic(pattern = 12) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

function showPill(message, { sticky = false } = {}) {
  voiceStatus.textContent = message;
  statusPill.dataset.visible = 'true';
  clearTimeout(pillHideTimer);
  if (!sticky) {
    pillHideTimer = setTimeout(() => {
      if (['ready', 'idle', 'hint'].includes(document.body.dataset.voiceState)) {
        statusPill.dataset.visible = 'false';
      }
    }, 3200);
  }
}

function setVoiceState(state, message, { sticky = false } = {}) {
  document.body.dataset.voiceState = state;
  pushToTalk.disabled = ['processing', 'downloading', 'speaking'].includes(state);
  pushToTalk.setAttribute('aria-pressed', String(state === 'listening'));
  if (message) {
    showPill(message, {
      sticky: sticky || ['listening', 'processing', 'downloading', 'speaking'].includes(state),
    });
  } else if (['ready', 'idle'].includes(state)) {
    statusPill.dataset.visible = 'false';
  }
}

function flashHint(message) {
  clearTimeout(hintTimer);
  setVoiceState('hint', message, { sticky: true });
  hintTimer = setTimeout(() => {
    if (document.body.dataset.voiceState === 'hint') setVoiceState('ready');
  }, HINT_MS);
}

function renderWorldState(world) {
  latestWorld = world;
  const labels = {
    searching: 'Searching…',
    downloading: 'Downloading…',
    awaiting_placement: world.pending
      ? `${world.pending.name} ready — say where`
      : 'Ready to place',
    placed: 'Placed',
    error: 'Asset issue',
  };
  if (world.status === 'searching' || world.status === 'downloading') {
    setVoiceState('downloading', labels[world.status], { sticky: true });
  } else if (world.status === 'awaiting_placement' && !interactionBusy) {
    setVoiceState('ready', labels.awaiting_placement);
  } else if (world.status === 'error' && !interactionBusy) {
    setVoiceState('error', labels.error);
  }
}

const worldController = new WorldController({
  sceneManager,
  aimPlacement,
  assetLoader: new AssetLoader(),
  onStateChange: renderWorldState,
  reportEvent: reportVoiceEvent,
});
renderWorldState(worldController.getWorldState());

async function runPlan(actions, source = 'debug', requestId = createRequestId()) {
  const execution = await worldController.executePlan(actions, { requestId });
  console.info('[Wundro scene]', { source, execution, world: execution.world });
  return execution;
}

function blockXrSelect(event) {
  event.preventDefault();
}
for (const node of [pushToTalk, startAr, exitAr, statusPill, arButton]) {
  node.addEventListener('beforexrselect', blockXrSelect);
}

async function unlockPhoneAudio() {
  if (phoneAudio.dataset.unlocked === 'true') return;
  const previousVolume = phoneAudio.volume;
  phoneAudio.volume = 0;
  phoneAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA';
  try {
    await phoneAudio.play();
    phoneAudio.pause();
    phoneAudio.dataset.unlocked = 'true';
  } catch {
    // Real playback will surface a clear restriction later.
  } finally {
    phoneAudio.volume = previousVolume;
  }
}

function stopPlayback() {
  try {
    phoneAudio.pause();
    phoneAudio.removeAttribute('src');
    phoneAudio.load();
  } catch { /* ignore */ }
}

async function beginRecording(event) {
  event?.preventDefault();
  if (interactionBusy) return;
  if (event?.pointerType === 'mouse' && event.button !== 0) return;

  interactionBusy = true;
  releaseRequested = false;
  cancelRequested = false;
  holdStartedAt = performance.now();
  interactionStartedAt = holdStartedAt;
  currentRequestId = createRequestId();
  activePointerId = event?.pointerId ?? null;
  if (activePointerId != null) pushToTalk.setPointerCapture?.(activePointerId);

  stopPlayback();
  await unlockPhoneAudio();
  recorder = new WavRecorder({ onMaxDuration: () => finishRecording() });
  try {
    await recorder.start();
    haptic(10);
    setVoiceState('listening', 'Listening…', { sticky: true });
    await reportVoiceEvent({
      request_id: currentRequestId,
      stage: 'microphone',
      event: 'recording_started',
      status: 'info',
      metadata: { target_format: 'audio/wav', sample_rate: 16000, max_duration_ms: 25000 },
    });
    if (cancelRequested) {
      await recorder.cancel();
      recorder = null;
      interactionBusy = false;
      setVoiceState('ready');
      return;
    }
    if (releaseRequested) await finishRecording();
  } catch (error) {
    setVoiceState('error', 'Mic unavailable');
    await reportVoiceEvent({
      request_id: currentRequestId,
      stage: 'microphone',
      event: 'recording_failed',
      status: 'error',
      metadata: { error: error.message },
    });
    interactionBusy = false;
    recorder = null;
  }
}

async function cancelRecording(reason = 'cancelled') {
  cancelRequested = true;
  if (!recorder) {
    interactionBusy = false;
    return;
  }
  if (recorder.recording) await recorder.cancel();
  recorder = null;
  interactionBusy = false;
  await reportVoiceEvent({
    request_id: currentRequestId,
    stage: 'microphone',
    event: 'recording_cancelled',
    status: 'info',
    metadata: { reason },
  });
}

async function finishRecording(event) {
  event?.preventDefault();
  if (!recorder?.recording) {
    if (interactionBusy && recorder === null) return;
    if (interactionBusy) releaseRequested = true;
    return;
  }

  const heldMs = performance.now() - holdStartedAt;
  if (heldMs < MIN_HOLD_MS) {
    await cancelRecording('short_tap');
    flashHint('Hold to talk.');
    haptic([8, 30, 8]);
    return;
  }

  setVoiceState('processing', 'Processing…', { sticky: true });
  haptic(8);
  try {
    const recording = await recorder.stop();
    if (recording.rms < SILENCE_RMS && recording.peak < SILENCE_PEAK) {
      await reportVoiceEvent({
        request_id: currentRequestId,
        stage: 'microphone',
        event: 'silence_detected',
        status: 'info',
        metadata: {
          duration_ms: recording.durationMs,
          rms: Number(recording.rms.toFixed(5)),
          peak: Number(recording.peak.toFixed(5)),
        },
      });
      flashHint("Didn't catch that. Try again.");
      return;
    }

    await reportVoiceEvent({
      request_id: currentRequestId,
      stage: 'microphone',
      event: 'recording_completed',
      status: 'success',
      metadata: {
        audio_format: recording.blob.type,
        audio_size_bytes: recording.blob.size,
        duration_ms: recording.durationMs,
        sample_rate: recording.sampleRate,
        rms: Number(recording.rms.toFixed(5)),
        peak: Number(recording.peak.toFixed(5)),
      },
    });

    const result = await runVoiceInteraction({
      requestId: currentRequestId,
      audioBlob: recording.blob,
      durationMs: recording.durationMs,
      scene: sceneManager.getSnapshot(),
      world: worldController.getWorldState(),
      executeCommands: (actions) => runPlan(actions, 'voice', currentRequestId),
      playAudio: async (payload) => {
        stopPlayback();
        await playAudioPayload(payload, phoneAudio);
      },
      onStage: (state, message) => {
        if (state === 'speaking') setVoiceState('speaking', message || 'Speaking…', { sticky: true });
        else if (latestWorld.status === 'downloading' || latestWorld.status === 'searching') {
          setVoiceState('downloading', latestWorld.status === 'searching' ? 'Searching…' : 'Downloading…', { sticky: true });
        } else setVoiceState('processing', message || 'Processing…', { sticky: true });
      },
    });

    const world = result.world ?? worldController.getWorldState();
    if (world.status === 'awaiting_placement') {
      setVoiceState('ready', world.pending ? `${world.pending.name} ready — say where` : 'Ready to place');
    } else {
      setVoiceState('ready', result.speech?.spoken_text || 'Ready');
    }
  } catch (error) {
    const stage = error.stage ?? 'pipeline';
    const emptyPrisma = stage === 'prisma' && /empty transcript/i.test(error.message || '');
    if (emptyPrisma) {
      flashHint("Didn't catch that. Try again.");
    } else {
      setVoiceState('error', error.message || `${stage} error`);
    }
    await reportVoiceEvent({
      request_id: currentRequestId,
      stage: 'pipeline',
      event: 'interaction_failed',
      status: 'error',
      metadata: {
        failed_stage: stage,
        error: error.message,
        total_latency_ms: Math.round(performance.now() - interactionStartedAt),
      },
    });
  } finally {
    recorder = null;
    interactionBusy = false;
    activePointerId = null;
  }
}

pushToTalk.addEventListener('pointerdown', beginRecording);
pushToTalk.addEventListener('pointerup', finishRecording);
pushToTalk.addEventListener('pointercancel', async (event) => {
  event.preventDefault();
  if (recorder?.recording) {
    await cancelRecording('pointercancel');
    setVoiceState('ready');
  }
});
pushToTalk.addEventListener('lostpointercapture', async () => {
  if (recorder?.recording) releaseRequested = true;
});
pushToTalk.addEventListener('contextmenu', (event) => event.preventDefault());
pushToTalk.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) beginRecording(event);
});
pushToTalk.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') finishRecording(event);
});

async function checkVoiceHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    if (!response.ok || health.status !== 'ready') {
      const missing = [!health.cohereConfigured && 'Cohere', !health.gnaniConfigured && 'Gnani'].filter(Boolean);
      throw new Error(`${missing.join(' + ') || 'Backend'} configuration required`);
    }
    if (document.body.classList.contains('xr-active')) {
      setVoiceState('ready', 'Hold to talk');
    } else {
      setVoiceState('idle');
      statusPill.dataset.visible = 'false';
    }
  } catch (error) {
    setVoiceState('error', 'Voice offline');
    console.error(error);
  }
}

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (interactionBusy) return;
  if (!aimPlacement.getState().canPlace) return;
  if (worldController.getWorldState().status !== 'awaiting_placement') return;
  runPlan([{ action: 'place_pending', at: 'aim' }], 'controller-select');
});
scene.add(controller);

let renderedPlacementKey = '';
function renderPlacementState(force = false) {
  const state = aimPlacement.getState();
  const key = `${state.mode}:${state.distance}:${state.height}`;
  if (!force && key === renderedPlacementKey) return;
  renderedPlacementKey = key;
  crosshair.dataset.mode = state.mode;
  placementStatus.dataset.mode = state.mode;
  placementStatus.textContent = {
    inactive: '',
    'tracking-lost': 'Tracking paused',
    estimated: 'Aim to place',
    surface: 'Surface locked',
  }[state.mode] || '';
}

let hitTestSource = null;
let hitTestRequested = false;
let floorReferenceSpace = null;
renderer.xr.addEventListener('sessionstart', () => {
  document.body.classList.add('xr-active');
  aimPlacement.setActive(true);
  renderPlacementState(true);
  setVoiceState('ready', 'Hold to talk');
});
renderer.xr.addEventListener('sessionend', () => {
  document.body.classList.remove('xr-active');
  appRoot.style.display = '';
  hitTestSource?.cancel();
  hitTestSource = null;
  hitTestRequested = false;
  floorReferenceSpace = null;
  aimPlacement.setActive(false);
  renderPlacementState(true);
  interactionBusy = false;
  activePointerId = null;
  setVoiceState('idle');
  statusPill.dataset.visible = 'false';
});

function requestOptionalTrackingFeatures(session) {
  if (hitTestRequested) return;
  hitTestRequested = true;
  session.requestReferenceSpace('viewer')
    .then((space) => session.requestHitTestSource({ space }))
    .then((source) => { hitTestSource = source; })
    .catch(() => { hitTestSource = null; });
  session.requestReferenceSpace('local-floor')
    .then((space) => { floorReferenceSpace = space; })
    .catch(() => { floorReferenceSpace = null; });
}

renderer.setAnimationLoop((timestamp, frame) => {
  if (frame) {
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();
    requestOptionalTrackingFeatures(session);
    let cameraMatrix = null;
    let surfaceMatrix = null;
    let floorY = null;
    if (referenceSpace) {
      try {
        const viewerPose = frame.getViewerPose(referenceSpace);
        if (viewerPose?.views.length) {
          cameraMatrix = new THREE.Matrix4().fromArray(viewerPose.views[0].transform.matrix);
        }
        if (hitTestSource) {
          const hitPose = frame.getHitTestResults(hitTestSource)[0]?.getPose(referenceSpace);
          if (hitPose) surfaceMatrix = new THREE.Matrix4().fromArray(hitPose.transform.matrix);
        }
        if (floorReferenceSpace) {
          floorY = frame.getPose(floorReferenceSpace, referenceSpace)?.transform.position.y ?? null;
        }
      } catch { /* transient tracking loss */ }
    }
    aimPlacement.update({ cameraMatrix, surfaceMatrix, floorY });
    renderPlacementState();
  }
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const wundroApi = {
  executeCommands: (commands) => runPlan(commands, 'console'),
  interpretText: (instruction) => interpretAndExecute({
    instruction,
    scene: sceneManager.getSnapshot(),
    world: worldController.getWorldState(),
    executeCommands: (actions) => runPlan(actions, 'interpret-text'),
  }),
  getSceneSnapshot: () => sceneManager.getSnapshot(),
  getWorldState: () => worldController.getWorldState(),
  getPlacementState: () => aimPlacement.getState(),
  setPlacementDistance: (distance) => aimPlacement.setDistance(distance),
  setPlacementHeight: (height) => aimPlacement.setHeight(height),
  getVoiceDiagnostics: (requestId) => fetch(`/api/voice/diagnostics/${requestId}`).then((value) => value.json()),
};
window.wundro = wundroApi;
window.shabdVerse = wundroApi;

renderPlacementState(true);
checkVoiceHealth();
