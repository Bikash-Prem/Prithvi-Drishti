import { describe, it, expect } from 'vitest';
import { LAUNCH_POSE, SCENE_POSES, journeySegments, poseVars } from '../landing/poses.js';
import { phaseLabel, summarizeOverview } from '../landing/status.js';
import { cardBrightness, frontIndex, ringRadius, snapAngle } from '../landing/carousel.js';

describe('landing poses', () => {
    it('every scene pose tweens the same keys as the launch pose', () => {
        const keys = Object.keys(LAUNCH_POSE).sort();
        for (const pose of SCENE_POSES) {
            expect(Object.keys(poseVars(pose)).sort()).toEqual(keys);
        }
    });

    it('has one pose per landing section, in document order', () => {
        expect(SCENE_POSES.map((p) => p.id)).toEqual(
            ['hero', 'analyses', 'showcase', 'agents', 'pipeline', 'live']);
    });

    it('maps section offsets to contiguous scroll segments plus a tail', () => {
        const { segments, tail } = journeySegments([0, 800, 2000], 2300);
        expect(segments).toEqual([
            { from: 0, to: 1, start: 0, duration: 800 },
            { from: 1, to: 2, start: 800, duration: 1200 },
        ]);
        expect(tail).toBe(300);
    });

    it('never produces a negative tail or zero-length segment', () => {
        const { segments, tail } = journeySegments([100, 100], 0);
        expect(segments[0].duration).toBe(1);
        expect(tail).toBe(0);
    });
});

describe('landing status', () => {
    it('formats phase ids for display', () => {
        expect(phaseLabel('02_IMMINENT')).toBe('Imminent');
        expect(phaseLabel('05_POST_FLOOD')).toBe('Post flood');
        expect(phaseLabel('')).toBe('—');
    });

    it('reports offline honestly — no invented numbers', () => {
        const s = summarizeOverview(null);
        expect(s.online).toBe(false);
        expect(s.tiles.system).toEqual({ text: 'Offline', tone: 'bad' });
        expect(s.tiles.agents.text).toBe('—');
        expect(s.tiles.events.text).toBe('—');
        expect(s.phaseIndex).toBe(-1);
    });

    it('summarizes a live overview payload', () => {
        const s = summarizeOverview({
            ready: true,
            phase: { current: '01_ELEVATED', index: 1 },
            agents: Array.from({ length: 8 }, (_, i) => ({ agent_id: `a${i}` })),
            llm: { available: false, fleet: ['null'] },
            connectors: { openmeteo: { is_mock: false }, osm: { is_mock: true } },
            events: { total_emits: 42, handler_errors: 0 },
        });
        expect(s.tiles.system.text).toBe('Online');
        expect(s.tiles.phase.text).toBe('Elevated');
        expect(s.tiles.agents).toEqual({ text: '8 / 8', tone: 'ok' });
        expect(s.tiles.llm.text).toBe('Deterministic');
        expect(s.tiles.events.text).toBe('42');
        expect(s.note).toContain('1 of 2 data connectors set to live mode');
        expect(s.agentIds).toHaveLength(8);
        expect(s.phaseIndex).toBe(1);
    });
});

describe('agent ring maths', () => {
    it('snaps to the nearest card', () => {
        expect(snapAngle(50, 8)).toBe(45);
        expect(snapAngle(-70, 8)).toBe(-90);
        expect(snapAngle(22, 8)).toBe(0);
    });

    it('finds the front card through wraps and negative angles', () => {
        expect(frontIndex(0, 8)).toBe(0);
        expect(frontIndex(45, 8)).toBe(1);
        expect(frontIndex(360 + 90, 8)).toBe(2);
        expect(frontIndex(-45, 8)).toBe(7);
    });

    it('sizes the cylinder so neighbouring cards do not overlap', () => {
        const r = ringRadius(300, 8, 0);
        // each card subtends 360/8 degrees: half-width over radius = tan(pi/8)
        expect(r * Math.tan(Math.PI / 8) * 2).toBeGreaterThanOrEqual(299);
        expect(ringRadius(300, 8, 46)).toBeGreaterThan(r);
    });

    it('dims cards toward the back of the ring', () => {
        expect(cardBrightness(0)).toBeCloseTo(1);
        expect(cardBrightness(180)).toBeCloseTo(0.3);
        expect(cardBrightness(90)).toBeLessThan(cardBrightness(45));
    });
});
