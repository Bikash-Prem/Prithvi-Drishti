/**
 * Prithvi Drishti landing page bootstrap.
 *
 *  1. Launch intro  — a GSAP timeline flies the rocket, separates the stages,
 *     deploys the satellite and parks it in the hero pose. The page is already
 *     the home page underneath; the intro just lifts off it.
 *  2. Scroll journey — a scrubbed GSAP timeline carries the same satellite
 *     through one pose per section, down to the end of the page.
 *
 * Both tween one shared `pose` object that the Three.js scene reads, so there
 * is no cut between the two. Reduced-motion and no-WebGL visitors skip
 * straight to a static, fully readable page.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { LAUNCH_POSE, LAUNCH_STATE, SCENE_POSES, journeySegments, poseVars } from './poses.js';
import { initAgentCarousel } from './carousel.js';
import { createSpaceScene } from './scene.js';
import { initSimulateButton, initStatus } from './status.js';

gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const pose = { ...LAUNCH_POSE };
const launch = { ...LAUNCH_STATE };
const telemetry = { alt: 0, vel: 0 };

let space = null;
let journey = null;

function bootstrap() {
    // Always start the intro from the top, even on reload.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);

    try {
        space = createSpaceScene(document.getElementById('space-canvas'), pose, launch, { reducedMotion });
        gsap.ticker.add((time) => space.render(time));
    } catch (e) {
        console.warn('WebGL unavailable — using the static backdrop.', e);
        root.classList.add('no-webgl');
    }

    initStatus();
    initSimulateButton();
    initCompare();

    const intro = buildIntro();
    if (reducedMotion || !space) {
        intro.progress(1);
        return;
    }
    const skip = () => intro.progress(1);
    document.getElementById('launch-skip')?.addEventListener('click', skip);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') skip(); }, { once: true });
    intro.play();
}

// ── 1. Launch intro ──────────────────────────────────────────────────

function buildIntro() {
    const count = document.getElementById('hud-count');
    const stage = document.getElementById('hud-stage');
    const alt = document.getElementById('hud-alt');
    const vel = document.getElementById('hud-vel');

    const setCount = (text) => {
        count.textContent = text;
        gsap.fromTo(count, { scale: 1.35, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.3, ease: 'power3.out' });
    };
    const setStage = (text) => { stage.textContent = text; };
    const renderTelemetry = () => {
        alt.textContent = Math.round(telemetry.alt);
        vel.textContent = telemetry.vel.toFixed(2);
    };

    gsap.set('#site-nav', { autoAlpha: 0, yPercent: -60 });
    gsap.set('.hero-in', { autoAlpha: 0, y: 30 });
    gsap.set('#orbit-rail', { autoAlpha: 0 });

    const hero = poseVars(SCENE_POSES[0]);
    const tl = gsap.timeline({ paused: true, onComplete: onOrbit });

    // Countdown + ignition
    ['3', '2', '1'].forEach((n, i) => tl.call(setCount, [n], i * 0.45));
    tl.to(launch, { flame: 0.35, shake: 0.6, duration: 0.55, ease: 'power2.in' }, 0.75)

        // Liftoff
        .call(setCount, ['GO'], 1.35)
        .call(setStage, ['Liftoff'], 1.35)
        .to(launch, { flame: 1, shake: 1, duration: 0.3 }, 1.35)
        .to(launch, { rocketY: -1.0, streak: 1, starY: -22, duration: 2.3, ease: 'power2.in' }, 1.35)
        .to(pose, { ey: -17.5, es: 7.5, duration: 2.3, ease: 'power2.in' }, 1.35)
        .to(telemetry, { alt: 210, vel: 4.6, duration: 2.3, ease: 'power2.in', onUpdate: renderTelemetry }, 1.35)
        .to(launch, { shake: 0.25, duration: 1.5 }, 1.9)
        .to(count, { autoAlpha: 0, duration: 0.4 }, 2.1)

        // Stage separation + fairing jettison
        .call(setStage, ['Stage separation'], 3.65)
        .fromTo('#launch-flash', { opacity: 0.5 }, { opacity: 0, duration: 0.7, ease: 'power2.out' }, 3.65)
        .to(launch, { flame: 0, duration: 0.2 }, 3.65)
        .to(launch, { shake: 0, duration: 0.4 }, 3.65)
        .to(launch, { sep: 1, duration: 1.3, ease: 'power1.in' }, 3.65)
        .to(launch, { fair: 1, duration: 1.1, ease: 'power2.out' }, 3.85)
        .set(pose, { sx: 0, sy: 0.75, srx: 0.15, sry: 0.5 }, 3.85)
        .to(pose, { ss: 0.72, duration: 0.7, ease: 'back.out(1.6)' }, 3.9)
        .to(launch, { streak: 0, duration: 1 }, 3.9)
        .to(telemetry, { alt: 520, vel: 7.1, duration: 1.4, ease: 'none', onUpdate: renderTelemetry }, 3.65)

        // Solar array deployment
        .call(setStage, ['Deploying solar arrays'], 4.7)
        .to(launch, { panels: 1, duration: 0.9, ease: 'power2.inOut' }, 4.7)
        .to(pose, { sry: 1.4, duration: 0.9, ease: 'sine.inOut' }, 4.7)

        // Orbit — glide into the hero pose while the page comes up around it
        .call(setStage, ['Orbit achieved'], 5.6)
        .to(pose, { ...hero, duration: 1.5, ease: 'power3.inOut' }, 5.6)
        .to(telemetry, { alt: 693, vel: 7.5, duration: 1.2, ease: 'power2.out', onUpdate: renderTelemetry }, 5.6)
        // The full-screen launch view settles into the inset hero card.
        .call(() => root.classList.add('is-orbit'), null, 6.0)
        .to('#launch-hud', { autoAlpha: 0, duration: 0.5 }, 6.5)
        .to('#site-nav', { autoAlpha: 1, yPercent: 0, duration: 0.7, ease: 'power3.out' }, 6.5)
        .to('.hero-in', { autoAlpha: 1, y: 0, duration: 0.8, stagger: 0.09, ease: 'power3.out' }, 6.55)
        .to('#orbit-rail', { autoAlpha: 1, duration: 0.6 }, 6.9)
        .to('#hud-progress', { scaleX: 1, duration: 6.5, ease: 'none' }, 0);

    return tl;
}

/** Intro finished (or skipped): unlock scrolling and start the journey. */
function onOrbit() {
    document.getElementById('launch-hud')?.remove();
    root.classList.remove('is-launching');

    if (reducedMotion) return; // static page: everything already visible

    initAgentCarousel();
    initReveals();
    if (space) {
        buildJourney();
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(buildJourney, 200);
        });
        // Web fonts change section heights after first layout.
        document.fonts?.ready.then(buildJourney);
    }
    ScrollTrigger.refresh();
}

// ── 2. Scroll journey ────────────────────────────────────────────────

function buildJourney() {
    if (journey) {
        journey.scrollTrigger?.kill();
        journey.kill();
    }
    const scenes = gsap.utils.toArray('.scene');
    const main = document.getElementById('journey');
    const scrollable = Math.max(1, main.offsetHeight - window.innerHeight);
    const { segments, tail } = journeySegments(scenes.map((s) => s.offsetTop), scrollable);

    const railFill = gsap.quickSetter('#rail-fill', 'scaleY');
    const railSat = gsap.quickSetter('#rail-sat', 'y', 'px');
    const rail = document.getElementById('orbit-rail');

    journey = gsap.timeline({
        scrollTrigger: {
            trigger: main,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 1.1,
            onUpdate(self) {
                space.setScroll(self.progress);
                railFill(self.progress);
                railSat(self.progress * rail.offsetHeight);
            },
        },
    });

    segments.forEach(({ from, to, start, duration }) => {
        journey.fromTo(
            pose,
            poseVars(SCENE_POSES[from]),
            { ...poseVars(SCENE_POSES[to]), duration, ease: 'power1.inOut', immediateRender: false },
            start,
        );
    });
    if (tail > 0) journey.to({}, { duration: tail });
}

function initReveals() {
    gsap.set('.reveal', { autoAlpha: 0, y: 36 });
    ScrollTrigger.batch('.reveal', {
        start: 'top 88%',
        once: true,
        onEnter: (batch) => gsap.to(batch, {
            autoAlpha: 1, y: 0, duration: 0.9, stagger: 0.07, ease: 'power3.out', overwrite: true,
        }),
    });
}

/** Before/after slider: a range input drives how much of the earlier image shows. */
function initCompare() {
    const figure = document.getElementById('compare');
    const range = figure?.querySelector('.compare-range');
    if (!range) return;
    const apply = () => figure.style.setProperty('--split', `${range.value}%`);
    range.addEventListener('input', apply);
    apply();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
