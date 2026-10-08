/**
 * Scene choreography data for the landing page.
 *
 * A "pose" places the satellite (s*) and the Earth (e*) in world units for a
 * camera at z=8 / fov 40 (visible half-height ≈ 2.9). GSAP tweens the single
 * shared pose object; the Three.js scene only ever reads it — so the launch
 * intro and the scroll journey hand over without a cut.
 *
 * The Earth is only drawn inside the dark cards (hero, live) and is placed
 * relative to the card on screen, so the e* values of the light sections in
 * between only matter while one of those cards is still partly in view.
 */

/** Satellite hidden inside the fairing, Earth filling the bottom of the frame. */
export const LAUNCH_POSE = {
    sx: 0, sy: -0.3, sz: 0, srx: 0, sry: 0, srz: 0, ss: 0.0001,
    ex: 0, ey: -11.25, ez: 0, es: 9,
    beam: 0, idle: 0,
};

/** One pose per `.scene` section, in document order. */
export const SCENE_POSES = [
    { id: 'hero',     sx: 2.5,  sy: 0.95, sz: 0,   srx: 0.5,  sry: 0.6,   srz: 0.14,  ss: 1.0,  ex: 3.3, ey: -3.4, ez: -1, es: 3.4, beam: 0, idle: 1 },
    { id: 'analyses', sx: 3.9,  sy: 2.1,  sz: -1,  srx: 0.55, sry: 1.4,   srz: 0.2,   ss: 0.42, ex: 2.3, ey: -5.0, ez: -1, es: 4.2, beam: 0, idle: 1 },
    { id: 'showcase', sx: -4.3, sy: 2.2,  sz: -1,  srx: 0.6,  sry: 2.2,   srz: -0.2,  ss: 0.36, ex: 2.3, ey: -5.0, ez: -1, es: 4.2, beam: 0, idle: 1 },
    { id: 'agents',   sx: -4.0, sy: 1.75, sz: -1,  srx: 0.6,  sry: 3.0,   srz: 0.3,   ss: 0.55, ex: 2.3, ey: -5.0, ez: -1, es: 4.2, beam: 0, idle: 1 },
    { id: 'pipeline', sx: 3.5,  sy: 2.0,  sz: -1,  srx: 0.6,  sry: 3.8,   srz: -0.3,  ss: 0.45, ex: 2.3, ey: -5.0, ez: -1, es: 4.2, beam: 0, idle: 1 },
    { id: 'live',     sx: 2.3,  sy: 1.5,  sz: 0,   srx: 0.7,  sry: 4.6,   srz: 0.1,   ss: 0.6,  ex: 3.3, ey: -5.6, ez: -1, es: 4.2, beam: 1, idle: 1 },
];

/** Rocket / launch-only state. Everything is 0..1 except rocketY and starY. */
export const LAUNCH_STATE = {
    rocketY: -2.25, flame: 0, shake: 0, sep: 0, fair: 0, panels: 0, streak: 0, starY: 0,
};

/** Strip the `id` so a pose can be handed straight to a tween. */
export function poseVars(pose) {
    const vars = { ...pose };
    delete vars.id;
    return vars;
}

/**
 * Turn section offsets into scroll-timeline segments, so the satellite reaches
 * each pose exactly as its section reaches the top of the viewport — however
 * tall the sections end up being.
 *
 * @param {number[]} tops  offsetTop of each scene, ascending
 * @param {number} scrollable  total scroll distance of the journey
 * @returns {{segments: {from: number, to: number, start: number, duration: number}[], tail: number}}
 */
export function journeySegments(tops, scrollable) {
    const origin = tops[0] ?? 0;
    const segments = [];
    for (let i = 1; i < tops.length; i++) {
        const start = tops[i - 1] - origin;
        const duration = Math.max(1, tops[i] - tops[i - 1]);
        segments.push({ from: i - 1, to: i, start, duration });
    }
    const covered = tops.length ? tops[tops.length - 1] - origin : 0;
    return { segments, tail: Math.max(0, scrollable - covered) };
}
