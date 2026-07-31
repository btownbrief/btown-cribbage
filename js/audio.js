// BTOWN CRIBBAGE — sparse procedural WebAudio. No audio files; the context
// is created lazily after a gesture, and every source cleans itself up.

const LS_MUTED = 'btown-cribbage-muted';
const MAX_VOICES = 12;

let ctx = null;
let master = null;
let muted = readMuted();
const sources = new Set();

function readMuted() {
  try {
    return localStorage.getItem(LS_MUTED) === '1';
  } catch (e) {
    return false;
  }
}

function saveMuted() {
  try {
    localStorage.setItem(LS_MUTED, muted ? '1' : '0');
  } catch (e) { /* private mode — sound still works for this visit */ }
}

function unlock() {
  if (muted || ctx) {
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    ctx = new AudioContext();
  } catch (e) {
    return;
  }
  master = ctx.createGain();
  master.gain.value = 0.3;
  master.connect(ctx.destination);
}

function voice(start, dur, build) {
  if (muted) return;
  unlock();
  if (!ctx || !master || sources.size >= MAX_VOICES) return;
  const t = ctx.currentTime + start;
  const source = build(ctx, t, master);
  if (!source) return;
  sources.add(source);
  const nodes = source._nodes || [source];
  source.onended = () => {
    sources.delete(source);
    nodes.forEach((node) => {
      try { node.disconnect(); } catch (e) { /* already disconnected */ }
    });
  };
  source.start(t);
  source.stop(t + dur + 0.04);
}

function tone(freq, start, dur, { type = 'sine', gain = 0.1, slide = 0 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(35, freq + slide), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc._nodes = [osc, g];
    return osc;
  });
}

function noise(start, dur, { gain = 0.055, highpass = 800 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const frames = Math.max(1, Math.floor(audio.sampleRate * dur));
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const g = audio.createGain();
    source.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    source.connect(filter).connect(g).connect(out);
    source._nodes = [source, filter, g];
    return source;
  });
}

function scoreMotif(points) {
  const notes = points >= 9 ? [392, 494, 587, 784] : points >= 5 ? [392, 494, 659] : [392, 523];
  notes.forEach((freq, i) => tone(freq, i * 0.055, 0.2, {
    type: 'triangle',
    gain: 0.085 + Math.min(points, 12) * 0.003,
  }));
}

export const sound = {
  get muted() {
    return muted;
  },
  unlock,
  stop() {
    for (const source of sources) {
      try { source.stop(); } catch (e) { /* already stopped */ }
    }
    sources.clear();
  },
  toggleMuted() {
    muted = !muted;
    saveMuted();
    if (muted) this.stop();
    else unlock();
    return muted;
  },
  slap() {
    noise(0, 0.05, { gain: 0.07, highpass: 950 });
    tone(145, 0, 0.07, { type: 'triangle', gain: 0.07, slide: -40 });
  },
  deal() {
    [0, 0.055, 0.11, 0.165].forEach((start, i) => {
      noise(start, 0.075, { gain: 0.045 - i * 0.004, highpass: 1100 + i * 180 });
    });
  },
  callout(kind, points = 0) {
    if (kind === 'fifteen') {
      tone(440, 0, 0.11, { type: 'triangle', gain: 0.095 });
      tone(660, 0.08, 0.16, { type: 'triangle', gain: 0.11 });
    } else if (kind === 'thirtyone' || kind === 'heels') {
      [523, 659, 784].forEach((freq, i) => tone(freq, i * 0.055, 0.28, {
        type: 'triangle', gain: 0.11,
      }));
    } else if (kind === 'go' || kind === 'lastcard') {
      tone(294, 0, 0.18, { type: 'sine', gain: 0.065, slide: -28 });
    } else if (kind === 'pair') {
      const hits = points >= 12 ? 4 : points >= 6 ? 3 : 2;
      for (let i = 0; i < hits; i++) {
        tone(330 + i * 72, i * 0.045, 0.16, { type: 'triangle', gain: 0.075 + i * 0.008 });
      }
    } else if (kind === 'run') {
      const hits = Math.min(5, Math.max(3, points));
      for (let i = 0; i < hits; i++) {
        tone(330 * 2 ** (i / 12), i * 0.04, 0.17, { type: 'triangle', gain: 0.075 });
      }
    } else if (points > 0) {
      scoreMotif(points);
    }
  },
  summit(localWinner) {
    const notes = localWinner === false ? [392, 330, 262] : [392, 494, 587, 784, 1047];
    notes.forEach((freq, i) => tone(freq, i * 0.09, i === notes.length - 1 ? 0.48 : 0.24, {
      type: 'triangle',
      gain: localWinner === false ? 0.085 : 0.12,
    }));
  },
};
