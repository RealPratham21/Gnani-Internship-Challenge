import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, measureSpeechLevel } from './wav-recorder.js';

test('encodes 16 kHz mono PCM as a valid WAV file', async () => {
  const blob = encodeWav([new Float32Array(1600).fill(0.25)], 16000);
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset, length) => String.fromCharCode(
    ...new Uint8Array(view.buffer, offset, length),
  );
  assert.equal(blob.type, 'audio/wav');
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
});

test('measures near-silent audio as low speech level', () => {
  const quiet = measureSpeechLevel([new Float32Array(800).fill(0.001)]);
  const loud = measureSpeechLevel([new Float32Array(800).fill(0.2)]);
  assert.ok(quiet.rms < 0.01);
  assert.ok(loud.peak >= 0.2);
});

