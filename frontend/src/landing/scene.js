/**
 * Three.js scene for the landing page: star field, procedural Earth, launch
 * vehicle, and the Prithvi Drishti satellite with its sensing beam.
 *
 * The scene owns no animation state of its own. It reads two plain objects —
 * `pose` (satellite + Earth placement) and `launch` (rocket sequence) — that
 * GSAP tweens from landing.js, and draws whatever they say each frame.
 * Stars, Earth and rocket are procedural. The satellite is NASA's public 3D
 * model of Landsat 8, an Earth-imaging satellite (`/models/landsat8.glb`, from NASA 3D Resources — free
 * and without copyright), lit with an environment map so its foil and panels
 * read as real materials; the simple procedural satellite is only shown if
 * that file cannot be loaded.
 *
 * The canvas is transparent and drawn in two passes. Space (stars, Earth) is
 * clipped to whichever dark `[data-space]` card is on screen and the Earth is
 * anchored to that card, so it scrolls away with it. The satellite, beam and
 * rocket are drawn unclipped, so the satellite carries on over the light page.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const CAMERA_Z = 8;
const FOV = 40;
const SPACE_LAYER = 0;      // stars + Earth: only inside the dark cards
const CRAFT_LAYER = 1;      // satellite, beam, rocket: everywhere
const SPACE_COLOR = 0x03060f;
const SATELLITE_MODEL = '/models/landsat8.glb';
const SATELLITE_SPAN = 2.3;                       // world units across its longest side
const SATELLITE_ATTITUDE = [0, Math.PI * 0.25, 0]; // rotate so both solar arrays face the viewer
const SUN_DIR = new THREE.Vector3(-0.55, 0.45, 0.7).normalize();
const BEACON_COLOR = new THREE.Color(0xff4d4d);

// ── Small texture helpers ────────────────────────────────────────────

function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}

function solarPanelTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#0a1a45';
    g.fillRect(0, 0, 256, 128);
    for (let x = 0; x < 256; x += 32) {
        for (let y = 0; y < 128; y += 32) {
            const grad = g.createLinearGradient(x, y, x + 32, y + 32);
            grad.addColorStop(0, '#16378f');
            grad.addColorStop(1, '#0b1f5c');
            g.fillStyle = grad;
            g.fillRect(x + 2, y + 2, 28, 28);
        }
    }
    g.strokeStyle = 'rgba(150,190,255,.55)';
    g.lineWidth = 1;
    for (let x = 0; x <= 256; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    for (let y = 0; y <= 128; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// ── Stars ────────────────────────────────────────────────────────────

function buildStars(sprite) {
    const count = 2600;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 150;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 170;
        positions[i * 3 + 2] = -18 - Math.random() * 80;
        tint.setHSL(0.55 + Math.random() * 0.12, 0.5, 0.55 + Math.random() * 0.45);
        const dim = 0.35 + Math.random() * 0.65;
        colors[i * 3] = tint.r * dim;
        colors[i * 3 + 1] = tint.g * dim;
        colors[i * 3 + 2] = tint.b * dim;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
        size: 0.5, map: sprite, vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    return new THREE.Points(geo, mat);
}

/** Vertical streaks that sell the ascent speed; recycled top-to-bottom. */
function buildSpeedLines() {
    const count = 90;
    const positions = new Float32Array(count * 6);
    const lines = [];
    for (let i = 0; i < count; i++) {
        lines.push({
            x: (Math.random() - 0.5) * 16,
            y: (Math.random() - 0.5) * 12,
            z: -7 + Math.random() * 8,
            len: 0.5 + Math.random() * 1.4,
            speed: 9 + Math.random() * 10,
        });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color: 0x9fd4ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.frustumCulled = false;

    function update(dt, streak) {
        mat.opacity = streak * 0.55;
        mesh.visible = streak > 0.01;
        if (!mesh.visible) return;
        for (let i = 0; i < count; i++) {
            const l = lines[i];
            l.y -= l.speed * dt * streak;
            if (l.y < -6) l.y += 12;
            const o = i * 6;
            positions[o] = l.x; positions[o + 1] = l.y; positions[o + 2] = l.z;
            positions[o + 3] = l.x; positions[o + 4] = l.y + l.len * (0.3 + streak); positions[o + 5] = l.z;
        }
        geo.attributes.position.needsUpdate = true;
    }
    return { mesh, update };
}

// ── Earth ────────────────────────────────────────────────────────────

const NOISE_GLSL = /* glsl */`
    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float a = 0.5;
        float s = 0.0;
        for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; }
        return s;
    }
`;

function buildEarth() {
    const group = new THREE.Group();
    group.rotation.z = 0.41; // axial tilt

    const uniforms = { uSunDir: { value: SUN_DIR }, uTime: { value: 0 } };
    const surface = new THREE.Mesh(
        new THREE.SphereGeometry(1, 96, 96),
        new THREE.ShaderMaterial({
            uniforms,
            vertexShader: /* glsl */`
                varying vec3 vObj;
                varying vec3 vNormalW;
                varying vec3 vWorldPos;
                void main() {
                    vObj = position;
                    vNormalW = normalize(mat3(modelMatrix) * normal);
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vWorldPos = wp.xyz;
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uSunDir;
                uniform float uTime;
                varying vec3 vObj;
                varying vec3 vNormalW;
                varying vec3 vWorldPos;
                ${NOISE_GLSL}
                void main() {
                    vec3 n = normalize(vNormalW);
                    vec3 v = normalize(cameraPosition - vWorldPos);

                    float h = fbm(vObj * 2.2 + 3.7);
                    float land = smoothstep(0.48, 0.52, h);
                    vec3 ocean = mix(vec3(0.01, 0.06, 0.20), vec3(0.02, 0.19, 0.42), smoothstep(0.30, 0.50, h));
                    vec3 ground = mix(vec3(0.06, 0.25, 0.10), vec3(0.42, 0.36, 0.22), smoothstep(0.56, 0.70, h));
                    ground = mix(ground, vec3(0.88), smoothstep(0.72, 0.80, h));
                    vec3 col = mix(ocean, ground, land);

                    float ice = smoothstep(0.90, 0.98, abs(vObj.y) + (h - 0.5) * 0.12);
                    col = mix(col, vec3(0.92, 0.96, 1.0), ice);

                    float clouds = smoothstep(0.56, 0.78,
                        fbm(vObj * 3.4 + vec3(uTime * 0.012, 0.0, uTime * 0.008) + 11.0));

                    float diff = dot(n, uSunDir);
                    float day = smoothstep(-0.15, 0.35, diff);
                    vec3 lit = col * (0.05 + 1.15 * max(diff, 0.0));

                    vec3 hlf = normalize(uSunDir + v);
                    lit += pow(max(dot(n, hlf), 0.0), 60.0) * (1.0 - land) * 0.6;
                    lit = mix(lit, vec3(0.06 + 0.85 * max(diff, 0.0)), clouds * 0.6);

                    float cities = step(0.78, noise(vObj * 38.0)) * land * (1.0 - day) * (1.0 - clouds);
                    lit += vec3(1.0, 0.72, 0.35) * cities * 0.9;

                    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
                    lit += vec3(0.25, 0.55, 1.0) * fres * (0.22 + 0.9 * day);

                    gl_FragColor = vec4(lit, 1.0);
                }
            `,
        }),
    );
    group.add(surface);

    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.07, 64, 64),
        new THREE.ShaderMaterial({
            uniforms: { uSunDir: { value: SUN_DIR } },
            side: THREE.BackSide,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            vertexShader: /* glsl */`
                varying vec3 vNormalV;
                varying vec3 vDirW;
                void main() {
                    vNormalV = normalize(normalMatrix * normal);
                    vDirW = normalize(mat3(modelMatrix) * position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uSunDir;
                varying vec3 vNormalV;
                varying vec3 vDirW;
                void main() {
                    float rim = pow(clamp(0.55 - dot(vNormalV, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 5.0);
                    float sun = 0.3 + 0.7 * smoothstep(-0.5, 0.6, dot(vDirW, uSunDir));
                    gl_FragColor = vec4(vec3(0.22, 0.52, 1.0) * rim * sun * 1.25, 1.0);
                }
            `,
        }),
    );
    group.add(halo);

    // Pulsing marker on the surface — "the basin being watched".
    const dir = new THREE.Vector3(0.35, 0.47, 0.81).normalize();
    const marker = new THREE.Mesh(
        new THREE.RingGeometry(0.012, 0.017, 32),
        new THREE.MeshBasicMaterial({
            color: 0x5ee7ff, transparent: true, side: THREE.DoubleSide,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }),
    );
    marker.position.copy(dir).multiplyScalar(1.004);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    surface.add(marker);

    function update(t, dt, spin) {
        uniforms.uTime.value = t;
        surface.rotation.y += dt * 0.03 * spin;
        const pulse = (t * 0.6) % 1;
        marker.scale.setScalar(1 + pulse * 1.8);
        marker.material.opacity = (1 - pulse) * 0.8;
    }
    return { group, surface, update };
}

// ── Satellite ────────────────────────────────────────────────────────

function buildSatellite() {
    const group = new THREE.Group();

    const foil = new THREE.MeshStandardMaterial({ color: 0xe0ac4a, metalness: 0.55, roughness: 0.42, emissive: 0x2a1a04 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a2030, metalness: 0.4, roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.2, roughness: 0.5, side: THREE.DoubleSide });
    const panelMat = new THREE.MeshStandardMaterial({
        map: solarPanelTexture(), metalness: 0.5, roughness: 0.35,
        emissive: 0x0b2a7a, emissiveIntensity: 0.55,
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.7), foil);
    group.add(body);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.6), dark);
    deck.position.y = 0.28;
    group.add(deck);
    const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.2, 20), dark);
    sensor.rotation.x = Math.PI / 2;
    sensor.position.z = 0.44;
    group.add(sensor);

    // Solar wings hinge at the body sides; scaling the hinge deploys them.
    const wings = [];
    for (const side of [-1, 1]) {
        const hinge = new THREE.Group();
        hinge.position.x = side * 0.25;
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8), dark);
        strut.rotation.z = Math.PI / 2;
        strut.position.x = side * 0.08;
        hinge.add(strut);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.02, 0.48), panelMat);
        panel.position.x = side * (0.16 + 0.575);
        panel.rotation.x = 0.95; // pitched so the cells face the viewer, not edge-on
        hinge.add(panel);
        group.add(hinge);
        wings.push(hinge);
    }

    // Dish opens toward -Y (toward the planet in most poses).
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.22, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2.5), white);
    dish.position.set(0, -0.45, 0.08);
    group.add(dish);
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8), dark);
    feed.position.set(0, -0.36, 0.08);
    group.add(feed);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.38, 8), dark);
    mast.position.set(0.14, 0.5, -0.2);
    group.add(mast);
    const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xff4d4d }),
    );
    beacon.position.set(0.14, 0.7, -0.2);
    group.add(beacon);

    function update(t, panels) {
        const s = Math.max(0.001, panels);
        wings[0].scale.x = s;
        wings[1].scale.x = s;
        beacon.material.color.copy(BEACON_COLOR).multiplyScalar(Math.sin(t * 4) > 0.6 ? 1 : 0.35);
    }
    return { group, update };
}

/**
 * The satellite the page shows: the NASA model inside a pose-driven group.
 * The procedural stand-in stays hidden unless the model fails to load.
 */
function buildModelSatellite(layer) {
    const group = new THREE.Group();
    const fallback = buildSatellite();
    fallback.group.visible = false;
    group.add(fallback.group);

    const loader = new GLTFLoader();
    loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
    loader.load(SATELLITE_MODEL, (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.position.sub(box.getCenter(new THREE.Vector3()));
        const holder = new THREE.Group();
        holder.add(model);
        holder.scale.setScalar(SATELLITE_SPAN / Math.max(size.x, size.y, size.z));
        holder.rotation.set(...SATELLITE_ATTITUDE);
        holder.traverse((o) => o.layers.set(layer));
        group.add(holder);
    }, undefined, (err) => {
        console.warn('Satellite model unavailable — using the simple stand-in.', err);
        fallback.group.visible = true;
    });

    return { group, update: fallback.update };
}

/** Translucent sensing cone from the satellite down to the planet. */
function buildBeam() {
    const geo = new THREE.ConeGeometry(1, 1, 40, 1, true);
    geo.translate(0, -0.5, 0); // apex at the origin, opening along -Y
    const uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 } };
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */`
            varying float vAlong;
            void main() {
                vAlong = uv.y; // 1 at the apex (satellite), 0 at the planet
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform float uTime;
            uniform float uOpacity;
            varying float vAlong;
            void main() {
                float fade = 0.04 + 0.34 * pow(vAlong, 1.4);
                float scan = 0.75 + 0.25 * sin(vAlong * 46.0 + uTime * 5.0);
                gl_FragColor = vec4(vec3(0.30, 0.86, 1.0) * fade * scan * uOpacity, 1.0);
            }
        `,
    }));
    mesh.frustumCulled = false;

    const down = new THREE.Vector3(0, -1, 0);
    const dir = new THREE.Vector3();
    function update(t, opacity, from, earthPos, earthScale) {
        uniforms.uTime.value = t;
        uniforms.uOpacity.value = opacity;
        mesh.visible = opacity > 0.01;
        if (!mesh.visible) return;
        dir.subVectors(earthPos, from);
        const dist = dir.length();
        const len = Math.max(0.01, dist - earthScale * 0.985);
        dir.normalize();
        mesh.position.copy(from);
        mesh.quaternion.setFromUnitVectors(down, dir);
        const radius = Math.min(earthScale * 0.42, len * 0.3);
        mesh.scale.set(radius, len, radius);
    }
    return { mesh, update };
}

// ── Launch vehicle ───────────────────────────────────────────────────

function buildRocket(sprite) {
    const group = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xe9edf2, metalness: 0.2, roughness: 0.5 });
    const band = new THREE.MeshStandardMaterial({ color: 0x1b2433, metalness: 0.3, roughness: 0.6 });
    const shell = new THREE.MeshStandardMaterial({
        color: 0xf4f6fa, metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide, transparent: true,
    });

    // Stage 1 — core + two strap-on boosters, drops away at separation.
    const stage1 = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1.3, 28), hull);
    core.position.y = 0.65;
    stage1.add(core);
    for (const y of [0.3, 1.0]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.173, 0.173, 0.06, 28), band);
        ring.position.y = y;
        stage1.add(ring);
    }
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 0.16, 20, 1, true), band);
    nozzle.position.y = -0.08;
    stage1.add(nozzle);
    for (const side of [-1, 1]) {
        const booster = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.9, 20), hull);
        booster.position.set(side * 0.26, 0.45, 0);
        stage1.add(booster);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.2, 20), band);
        cap.position.set(side * 0.26, 1.0, 0);
        stage1.add(cap);
    }

    // Exhaust plumes (additive cones, apex pointing down).
    const flames = [];
    const flameCore = new THREE.MeshBasicMaterial({
        color: 0xfff3c9, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide,
    });
    const flameOuter = new THREE.MeshBasicMaterial({
        color: 0xff6a10, transparent: true, opacity: 0.85, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const flareMat = new THREE.SpriteMaterial({
        map: sprite, color: 0xff8a2a, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const flare = new THREE.Sprite(flareMat);
    flare.position.y = -0.35;
    flare.scale.setScalar(1.9);
    stage1.add(flare);
    function addFlame(x, size) {
        const g = new THREE.Group();
        const inner = new THREE.Mesh(new THREE.ConeGeometry(0.09 * size, 0.9 * size, 16, 1, true), flameCore);
        const outer = new THREE.Mesh(new THREE.ConeGeometry(0.17 * size, 1.5 * size, 16, 1, true), flameOuter);
        inner.rotation.x = Math.PI; inner.position.y = -0.45 * size;
        outer.rotation.x = Math.PI; outer.position.y = -0.75 * size;
        g.add(inner, outer);
        g.position.set(x, -0.14, 0);
        stage1.add(g);
        flames.push(g);
    }
    addFlame(0, 1);
    addFlame(-0.26, 0.6);
    addFlame(0.26, 0.6);

    const glow = new THREE.PointLight(0xff8a3a, 0, 9, 1.6);
    glow.position.y = -0.5;
    stage1.add(glow);
    group.add(stage1);

    // Stage 2 — short upper stage under the payload.
    const stage2 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.25, 28), hull);
    stage2.position.y = 1.425;
    group.add(stage2);

    // Payload fairing — two half shells that peel apart.
    const profile = [
        new THREE.Vector2(0.172, 0), new THREE.Vector2(0.172, 0.36),
        new THREE.Vector2(0.14, 0.56), new THREE.Vector2(0.08, 0.72), new THREE.Vector2(0.001, 0.8),
    ];
    const halves = [0, Math.PI].map((phi) => {
        const half = new THREE.Mesh(new THREE.LatheGeometry(profile, 20, phi, Math.PI), shell);
        half.position.y = 1.55;
        group.add(half);
        return half;
    });

    // Exhaust sparks.
    const N = 150;
    const pPos = new Float32Array(N * 3).fill(-999);
    const pCol = new Float32Array(N * 3);
    const parts = Array.from({ length: N }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    const sparks = new THREE.Points(pGeo, new THREE.PointsMaterial({
        size: 0.26, map: sprite, vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sparks.frustumCulled = false;
    let cursor = 0;

    function update(t, dt, L) {
        group.visible = L.sep < 0.999 || L.fair < 0.999;
        group.position.y = L.rocketY;

        stage1.visible = L.sep < 0.999;
        stage1.position.y = -L.sep * 4.6;
        stage1.rotation.z = L.sep * 0.45;

        const drop = Math.max(0, L.fair - 0.3);
        stage2.position.y = 1.425 - drop * 4.2;
        stage2.visible = L.fair < 0.999;

        halves.forEach((half, i) => {
            const side = i === 0 ? 1 : -1;
            half.position.x = side * L.fair * 1.7;
            half.position.y = 1.55 - L.fair * L.fair * 0.9;
            half.rotation.z = -side * L.fair * 1.1;
            half.visible = L.fair < 0.999;
        });
        shell.opacity = 1 - L.fair * L.fair;

        const flicker = 0.85 + 0.15 * Math.sin(t * 61) + 0.1 * Math.sin(t * 37 + 1.3);
        flames.forEach((f) => {
            f.visible = L.flame > 0.01;
            f.scale.set(0.6 + 0.4 * L.flame, L.flame * flicker, 0.6 + 0.4 * L.flame);
        });
        glow.intensity = L.flame * 7 * flicker;
        flareMat.opacity = Math.min(1, L.flame) * 0.9 * flicker;

        // Spawn + integrate sparks in world space so they trail behind.
        if (L.flame > 0.05 && L.sep < 0.2) {
            for (let k = 0; k < 3; k++) {
                const p = parts[cursor];
                const o = cursor * 3;
                pPos[o] = (Math.random() - 0.5) * 0.16;
                pPos[o + 1] = L.rocketY - 0.25;
                pPos[o + 2] = (Math.random() - 0.5) * 0.16;
                p.vx = (Math.random() - 0.5) * 0.7;
                p.vy = -(1.6 + Math.random() * 2.4) * L.flame;
                p.vz = (Math.random() - 0.5) * 0.7;
                p.life = 1;
                cursor = (cursor + 1) % N;
            }
        }
        let alive = false;
        for (let i = 0; i < N; i++) {
            const p = parts[i];
            const o = i * 3;
            if (p.life <= 0) continue;
            alive = true;
            p.life -= dt * 1.25;
            pPos[o] += p.vx * dt;
            pPos[o + 1] += p.vy * dt;
            pPos[o + 2] += p.vz * dt;
            const f = Math.max(0, p.life);
            pCol[o] = f * f;
            pCol[o + 1] = f * f * 0.5;
            pCol[o + 2] = f * f * f * 0.18;
            if (p.life <= 0) pPos[o + 1] = -999;
        }
        sparks.visible = alive;
        if (alive) {
            pGeo.attributes.position.needsUpdate = true;
            pGeo.attributes.color.needsUpdate = true;
        }
    }
    return { group, sparks, update };
}

// ── Scene assembly ───────────────────────────────────────────────────

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} pose    live pose object (see poses.js) — read every frame
 * @param {object} launch  live launch state (see poses.js) — read every frame
 * @param {{reducedMotion?: boolean}} [opts]
 * @throws if WebGL is unavailable (caller falls back to the CSS backdrop)
 */
export function createSpaceScene(canvas, pose, launch, opts = {}) {
    const still = Boolean(opts.reducedMotion);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.autoClear = false;
    const spaceCards = [...document.querySelectorAll('[data-space]')];

    const scene = new THREE.Scene();
    // Soft studio reflections so metal foil and solar cells look like materials, not flat colour.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.75;
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
    camera.position.set(0, 0, CAMERA_Z);

    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.copy(SUN_DIR).multiplyScalar(10);
    const ambient = new THREE.AmbientLight(0x6f8fc7, 0.55);
    const earthshine = new THREE.DirectionalLight(0x3f7fff, 0.7);
    earthshine.position.set(2, -6, 2);
    scene.add(sun, ambient, earthshine);

    const sprite = glowTexture();
    const stars = buildStars(sprite);
    const speed = buildSpeedLines();
    const earth = buildEarth();
    const satellite = buildModelSatellite(CRAFT_LAYER);
    const beam = buildBeam();
    const rocket = buildRocket(sprite);
    scene.add(stars, speed.mesh, earth.group, beam.mesh, satellite.group, rocket.group, rocket.sparks);
    for (const craft of [speed.mesh, beam.mesh, satellite.group, rocket.group, rocket.sparks]) {
        craft.traverse((o) => o.layers.set(CRAFT_LAYER));
    }
    for (const light of [sun, ambient, earthshine]) light.layers.enableAll();

    let xFactor = 1;
    let narrow = 0; // 0 on wide screens → 1 on phone-width viewports
    let scroll = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    function resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        // Poses are authored for ~16:10; pull things toward the centre on
        // narrow viewports so the satellite and planet stay in frame.
        xFactor = Math.min(1, Math.max(0.32, camera.aspect / 1.6));
        narrow = (1 - xFactor) / 0.68;
    }
    resize();
    window.addEventListener('resize', resize);

    if (!still) {
        window.addEventListener('pointermove', (e) => {
            pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
            pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
        }, { passive: true });
    }

    const lookTarget = new THREE.Vector3(0, 0, 0);
    let last = 0;

    /** The dark card with the most area on screen, as a viewport rect — or null. */
    function visibleSpaceCard() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let best = null;
        for (const el of spaceCards) {
            const r = el.getBoundingClientRect();
            const x0 = Math.max(0, r.left);
            const y0 = Math.max(0, r.top);
            const w = Math.min(vw, r.right) - x0;
            const h = Math.min(vh, r.bottom) - y0;
            if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) {
                best = { x0, y0, w, h, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
            }
        }
        return best;
    }

    /** Draw one frame. `time` in seconds (GSAP ticker time). */
    function render(time) {
        const dt = Math.min(0.05, Math.max(0, time - last));
        last = time;
        const t = still ? 0 : time;
        const idle = still ? 0 : pose.idle;

        // Camera: subtle pointer parallax + launch shake.
        pointer.x += (pointer.tx - pointer.x) * 0.04;
        pointer.y += (pointer.ty - pointer.y) * 0.04;
        const shake = launch.shake * 0.045;
        camera.position.x = pointer.x * 0.22 * idle + (Math.random() - 0.5) * shake;
        camera.position.y = -pointer.y * 0.14 * idle + (Math.random() - 0.5) * shake;
        camera.lookAt(lookTarget);

        stars.position.y = launch.starY + scroll * 7;
        stars.rotation.z = t * 0.004;
        speed.update(dt, launch.streak);

        // The Earth belongs to the dark card on screen: offset it by the card's
        // distance from the viewport centre so it scrolls away with the card.
        const card = visibleSpaceCard();
        const vh = window.innerHeight;
        const unitsPerPx = (2 * Math.tan((FOV * Math.PI) / 360) * (CAMERA_Z - pose.ez)) / vh;
        const offX = card ? (card.cx - window.innerWidth / 2) * unitsPerPx : 0;
        const offY = card ? (vh / 2 - card.cy) * unitsPerPx : 0;
        earth.group.position.set(pose.ex * xFactor + offX, pose.ey + offY, pose.ez);
        earth.group.scale.setScalar(pose.es);
        earth.update(t, still ? 0 : dt, 1);
        earth.group.rotation.y = scroll * 1.1;

        const sat = satellite.group;
        sat.position.set(
            pose.sx * xFactor,
            // On narrow screens the copy fills the frame, so once in orbit the
            // satellite rides higher and smaller, clear of the headline.
            Math.min(2.3, pose.sy + 1.25 * narrow * pose.idle) + Math.sin(t * 0.7) * 0.06 * idle,
            pose.sz,
        );
        sat.rotation.set(
            pose.srx + Math.sin(t * 0.5) * 0.05 * idle,
            pose.sry + Math.sin(t * 0.33) * 0.14 * idle,
            pose.srz + Math.cos(t * 0.41) * 0.04 * idle,
        );
        sat.scale.setScalar(pose.ss * (1 - 0.42 * narrow * pose.idle));
        satellite.update(t, launch.panels);

        beam.update(t, card ? pose.beam : 0, sat.position, earth.group.position, pose.es);
        rocket.update(time, dt, launch);

        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        if (card) {
            // Pass 1 — space, clipped to the card (scissor is in CSS px, y up).
            renderer.setScissor(card.x0, vh - card.y0 - card.h, card.w, card.h);
            renderer.setScissorTest(true);
            renderer.setClearColor(SPACE_COLOR, 1);
            renderer.clear();
            camera.layers.set(SPACE_LAYER);
            renderer.render(scene, camera);
            renderer.setScissorTest(false);
            renderer.clearDepth();
        }
        // Pass 2 — the craft, over everything.
        camera.layers.set(CRAFT_LAYER);
        renderer.render(scene, camera);
    }

    return {
        render,
        /** Scroll progress 0..1 — drives star parallax and extra planet spin. */
        setScroll(p) { scroll = p; },
    };
}
