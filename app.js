const stageEl = document.getElementById("stage");
const effectsEl = document.getElementById("effects");
const snailEl = document.getElementById("snail");
const statusEl = document.getElementById("status");

const SNAIL_SIZE = 62;
const CRAWL_SPEED = 14; // pixels per second
const DASH_DURATION_MS = 340;
const TAP_WINDOW_MS = 1300;
const TAP_BURST_THRESHOLD = 3;
const SLEEP_DURATION_MS = 3000;

const state = {
  x: 0,
  y: 0,
  headingX: 1,
  headingY: 0,
  lastTick: performance.now(),
  nextWanderAt: performance.now() + 1800,
  tapTimes: [],
  dashing: false,
  sleeping: false,
  sleepTimer: null
};

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

function spawnLightTrail(fromX, fromY, toX, toY) {
  const fromCenterX = fromX + SNAIL_SIZE / 2;
  const fromCenterY = fromY + SNAIL_SIZE / 2;
  const toCenterX = toX + SNAIL_SIZE / 2;
  const toCenterY = toY + SNAIL_SIZE / 2;

  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  const distance = Math.hypot(dx, dy);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  const trail = document.createElement("div");
  trail.className = "light-trail";
  trail.style.left = `${fromCenterX}px`;
  trail.style.top = `${fromCenterY - 4.5}px`;
  trail.style.width = `${distance}px`;
  trail.style.transform = `rotate(${angleDeg}deg)`;
  effectsEl.append(trail);
  trail.addEventListener("animationend", () => trail.remove(), { once: true });

  const impact = document.createElement("div");
  impact.className = "impact-flash";
  impact.style.left = `${toCenterX - 10}px`;
  impact.style.top = `${toCenterY - 10}px`;
  effectsEl.append(impact);
  impact.addEventListener("animationend", () => impact.remove(), { once: true });
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

  spawnLightTrail(startX, startY, target.x, target.y);
  setStatus("Wheee! Light-speed snail!");

  const dashStartedAt = performance.now();

  function dashStep(now) {
    if (!state.dashing || state.sleeping) {
      return;
    }

    const elapsed = now - dashStartedAt;
    const progress = Math.min(elapsed / DASH_DURATION_MS, 1);
    const eased = 1 - (1 - progress) ** 3;

    state.x = startX + (target.x - startX) * eased;
    state.y = startY + (target.y - startY) * eased;
    renderSnail();

    if (progress < 1) {
      requestAnimationFrame(dashStep);
      return;
    }

    state.dashing = false;
    randomizeWanderSlightly();
    setStatus("Slow and shiny.");
  }

  requestAnimationFrame(dashStep);
}

function registerTap() {
  if (state.sleeping) {
    return;
  }

  const now = performance.now();
  state.tapTimes = state.tapTimes.filter((time) => now - time <= TAP_WINDOW_MS);
  state.tapTimes.push(now);

  if (state.tapTimes.length >= TAP_BURST_THRESHOLD) {
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
  registerTap();
});

window.addEventListener("resize", () => {
  clampToStage();
  renderSnail();
});

initialize();
