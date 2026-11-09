const TARGET_SAMPLE_RATE = 16000;

function mergeChunks(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resample(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const source = index * ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = source - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function measureSpeechLevel(chunks) {
  if (!chunks?.length) return { peak: 0, rms: 0, samples: 0 };
  let peak = 0;
  let sumSquares = 0;
  let samples = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const value = Math.abs(chunk[index]);
      if (value > peak) peak = value;
      sumSquares += chunk[index] * chunk[index];
      samples += 1;
    }
  }
  return {
    peak,
    rms: samples ? Math.sqrt(sumSquares / samples) : 0,
    samples,
  };
}

export function encodeWav(chunks, inputSampleRate, outputSampleRate = TARGET_SAMPLE_RATE) {
  const samples = resample(mergeChunks(chunks), inputSampleRate, outputSampleRate);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class WavRecorder {
  constructor({ maxDurationMs = 25000, onMaxDuration = null } = {}) {
    this.maxDurationMs = maxDurationMs;
    this.onMaxDuration = onMaxDuration;
    this.recording = false;
  }

  async start() {
    if (this.recording) throw new Error('A recording is already active.');
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone recording is not supported in this browser.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio capture is not supported in this browser.');
      this.context = new AudioContextClass();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      this.chunks = [];
      this.processor.onaudioprocess = (event) => {
        if (this.recording) this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.context.destination);
      this.startedAt = performance.now();
      this.recording = true;
      this.timer = setTimeout(() => this.onMaxDuration?.(), this.maxDurationMs);
    } catch (error) {
      this.stream?.getTracks().forEach((track) => track.stop());
      if (this.context?.state !== 'closed') await this.context?.close();
      throw error;
    }
  }

  async stop() {
    if (!this.recording) throw new Error('No recording is active.');
    this.recording = false;
    clearTimeout(this.timer);
    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    this.processor.disconnect();
    this.source.disconnect();
    this.silentGain.disconnect();
    this.stream.getTracks().forEach((track) => track.stop());
    const level = measureSpeechLevel(this.chunks);
    const blob = encodeWav(this.chunks, this.context.sampleRate);
    await this.context.close();
    return {
      blob,
      durationMs,
      sampleRate: TARGET_SAMPLE_RATE,
      peak: level.peak,
      rms: level.rms,
    };
  }

  async cancel() {
    if (!this.recording) return null;
    this.recording = false;
    clearTimeout(this.timer);
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context?.state !== 'closed') await this.context.close();
    this.chunks = [];
    return null;
  }
}
