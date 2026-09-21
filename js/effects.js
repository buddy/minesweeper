const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT = 'cubic-bezier(.23, 1, .32, 1)';

export function mineBlast(boardEl, cellEl) {
  if (reduceMotion.matches || !cellEl) return;
  boardEl.animate([
    { transform: 'translate3d(0, 0, 0)' },
    { transform: 'translate3d(-3px, 1px, 0)' },
    { transform: 'translate3d(3px, -1px, 0)' },
    { transform: 'translate3d(-2px, 1px, 0)' },
    { transform: 'translate3d(2px, 0, 0)' },
    { transform: 'translate3d(0, 0, 0)' },
  ], { duration: 320, easing: 'ease-out' });

  cellEl.animate([{ filter: 'brightness(2.6)' }, { filter: 'brightness(1)' }], {
    duration: 420,
    easing: EASE_OUT,
  });

  const size = cellEl.offsetWidth;
  const ring = document.createElement('span');
  ring.className = 'mine-blast';
  ring.style.left = `${cellEl.offsetLeft + size / 2}px`;
  ring.style.top = `${cellEl.offsetTop + cellEl.offsetHeight / 2}px`;
  ring.style.width = `${size}px`;
  ring.style.height = `${size}px`;
  boardEl.append(ring);
  const wave = ring.animate([
    { transform: 'translate(-50%, -50%) scale(.6)', opacity: .85 },
    { transform: 'translate(-50%, -50%) scale(7)', opacity: 0 },
  ], { duration: 520, easing: EASE_OUT });
  wave.onfinish = wave.oncancel = () => ring.remove();
}

const CONFETTI_COLORS = ['#adff63', '#adff63', '#adff63', '#d7ff9e', '#f2f2f2', '#70d5f5'];
const CONFETTI_MS = 2600;
const FADE_AFTER_MS = 1700;

export function confettiBurst(container) {
  if (reduceMotion.matches) return;
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width < 80 || height < 80) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const diagonal = Math.hypot(width, height);
  const power = Math.max(7, diagonal / 52);
  const perCannon = Math.round(Math.min(400, Math.max(100, diagonal * .26)));
  const pieces = [];
  for (const [originX, aim] of [[0, 1], [width, -1]]) {
    for (let i = 0; i < perCannon; i++) {
      const angle = Math.PI * (.12 + Math.random() * .34);
      const speed = power * (.72 + Math.random() * .76);
      pieces.push({
        x: originX + aim * Math.random() * 40,
        y: height + Math.random() * 12,
        vx: Math.cos(angle) * speed * aim,
        vy: -Math.sin(angle) * speed,
        w: 3 + Math.random() * 4,
        h: 5 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - .5) * .28,
        flutter: Math.random() * Math.PI * 2,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      });
    }
  }

  const gravity = power * .028;
  let previous = performance.now();
  const startedAt = previous;

  function frame(now) {
    if (!canvas.isConnected) return;
    const elapsed = now - startedAt;
    if (elapsed > CONFETTI_MS) { canvas.remove(); return; }
    const step = Math.min(3, (now - previous) / 16.7);
    previous = now;
    const alpha = Math.max(0, Math.min(1, (CONFETTI_MS - elapsed) / (CONFETTI_MS - FADE_AFTER_MS)));

    ctx.clearRect(0, 0, width, height);
    for (const piece of pieces) {
      piece.vy += gravity * step;
      piece.vx *= 0.985 ** step;
      piece.x += piece.vx * step;
      piece.y += piece.vy * step;
      piece.rot += piece.spin * step;
      piece.flutter += .18 * step;
      if (piece.y - piece.h > height) continue;
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = piece.color;
      const h = piece.h * Math.abs(Math.cos(piece.flutter));
      ctx.fillRect(-piece.w / 2, -h / 2, piece.w, h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
