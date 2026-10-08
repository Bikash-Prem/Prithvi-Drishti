/**
 * Agent ring — a 3D carousel of the eight agent cards.
 *
 * The cards sit on a cylinder (CSS 3D transforms; they stay real DOM so the
 * live "online" dots keep working). GSAP drives one number, the ring angle:
 * auto-advance, drag / fling, arrow buttons, click-to-front, plus a small
 * scroll-linked turn as the section passes through the viewport.
 *
 * Progressive: without this module (or with reduced motion) `.agent-grid`
 * is simply the static grid defined in landing.css.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const GAP_PX = 46;          // breathing room between neighbouring cards
const DRAG_DEG_PER_PX = 0.32;
const AUTO_ADVANCE_S = 3.4;

/** Angle (deg) that puts the nearest card dead centre. */
export function snapAngle(angle, count) {
    const step = 360 / count;
    return Math.round(angle / step) * step;
}

/** Index of the card facing the viewer at `angle` (handles negatives/wraps). */
export function frontIndex(angle, count) {
    const step = 360 / count;
    return ((Math.round(angle / step) % count) + count) % count;
}

/** Cylinder radius so `count` cards of `width` px sit side by side + gap. */
export function ringRadius(width, count, gap = GAP_PX) {
    return Math.round((width + gap) / 2 / Math.tan(Math.PI / count));
}

/** 1 for the front card falling to 0.3 at the back of the ring. */
export function cardBrightness(relativeDeg) {
    const facing = (Math.cos((relativeDeg * Math.PI) / 180) + 1) / 2;
    return 0.3 + 0.7 * Math.pow(facing, 1.6);
}

export function initAgentCarousel() {
    const stage = document.getElementById('agent-ring');
    const cards = stage ? gsap.utils.toArray('.agent-card', stage) : [];
    if (!stage || cards.length < 3) return null;

    const count = cards.length;
    const step = 360 / count;
    const label = document.getElementById('ring-label');
    const state = { angle: 0, scroll: 0 };
    let radius = 0;
    let front = -1;
    let paused = false;
    let inView = false;

    // Re-parent the cards onto the rotating ring.
    const ring = document.createElement('div');
    ring.className = 'ring';
    cards.forEach((card) => ring.appendChild(card));
    stage.appendChild(ring);
    stage.classList.add('ring-on');

    function render() {
        const total = state.angle + state.scroll;
        ring.style.transform = `translateZ(${-radius}px) rotateY(${-total}deg)`;
        cards.forEach((card, i) => {
            card.style.opacity = cardBrightness(i * step - total).toFixed(3);
        });
        const now = frontIndex(total, count);
        if (now !== front) {
            front = now;
            cards.forEach((card, i) => card.classList.toggle('is-front', i === front));
            if (label) {
                const name = cards[front].querySelector('h3')?.textContent || '';
                label.textContent = `${String(front + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')} · ${name}`;
            }
        }
    }

    function layout() {
        radius = ringRadius(cards[0].offsetWidth, count);
        cards.forEach((card, i) => {
            card.style.transform = `rotateY(${i * step}deg) translateZ(${radius}px)`;
        });
        render();
    }

    function spinTo(angle, duration = 0.9) {
        gsap.to(state, { angle, duration, ease: 'power3.out', overwrite: true, onUpdate: render });
    }
    const advance = (dir) => spinTo(snapAngle(state.angle, count) + dir * step);

    // Auto-advance while visible and nobody is interacting.
    const tick = () => {
        if (inView && !paused && !document.hidden) advance(1);
        gsap.delayedCall(AUTO_ADVANCE_S, tick);
    };
    gsap.delayedCall(AUTO_ADVANCE_S, tick);

    stage.addEventListener('pointerenter', () => { paused = true; });
    stage.addEventListener('pointerleave', () => { paused = false; });

    // Drag / fling; a press without movement is a click → bring that card front.
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        gsap.killTweensOf(state, 'angle');
        drag = { x: e.clientX, angle: state.angle, lastX: e.clientX, lastT: e.timeStamp, v: 0, moved: false };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add('dragging');
        paused = true;
    });
    stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 6) drag.moved = true;
        const dt = Math.max(1, e.timeStamp - drag.lastT);
        drag.v = (e.clientX - drag.lastX) / dt; // px per ms
        drag.lastX = e.clientX;
        drag.lastT = e.timeStamp;
        state.angle = drag.angle - dx * DRAG_DEG_PER_PX;
        render();
    });
    const endDrag = (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        stage.classList.remove('dragging');
        paused = e.pointerType === 'mouse' && stage.matches(':hover');
        if (d.moved) {
            const fling = -d.v * 160 * DRAG_DEG_PER_PX;
            spinTo(snapAngle(state.angle + fling, count), 1.1);
            return;
        }
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.agent-card');
        const i = cards.indexOf(hit);
        if (i < 0) return;
        // Shortest way round to card i.
        const total = state.angle + state.scroll;
        const delta = ((i * step - total) % 360 + 540) % 360 - 180;
        spinTo(snapAngle(state.angle + delta, count));
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    document.getElementById('ring-prev')?.addEventListener('click', () => advance(-1));
    document.getElementById('ring-next')?.addEventListener('click', () => advance(1));
    stage.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') advance(-1);
        if (e.key === 'ArrowRight') advance(1);
    });

    // A slow extra turn tied to scroll as the section crosses the viewport.
    const section = stage.closest('.scene') || stage;
    gsap.fromTo(state, { scroll: -step * 1.5 }, {
        scroll: step * 1.5,
        ease: 'none',
        onUpdate: render,
        scrollTrigger: {
            trigger: section,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 1,
            onToggle: (self) => { inView = self.isActive; },
        },
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(layout, 150);
    });
    layout();
    ScrollTrigger.refresh();
    return { advance, layout };
}
