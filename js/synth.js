// A soft "hummed" choir sound for each part, plus a simple look-ahead player.

const PAN = [-0.35, -0.12, 0.12, 0.35];
const LOOKAHEAD = 0.2; // seconds of notes scheduled ahead of the clock

const freqOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

export class Player {
  constructor() {
    this.ctx = null;
    this.tempo = 80;
    this.volume = [1, 1, 1, 1];
    this.muted = [false, false, false, false];
    this.playing = false;
    this.score = null;
    this.waves = new Map();
    this.active = new Set();
    this.anchorTime = 0; // audio time at which anchorBeat sounds
    this.anchorBeat = 0;
    this.pausedBeat = 0;
    this.onEnd = null;
  }

  ensure() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2800;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(tone).connect(comp).connect(ctx.destination);
    this.parts = PAN.map((p, i) => {
      const g = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = p; g.connect(pan).connect(this.master); }
      else g.connect(this.master);
      g.gain.value = this.partLevel(i);
      return g;
    });
  }

  partLevel(i) {
    return this.muted[i] ? 0 : this.volume[i];
  }

  setPart(i, { volume, muted }) {
    if (volume !== undefined) this.volume[i] = volume;
    if (muted !== undefined) this.muted[i] = muted;
    if (this.ctx) this.parts[i].gain.setTargetAtTime(this.partLevel(i), this.ctx.currentTime, 0.03);
  }

  // Harmonics shaped like a closed-mouth "mmm/ooh": strong low formant, little brightness.
  wave(midi) {
    if (this.waves.has(midi)) return this.waves.get(midi);
    const f0 = freqOf(midi);
    const n = Math.max(2, Math.min(40, Math.floor(4000 / f0)));
    const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
      const f = k * f0;
      const formant = 1 + 2.2 * Math.exp(-(((f - 300) / 140) ** 2)) + 0.6 * Math.exp(-(((f - 850) / 220) ** 2));
      const rolloff = 1 / (1 + (f / 1100) ** 4);
      imag[k] = (formant * rolloff) / Math.pow(k, 1.3);
    }
    const w = this.ctx.createPeriodicWave(real, imag);
    this.waves.set(midi, w);
    return w;
  }

  // Schedule one hummed note.
  hum(part, midi, when, dur, level = 1) {
    const ctx = this.ctx;
    const f = freqOf(midi);
    const env = ctx.createGain();
    env.gain.value = 0;
    env.connect(this.parts[part]);
    const oscs = [0, 6].map((cents) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.wave(midi));
      o.frequency.value = f;
      o.detune.value = cents;
      return o;
    });
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    oscs.forEach((o) => o.connect(mix));
    mix.connect(env);
    // gentle vibrato that fades in on longer notes
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2 + Math.random() * 0.6;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, when);
    depth.gain.linearRampToValueAtTime(0, when + 0.25);
    depth.gain.linearRampToValueAtTime(f * 0.0045, when + 0.8);
    lfo.connect(depth);
    oscs.forEach((o) => depth.connect(o.frequency));

    const peak = 0.22 * level;
    const attack = Math.min(0.08, dur * 0.4);
    const end = when + Math.max(dur, 0.06);
    const release = 0.12;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.setTargetAtTime(peak * 0.82, when + attack, 0.25);
    env.gain.setValueAtTime(peak * 0.82, Math.max(when + attack, end - 0.02));
    env.gain.setTargetAtTime(0, end - 0.02, release / 3);
    const stopAt = end + release * 2;
    [...oscs, lfo].forEach((o) => { o.start(when); o.stop(stopAt); });
    const node = { env, oscs, lfo, stopAt };
    this.active.add(node);
    oscs[0].onended = () => { this.active.delete(node); env.disconnect(); };
  }

  preview(part, midi) {
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.hum(part, midi, this.ctx.currentTime + 0.01, 0.45);
  }

  get beat() {
    if (!this.playing) return this.pausedBeat;
    return this.anchorBeat + ((this.ctx.currentTime - this.anchorTime) * this.tempo) / 60;
  }

  setTempo(bpm) {
    if (this.playing) {
      const b = this.beat;
      this.anchorTime = this.ctx.currentTime;
      this.anchorBeat = b;
    }
    this.tempo = bpm;
  }

  play(score, fromBeat = 0) {
    this.ensure();
    this.stop(false);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.score = score;
    this.queue = [];
    score.parts.forEach((p, i) => p.notes.forEach((n) => this.queue.push({ ...n, part: i })));
    this.queue.sort((a, b) => a.t - b.t);
    this.end = this.queue.reduce((m, n) => Math.max(m, n.t + n.d), 0);
    this.next = this.queue.findIndex((n) => n.t >= fromBeat - 1e-6);
    if (this.next < 0) this.next = this.queue.length;
    // Also sound notes that are already holding at the start point.
    const holding = this.queue.filter((n) => n.t < fromBeat - 1e-6 && n.t + n.d > fromBeat + 0.05);
    this.anchorTime = this.ctx.currentTime + 0.08;
    this.anchorBeat = fromBeat;
    this.playing = true;
    const spb = () => 60 / this.tempo;
    for (const n of holding) this.hum(n.part, n.midi, this.anchorTime, (n.t + n.d - fromBeat) * spb());
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  tick() {
    if (!this.playing) return;
    const spb = 60 / this.tempo;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.next < this.queue.length) {
      const n = this.queue[this.next];
      const when = this.anchorTime + (n.t - this.anchorBeat) * spb;
      if (when > horizon) break;
      // Leave a hair of space between repeated notes so they are heard separately.
      this.hum(n.part, n.midi, Math.max(when, this.ctx.currentTime), n.d * spb - 0.03);
      this.next++;
    }
    if (this.next >= this.queue.length && this.beat > this.end + 0.3) {
      this.stop(false);
      this.pausedBeat = 0;
      if (this.onEnd) this.onEnd();
    }
  }

  pause() {
    if (!this.playing) return;
    this.pausedBeat = this.beat;
    this.stop(false);
  }

  stop(reset = true) {
    clearInterval(this.timer);
    if (this.playing) this.pausedBeat = this.beat;
    this.playing = false;
    if (reset) this.pausedBeat = 0;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const node of this.active) {
      node.env.gain.cancelScheduledValues(now);
      node.env.gain.setTargetAtTime(0, now, 0.02);
      [...node.oscs, node.lfo].forEach((o) => { try { o.stop(now + 0.1); } catch { /* not started yet */ } });
    }
    this.active.clear();
  }

  seek(beat) {
    if (this.playing) this.play(this.score, beat);
    else this.pausedBeat = beat;
  }
}
