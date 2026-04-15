const stageEl = document.getElementById("stage");
const effectsEl = document.getElementById("effects");
const snailEl = document.getElementById("snail");
const statusEl = document.getElementById("status");

const SNAIL_SIZE = 62;
const CRAWL_SPEED = 14; // pixels per second
const DASH_DURATION_MS = 340;
const TAP_WINDOW_MS = 1300;
const TAP_BURST_TAPS_MIN = 3;
const TAP_BURST_TAPS_MAX = 9;
const SLEEP_DURATION_MS = 3000;

let audioCtx = null;
let fallbackTapAudios = null;
let lastTapSoundIndex = -1;

const TAP_SOUND_VARIANTS = [
  { osc: "sine", f1: 330, d1: 0.07, f2: 470, d2: 0.09, gap: 0.048, glide: 1.18 },
  { osc: "triangle", f1: 360, d1: 0.06, f2: 540, d2: 0.09, gap: 0.05, glide: 1.22 },
  { osc: "sine", f1: 390, d1: 0.07, f2: 620, d2: 0.085, gap: 0.052, glide: 1.25 },
  { osc: "triangle", f1: 310, d1: 0.075, f2: 450, d2: 0.1, gap: 0.045, glide: 1.16 },
  { osc: "sine", f1: 420, d1: 0.06, f2: 560, d2: 0.095, gap: 0.05, glide: 1.2 },
  { osc: "triangle", f1: 345, d1: 0.065, f2: 505, d2: 0.09, gap: 0.055, glide: 1.19 },
  { osc: "sine", f1: 370, d1: 0.075, f2: 520, d2: 0.1, gap: 0.047, glide: 1.17 }
];

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

/** Soft rising “boop-boop” for each tap — short, snail-cute, no audio file needed. */
function encodeWavPcm16({ sampleRate, samples }) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeAscii(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(s * 0x7fff), true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function chooseTapSoundIndex() {
  if (TAP_SOUND_VARIANTS.length <= 1) {
    lastTapSoundIndex = 0;
    return 0;
  }

  let idx = Math.floor(Math.random() * TAP_SOUND_VARIANTS.length);
  if (idx === lastTapSoundIndex) {
    idx = (idx + 1 + Math.floor(Math.random() * (TAP_SOUND_VARIANTS.length - 1))) % TAP_SOUND_VARIANTS.length;
  }
  lastTapSoundIndex = idx;
  return idx;
}

function getFallbackTapAudio(variantIndex) {
  if (!fallbackTapAudios) {
    fallbackTapAudios = new Array(TAP_SOUND_VARIANTS.length).fill(null);
  }
  if (fallbackTapAudios[variantIndex]) {
    return fallbackTapAudios[variantIndex];
  }

  const variant = TAP_SOUND_VARIANTS[variantIndex];
  const sampleRate = 22050;
  const durationSec = 0.24;
  const total = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(total);

  function env(t, a, d) {
    if (t < 0) return 0;
    if (t < a) return t / a;
    return Math.max(0, 1 - (t - a) / d);
  }

  function wave(type, phase) {
    if (type === "triangle") {
      const x = phase - Math.floor(phase + 0.5);
      return 4 * Math.abs(x) - 1;
    }
    return Math.sin(2 * Math.PI * phase);
  }

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const b1 = wave(variant.osc, variant.f1 * t) * env(t, 0.01, variant.d1);
    const t2 = t - variant.gap;
    const b2 = wave(variant.osc, variant.f2 * t2) * env(t2, 0.01, variant.d2);
    samples[i] = (b1 + b2) * 0.22;
  }

  const wavBlob = encodeWavPcm16({ sampleRate, samples });
  const url = URL.createObjectURL(wavBlob);
  const audio = new Audio(url);
  audio.preload = "auto";
  fallbackTapAudios[variantIndex] = audio;
  return audio;
}

function playSnailTapSound() {
  // Must stay gesture-synchronous on mobile: no awaits, no timers.
  let didStart = false;
  const variantIndex = chooseTapSoundIndex();
  const variant = TAP_SOUND_VARIANTS[variantIndex];

  try {
    const ctx = getAudioContext();
    if (ctx.state !== "running") {
      // Don't await; on some browsers awaiting breaks the user-gesture chain.
      void ctx.resume();
    }

    if (ctx.state === "running") {
      const t0 = ctx.currentTime + 0.001;
      const master = ctx.createGain();
      master.gain.value = 0.14;
      master.connect(ctx.destination);

      function boop(start, freqHz, duration) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = variant.osc;
        osc.frequency.setValueAtTime(freqHz, start);
        osc.frequency.exponentialRampToValueAtTime(freqHz * variant.glide, start + duration * 0.35);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(1, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(g);
        g.connect(master);
        osc.start(start);
        osc.stop(start + duration + 0.03);
      }

      boop(t0, variant.f1, variant.d1);
      boop(t0 + variant.gap, variant.f2, variant.d2);

      master.gain.setValueAtTime(0.14, t0 + 0.2);
      master.gain.linearRampToValueAtTime(0.0001, t0 + 0.24);
      didStart = true;
    }
  } catch {
    // ignore; we'll try fallback below
  }

  if (didStart) {
    return;
  }

  try {
    const audio = getFallbackTapAudio(variantIndex);
    audio.currentTime = 0;
    void audio.play();
  } catch {
    // If audio is unavailable or blocked, ignore.
  }
}

const state = {
  x: 0,
  y: 0,
  headingX: 1,
  headingY: 0,
  lastTick: performance.now(),
  nextWanderAt: performance.now() + 1800,
  tapTimes: [],
  tapBurstTarget: null,
  dashing: false,
  sleeping: false,
  sleepTimer: null
};

function randomIntInclusive(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function randomHeading() {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function normalize(x, y) {
  const magnitude = Math.hypot(x, y) || 1;
  return { x: x / magnitude, y: y / magnitude };
}

function stageBounds() {
  return {
    maxX: Math.max(0, stageEl.clientWidth - SNAIL_SIZE),
    maxY: Math.max(0, stageEl.clientHeight - SNAIL_SIZE)
  };
}

function setHeading(x, y) {
  const normalized = normalize(x, y);
  state.headingX = normalized.x;
  state.headingY = normalized.y;
}

function clampToStage() {
  const { maxX, maxY } = stageBounds();
  state.x = Math.max(0, Math.min(maxX, state.x));
  state.y = Math.max(0, Math.min(maxY, state.y));
}

function renderSnail() {
  snailEl.style.setProperty("--x", `${state.x}px`);
  snailEl.style.setProperty("--y", `${state.y}px`);

  const facing = state.headingX < 0 ? -1 : 1;
  snailEl.style.setProperty("--flip", facing);
}

function randomizeWanderSlightly() {
  // Keep movement feeling alive while still generally in current direction.
  const delta = (Math.random() - 0.5) * (Math.PI / 2.8);
  const angle = Math.atan2(state.headingY, state.headingX) + delta;
  setHeading(Math.cos(angle), Math.sin(angle));
  state.nextWanderAt = performance.now() + 1800 + Math.random() * 2200;
}

function pickRandomEdgePoint() {
  const { maxX, maxY } = stageBounds();
  const side = Math.floor(Math.random() * 4);

  if (side === 0) {
    return { x: Math.random() * maxX, y: 0 };
  }
  if (side === 1) {
    return { x: maxX, y: Math.random() * maxY };
  }
  if (side === 2) {
    return { x: Math.random() * maxX, y: maxY };
  }

  return { x: 0, y: Math.random() * maxY };
}

function addLightningSegment(
  fromCenterX,
  fromCenterY,
  toCenterX,
  toCenterY,
  {
    durationMs = 520,
    thickness = 10,
    opacity = 1,
    widthBoost = 0,
    branch = false
  } = {}
) {
  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  const distance = Math.hypot(dx, dy);

  if (distance < 1.2) {
    return;
  }

  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const jitterDeg = (Math.random() - 0.5) * (branch ? 18 : 10);

  const trail = document.createElement("div");
  trail.className = "light-trail";
  if (branch) {
    trail.classList.add("light-trail--branch");
  }
  trail.style.left = `${fromCenterX}px`;
  trail.style.top = `${fromCenterY - thickness / 2}px`;
  trail.style.width = `${distance + widthBoost}px`;
  trail.style.transform = `rotate(${angleDeg + jitterDeg}deg)`;
  trail.style.setProperty("--trail-duration", `${durationMs}ms`);
  trail.style.setProperty("--trail-opacity", String(opacity));
  trail.style.setProperty("--trail-thickness", `${thickness}px`);
  trail.style.setProperty("--flicker-delay", `${Math.floor(Math.random() * 90)}ms`);
  effectsEl.append(trail);
  trail.addEventListener("animationend", () => trail.remove(), { once: true });
}

function spawnCrackleSparks(
  centerX,
  centerY,
  {
    count = 4,
    spread = 34,
    durationMin = 120,
    durationJitter = 140,
    sizeMin = 2.6,
    sizeJitter = 2.1
  } = {}
) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 7 + Math.random() * spread;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;

    const spark = document.createElement("div");
    spark.className = "spark";
    spark.style.left = `${centerX}px`;
    spark.style.top = `${centerY}px`;
    spark.style.setProperty("--spark-dx", `${dx}px`);
    spark.style.setProperty("--spark-dy", `${dy}px`);
    spark.style.setProperty("--spark-size", `${sizeMin + Math.random() * sizeJitter}px`);
    spark.style.setProperty("--spark-duration", `${durationMin + Math.random() * durationJitter}ms`);
    spark.style.setProperty("--spark-delay", `${Math.floor(Math.random() * 50)}ms`);
    spark.style.setProperty("--spark-hue", `${36 + Math.floor(Math.random() * 20)}deg`);
    effectsEl.append(spark);
    spark.addEventListener("animationend", () => spark.remove(), { once: true });
  }
}

function spawnLightTrail(fromX, fromY, toX, toY) {
  const fromCenterX = fromX + SNAIL_SIZE / 2;
  const fromCenterY = fromY + SNAIL_SIZE / 2;
  const toCenterX = toX + SNAIL_SIZE / 2;
  const toCenterY = toY + SNAIL_SIZE / 2;

  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  const distance = Math.hypot(dx, dy);

  addLightningSegment(fromCenterX, fromCenterY, toCenterX, toCenterY, {
    durationMs: 460,
    thickness: 13,
    opacity: 1,
    widthBoost: 6
  });

  // A couple of offset strike lines make the trail read as electric, not smoky.
  for (let i = 0; i < 2; i += 1) {
    const offset = (Math.random() - 0.5) * 16;
    addLightningSegment(
      fromCenterX,
      fromCenterY + offset * 0.12,
      toCenterX,
      toCenterY + offset * 0.12,
      {
        durationMs: 420 + Math.random() * 80,
        thickness: 8 + Math.random() * 2,
        opacity: 0.86,
        widthBoost: 2
      }
    );
  }

  if (distance > 24) {
    const branchAnchor = 0.42 + Math.random() * 0.2;
    const branchStartX = fromCenterX + dx * branchAnchor;
    const branchStartY = fromCenterY + dy * branchAnchor;
    const branchLength = Math.min(85, distance * (0.25 + Math.random() * 0.18));
    const direction = Math.atan2(dy, dx);
    const branchAngle = direction + (Math.random() < 0.5 ? -1 : 1) * (0.65 + Math.random() * 0.45);
    const branchEndX = branchStartX + Math.cos(branchAngle) * branchLength;
    const branchEndY = branchStartY + Math.sin(branchAngle) * branchLength;

    addLightningSegment(branchStartX, branchStartY, branchEndX, branchEndY, {
      durationMs: 360,
      thickness: 6.5,
      opacity: 0.92,
      branch: true
    });
  }
}

function spawnTrailSegment(fromX, fromY, toX, toY) {
  const fromCenterX = fromX + SNAIL_SIZE / 2;
  const fromCenterY = fromY + SNAIL_SIZE / 2;
  const toCenterX = toX + SNAIL_SIZE / 2;
  const toCenterY = toY + SNAIL_SIZE / 2;

  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  const distance = Math.hypot(dx, dy);

  if (distance < 1.5) {
    return;
  }

  addLightningSegment(fromCenterX, fromCenterY, toCenterX, toCenterY, {
    durationMs: 560,
    thickness: 8.5 + Math.random() * 2.5,
    opacity: 1,
    widthBoost: 10
  });

  if (distance > 11 && Math.random() < 0.35) {
    const branchLength = Math.max(10, distance * (0.32 + Math.random() * 0.22));
    const heading = Math.atan2(dy, dx);
    const branchHeading = heading + (Math.random() < 0.5 ? -1 : 1) * (0.52 + Math.random() * 0.5);
    const branchEndX = fromCenterX + Math.cos(branchHeading) * branchLength;
    const branchEndY = fromCenterY + Math.sin(branchHeading) * branchLength;
    addLightningSegment(fromCenterX, fromCenterY, branchEndX, branchEndY, {
      durationMs: 340,
      thickness: 6,
      opacity: 0.9,
      branch: true
    });
  }

  if (Math.random() < 0.2) {
    spawnCrackleSparks(toCenterX, toCenterY, {
      count: 1,
      spread: 16,
      durationMin: 90,
      durationJitter: 70,
      sizeMin: 1.8,
      sizeJitter: 1.6
    });
  }
}

function spawnImpactFlash(toX, toY) {
  const toCenterX = toX + SNAIL_SIZE / 2;
  const toCenterY = toY + SNAIL_SIZE / 2;

  const impact = document.createElement("div");
  impact.className = "impact-flash";
  impact.style.left = `${toCenterX - 10}px`;
  impact.style.top = `${toCenterY - 10}px`;
  effectsEl.append(impact);
  impact.addEventListener("animationend", () => impact.remove(), { once: true });

  spawnCrackleSparks(toCenterX, toCenterY, {
    count: 7,
    spread: 44,
    durationMin: 140,
    durationJitter: 170,
    sizeMin: 2.7,
    sizeJitter: 2.3
  });
}

function spawnScreenFlash() {
  const flash = document.createElement("div");
  flash.className = "screen-flash";
  effectsEl.append(flash);
  flash.addEventListener("animationend", () => flash.remove(), { once: true });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function triggerSleep() {
  if (state.sleeping) {
    return;
  }

  state.sleeping = true;
  state.dashing = false;
  snailEl.classList.add("is-sleeping");
  setStatus("Too many taps... nap time 💤");

  if (state.sleepTimer) {
    clearTimeout(state.sleepTimer);
  }

  const wakeHeading = { x: state.headingX, y: state.headingY };
  state.tapTimes = [];
  state.tapBurstTarget = null;

  state.sleepTimer = setTimeout(() => {
    state.sleeping = false;
    snailEl.classList.remove("is-sleeping");
    setHeading(wakeHeading.x, wakeHeading.y);
    setStatus("Awake again. Back to the slow crawl.");
  }, SLEEP_DURATION_MS);
}

function dashToRandomEdge() {
  if (state.sleeping || state.dashing) {
    return;
  }

  state.dashing = true;
  const startX = state.x;
  const startY = state.y;
  const target = pickRandomEdgePoint();
  const dashDirection = normalize(target.x - startX, target.y - startY);
  setHeading(dashDirection.x, dashDirection.y);

  spawnScreenFlash();
  spawnLightTrail(startX, startY, target.x, target.y);
  spawnCrackleSparks(startX + SNAIL_SIZE / 2, startY + SNAIL_SIZE / 2, {
    count: 4,
    spread: 26,
    durationMin: 100,
    durationJitter: 95,
    sizeMin: 2,
    sizeJitter: 1.8
  });
  setStatus("Wheee! Light-speed snail!");

  const dashStartedAt = performance.now();
  let previousX = startX;
  let previousY = startY;

  function dashStep(now) {
    if (!state.dashing || state.sleeping) {
      return;
    }

    const elapsed = now - dashStartedAt;
    const progress = Math.min(elapsed / DASH_DURATION_MS, 1);
    const eased = 1 - (1 - progress) ** 3;

    state.x = startX + (target.x - startX) * eased;
    state.y = startY + (target.y - startY) * eased;
    spawnTrailSegment(previousX, previousY, state.x, state.y);
    previousX = state.x;
    previousY = state.y;
    renderSnail();

    if (progress < 1) {
      requestAnimationFrame(dashStep);
      return;
    }

    state.dashing = false;
    spawnImpactFlash(target.x, target.y);
    randomizeWanderSlightly();
    setStatus("Slow and shiny.");
  }

  requestAnimationFrame(dashStep);
}

function registerTap() {
  if (state.sleeping) {
    return;
  }

  playSnailTapSound();

  const now = performance.now();
  state.tapTimes = state.tapTimes.filter((time) => now - time <= TAP_WINDOW_MS);

  // If the rapid-tap streak broke, pick a fresh (fun) random target for this streak.
  if (state.tapTimes.length === 0) {
    state.tapBurstTarget = randomIntInclusive(TAP_BURST_TAPS_MIN, TAP_BURST_TAPS_MAX);
  }
  state.tapTimes.push(now);

  if (state.tapBurstTarget && state.tapTimes.length >= state.tapBurstTarget) {
    triggerSleep();
    return;
  }

  dashToRandomEdge();
}

function tick(now) {
  const deltaTime = Math.min((now - state.lastTick) / 1000, 0.06);
  state.lastTick = now;

  if (!state.sleeping && !state.dashing) {
    state.x += state.headingX * CRAWL_SPEED * deltaTime;
    state.y += state.headingY * CRAWL_SPEED * deltaTime;

    const bounds = stageBounds();
    let bounced = false;

    if (state.x <= 0 || state.x >= bounds.maxX) {
      state.headingX *= -1;
      bounced = true;
    }
    if (state.y <= 0 || state.y >= bounds.maxY) {
      state.headingY *= -1;
      bounced = true;
    }

    clampToStage();

    if (bounced) {
      randomizeWanderSlightly();
    } else if (now >= state.nextWanderAt) {
      randomizeWanderSlightly();
    }
  }

  renderSnail();
  requestAnimationFrame(tick);
}

function initialize() {
  const { maxX, maxY } = stageBounds();
  const initialHeading = randomHeading();
  setHeading(initialHeading.x, initialHeading.y);

  state.x = Math.random() * maxX;
  state.y = Math.random() * maxY;
  state.lastTick = performance.now();

  renderSnail();
  requestAnimationFrame(tick);
}

snailEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  snailEl.blur();
  registerTap();
});

window.addEventListener("resize", () => {
  clampToStage();
  renderSnail();
});

initialize();
