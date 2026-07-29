import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';

/**
 * Everything that depends on the splat renderer's internals lives here.
 * The rest of the app only ever sees: an Object3D to add to the scene,
 * a Float32Array of world-space centers, and a Uint8Array of RGB.
 *
 * If you swap renderers (gsplat.js, a WebGPU one of your own), this is
 * the only file you rewrite.
 */

const since = (t0) => `${Math.round(performance.now() - t0)} ms`;
const nextFrame = () => new Promise(requestAnimationFrame);

const CHUNK = 200_000;   // splats per yield, so the progress bar can paint
const DOWNLOADING = 0;   // GS.LoaderStatus.Downloading

/**
 * The viewer sniffs the format off the end of the path, so a blob: URL from a
 * dropped File resolves to null and it throws "File format not supported".
 * We pass the format explicitly, taken from the dropped file's real name.
 */
function formatFromName(name = '') {
  const F = GS.SceneFormat ?? { Splat: 0, KSplat: 1, Ply: 2, Spz: 3 };
  const n = name.toLowerCase();
  if (n.endsWith('.ply')) return F.Ply;
  if (n.endsWith('.splat')) return F.Splat;
  if (n.endsWith('.ksplat')) return F.KSplat;
  if (n.endsWith('.spz')) return F.Spz;
  return null;
}

/**
 * SplatMesh.build() always builds a raycasting octree, with no option to turn
 * it off. It walks every splat twice through getSplatCenter/getSplatColor —
 * the per-call allocation described in _readBulk — then hands every center to
 * an octree worker. On a 1.2M splat scene that is a large chunk of the load.
 *
 * We never raycast against the splats (picking is SAM + liftMask + our own
 * uniform grid), so it is dead weight. Raycasting degrades gracefully:
 * getSplatTree() returns null and raycastSplatMesh() bails out.
 */
function suppressSplatTree(dropInViewer) {
  const inner = dropInViewer.viewer ?? dropInViewer;
  const patch = () => {
    const mesh = inner.splatMesh;
    if (mesh && !mesh.__treeSuppressed) {
      mesh.buildSplatTree = () => Promise.resolve();
      mesh.__treeSuppressed = true;
    }
  };
  const create = inner.createSplatMesh?.bind(inner);
  if (create) inner.createSplatMesh = () => { create(); patch(); };
  patch();
}

export class SplatSource {
  constructor() {
    this.object3D = null;   // add this to your scene
    this.count = 0;
    this.centers = null;    // Float32Array(count * 3), world space
    this.colors = null;     // Uint8Array(count * 3), 0..255
    this.opacity = null;    // Uint8Array(count)
    this.bounds = new THREE.Box3();
    this.scale = 1;         // bbox diagonal, used to make radii resolution-independent
    this.rippleUniforms = null;
  }

  /**
   * @param {string} url         blob: URL or path
   * @param {object} opts        { filename, format, gpuAcceleratedSort, suppressTree, sceneOptions, ... }
   * @param {function} onProgress (fraction01, label)
   */
  async load(url, opts = {}, onProgress = () => {}) {
    const { filename, sceneOptions, suppressTree = true, ...viewerOpts } = opts;

    const format = opts.format ?? formatFromName(filename ?? url);
    if (format === null) throw new Error(`unrecognised splat format: "${filename ?? url}"`);

    const viewer = new GS.DropInViewer({
      // gpuAcceleratedSort computes splat distances via transform feedback. On
      // some drivers (seen on Windows/Chrome) it silently yields a render count
      // of zero — the scene loads, sorts, reports ready, and draws nothing at
      // all. The CPU distance path costs a few ms per sort and always works,
      // so it is the default here. Pass gpuAcceleratedSort: true to opt back in.
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: crossOriginIsolated,
      ...viewerOpts,
    });

    if (suppressTree) suppressSplatTree(viewer);

    const t0 = performance.now();

    // NOTE: showLoadingUI is the SECOND POSITIONAL argument — passing it inside
    // the per-scene options object is silently ignored. DropInViewer also drops
    // the onProgress callback entirely, so we go through the inner Viewer.
    await viewer.viewer.addSplatScenes(
      [{ path: url, format, splatAlphaRemovalThreshold: 5, ...(sceneOptions || {}) }],
      false,
      (percent, _label, status) => {
        if (status === DOWNLOADING) onProgress(percent / 100, `reading file ${percent.toFixed(0)}%`);
        else onProgress(1, 'building buffers…');
      },
    );
    console.log(`[splat] download + build: ${since(t0)}`);

    this.object3D = viewer;
    this.viewer = viewer;
    await this._extract(viewer, onProgress);
    this._installEncodingRipple();
    return this;
  }

  /**
   * Drive the splat renderer once per frame, before you render the scene.
   * DropInViewer relies on an onBeforeRender hook on a hidden callback mesh to
   * do this implicitly; calling it explicitly is the same work, but it fails
   * loudly instead of silently drawing nothing if the plumbing changes.
   */
  update(renderer, camera) {
    this.viewer?.viewer?.update(renderer, camera);
  }

  /**
   * Apply a small radial shell displacement in the splat vertex shader.
   * Sorting still uses the original centers, which is acceptable because the
   * readiness ripple is deliberately much smaller than a typical splat.
   */
  setEncodingRipple(strength = 0, phase = 0, width = this.scale * 0.12) {
    if (!this.rippleUniforms) return;
    this.rippleUniforms.strength.value = strength;
    this.rippleUniforms.phase.value = phase;
    this.rippleUniforms.width.value = Math.max(width, this.scale * 0.001);
  }

  dispose() {
    this.viewer?.viewer?.dispose?.();
    this.centers = this.colors = this.opacity = null;
    this.rippleUniforms = null;
  }

  _installEncodingRipple() {
    const mesh = this.viewer?.splatMesh ?? this.viewer?.getSplatMesh?.();
    const material = mesh?.material;
    if (!material?.vertexShader || !material.uniforms || material.userData?.encodingRipple) return;

    const declarationNeedle = 'uniform float splatScale;';
    const centerNeedle = 'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));';
    if (!material.vertexShader.includes(declarationNeedle)
      || !material.vertexShader.includes(centerNeedle)) {
      console.warn('[splat] encoding ripple unavailable: shader layout changed');
      return;
    }

    material.uniforms.encodingRippleStrength = { value: 0 };
    material.uniforms.encodingRipplePhase = { value: 0 };
    material.uniforms.encodingRippleWidth = { value: this.scale * 0.12 };

    material.vertexShader = material.vertexShader
      .replace(declarationNeedle, `${declarationNeedle}
        uniform float encodingRippleStrength;
        uniform float encodingRipplePhase;
        uniform float encodingRippleWidth;`)
      .replace(centerNeedle, `${centerNeedle}
            if (encodingRippleStrength > 0.0) {
                vec3 encodingRippleOffset = splatCenter - sceneCenter;
                float encodingRippleDistance = length(encodingRippleOffset);
                float encodingRippleDelta = encodingRippleDistance - encodingRipplePhase;
                float encodingRippleWidthSafe = max(encodingRippleWidth, 0.00001);
                float encodingRippleEnvelope = exp(
                    -(encodingRippleDelta * encodingRippleDelta)
                    / (encodingRippleWidthSafe * encodingRippleWidthSafe)
                );
                float encodingRippleWave = sin(
                    encodingRippleDelta / encodingRippleWidthSafe * 3.14159265
                );
                vec3 encodingRippleDirection = normalize(
                    encodingRippleOffset + vec3(0.000001)
                );
                splatCenter += encodingRippleDirection
                    * encodingRippleWave
                    * encodingRippleEnvelope
                    * encodingRippleStrength;
            }`);

    material.userData.encodingRipple = true;
    material.needsUpdate = true;
    this.rippleUniforms = {
      strength: material.uniforms.encodingRippleStrength,
      phase: material.uniforms.encodingRipplePhase,
      width: material.uniforms.encodingRippleWidth,
    };
  }

  async _extract(viewer, onProgress = () => {}) {
    // NOTE: verify these accessors against your installed version of
    // @mkkellogg/gaussian-splats-3d — they are the only internals we touch.
    const mesh = viewer.splatMesh ?? viewer.getSplatMesh?.();
    if (!mesh) throw new Error('SplatSource: could not reach the SplatMesh.');

    const n = mesh.getSplatCount();
    this.count = n;

    const centers = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 3);
    const opacity = new Uint8Array(n);

    const t0 = performance.now();
    const fast = await this._readBulk(mesh, n, centers, colors, opacity, onProgress);
    if (!fast) await this._readPerSplat(mesh, n, centers, colors, opacity, onProgress);
    console.log(`[splat] extract ${n.toLocaleString()} splats (${fast ? 'bulk' : 'per-splat'}): ${since(t0)}`);

    this.centers = centers;
    this.colors = colors;
    this.opacity = opacity;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    this.bounds.set(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    this.scale = this.bounds.getSize(new THREE.Vector3()).length() || 1;
  }

  /**
   * SplatBuffer.getSplatCenter/getSplatColor allocate a fresh DataView and
   * Uint8Array *per call* — two million short-lived heap objects for a 1M splat
   * scene. Uncompressed buffers (compressionLevel 0, what a .ply gives you) are
   * a flat stride, so we hoist those views out of the loop and read straight
   * through: ~280 ns/splat instead of GC thrash.
   *
   * Returns false if anything looks unfamiliar, and the caller falls back to
   * the public accessors.
   */
  async _readBulk(mesh, n, centers, colors, opacity, onProgress) {
    const scenes = mesh.scenes;
    const sceneMap = mesh.globalSplatIndexToSceneIndexMap;
    const localMap = mesh.globalSplatIndexToLocalSplatIndexMap;
    if (!scenes?.length || !sceneMap || !localMap) return false;

    const m = new THREE.Matrix4();
    const views = [];
    for (let s = 0; s < scenes.length; s++) {
      const sb = scenes[s].splatBuffer;
      const levels = sb?.constructor?.CompressionLevels?.[0];
      if (!sb || sb.compressionLevel !== 0 || !levels) return false;
      if (!sb.bufferData || !sb.sections || !sb.globalSplatIndexToSectionMap) return false;

      mesh.getSceneTransform(s, m);
      views.push({
        view: new DataView(sb.bufferData),
        bytes: new Uint8Array(sb.bufferData),
        sections: sb.sections,
        secMap: sb.globalSplatIndexToSectionMap,
        colorOffset: levels.ColorOffsetBytes,
        e: m.elements.slice(),
      });
    }

    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        const v = views[sceneMap[i]];
        const li = localMap[i];
        const sec = v.sections[v.secMap[li]];
        const base = sec.dataBase + sec.bytesPerSplat * (li - sec.splatCountOffset);

        const x = v.view.getFloat32(base, true);
        const y = v.view.getFloat32(base + 4, true);
        const z = v.view.getFloat32(base + 8, true);

        const e = v.e;
        centers[i * 3 + 0] = e[0] * x + e[4] * y + e[8] * z + e[12];
        centers[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        centers[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];

        const cb = base + v.colorOffset;
        colors[i * 3 + 0] = v.bytes[cb];
        colors[i * 3 + 1] = v.bytes[cb + 1];
        colors[i * 3 + 2] = v.bytes[cb + 2];
        opacity[i] = v.bytes[cb + 3];
      }
      onProgress(i1 / n, `reading splats ${Math.round((i1 / n) * 100)}%`);
      if (i1 < n) await nextFrame();
    }
    return true;
  }

  /** Correct for any compression level, but allocation-heavy — see _readBulk. */
  async _readPerSplat(mesh, n, centers, colors, opacity, onProgress) {
    const c = new THREE.Vector3();
    const col = new THREE.Vector4();
    const hasColor = typeof mesh.getSplatColor === 'function';

    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        mesh.getSplatCenter(i, c, true); // true => apply the scene transform
        centers[i * 3 + 0] = c.x;
        centers[i * 3 + 1] = c.y;
        centers[i * 3 + 2] = c.z;

        if (hasColor) {
          mesh.getSplatColor(i, col);
          colors[i * 3 + 0] = col.x;
          colors[i * 3 + 1] = col.y;
          colors[i * 3 + 2] = col.z;
          opacity[i] = col.w;
        } else {
          colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 128;
          opacity[i] = 255;
        }
      }
      onProgress(i1 / n, `reading splats ${Math.round((i1 / n) * 100)}%`);
      if (i1 < n) await nextFrame();
    }
  }
}
