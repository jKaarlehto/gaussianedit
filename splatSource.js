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
const CUTOUT_CHUNK = 32_000;
const CUTOUT_MAX_SPLATS = 360_000;

function sampleCutoutIndices(indices, priority, maxSplats, hidden) {
  if (!indices?.length) return new Uint32Array();
  const limit = Math.min(maxSplats, indices.length);
  const chosen = new Set();
  const output = [];
  const add = (index) => {
    if (output.length >= limit || chosen.has(index) || hidden?.[index]) return;
    chosen.add(index);
    output.push(index);
  };

  // Preserve most or all of the current object, while reserving enough room
  // for nearby context. The tracker needs both the target and its distractors.
  const priorityBudget = Math.min(
    priority?.size ?? 0,
    Math.floor(limit * 0.82),
  );
  if (priorityBudget && priority?.size) {
    const stride = priority.size / priorityBudget;
    let next = 0;
    let cursor = 0;
    for (const index of priority) {
      if (cursor + 0.5 >= next) {
        add(index);
        next += stride;
      }
      cursor++;
    }
  }

  const contextBudget = limit - output.length;
  if (contextBudget > 0) {
    const stride = indices.length / contextBudget;
    for (let sample = 0; sample < contextBudget; sample++) {
      add(indices[Math.min(indices.length - 1, Math.floor((sample + 0.5) * stride))]);
    }
    // Hidden entries and overlaps can leave a small shortfall.
    for (let i = 0; output.length < limit && i < indices.length; i++) add(indices[i]);
  }
  return Uint32Array.from(output);
}

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

/**
 * DropInViewer normally invokes Viewer.update() from a hidden mesh's
 * onBeforeRender hook. GaussianEdit drives updates explicitly so it can await
 * synthetic-camera sorts and render on demand. Disable that implicit second
 * update instead of inspecting the same camera twice per frame.
 */
function useExplicitViewerUpdates(dropInViewer) {
  if (dropInViewer?.callbackMesh) {
    dropInViewer.callbackMesh.onBeforeRender = () => {};
  }
}

async function waitForSortIdle(viewer) {
  while (viewer?.sortRunning) {
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

/**
 * Copy one native, uncompressed Gaussian row without decoding it through
 * temporary vectors. Exported for the buffer-layout smoke test.
 */
export function copyUncompressedSplatRow(
  source,
  localIndex,
  output,
  targetBase,
) {
  const levels = source.constructor.CompressionLevels[0];
  const section = source.sections[source.globalSplatIndexToSectionMap[localIndex]];
  const sourceBase = section.dataBase
    + section.bytesPerSplat * (localIndex - section.splatCountOffset);
  const sourceBytes = new Uint8Array(source.bufferData);
  const {
    ScaleOffsetBytes: scaleOffset,
    // GaussianSplats3D 0.4.x exposes this historical misspelling.
    RotationffsetBytes: rotationOffset,
    ColorOffsetBytes: colorOffset,
  } = levels;
  output.set(sourceBytes.subarray(sourceBase, sourceBase + 12), targetBase);
  output.set(
    sourceBytes.subarray(sourceBase + scaleOffset, sourceBase + scaleOffset + 12),
    targetBase + 12,
  );
  output.set(
    sourceBytes.subarray(sourceBase + rotationOffset, sourceBase + rotationOffset + 16),
    targetBase + 24,
  );
  output.set(
    sourceBytes.subarray(sourceBase + colorOffset, sourceBase + colorOffset + 4),
    targetBase + 40,
  );
}

export class SplatSource {
  constructor() {
    this.object3D = null;   // add this to your scene
    this.count = 0;
    this.centers = null;    // Float32Array(count * 3), world space
    this.colors = null;     // Uint8Array(count * 3), 0..255
    this.opacity = null;    // Uint8Array(count)
    this.radii = null;      // Float32Array(count), conservative world-space footprint
    this.bounds = new THREE.Box3();
    this.scale = 1;         // bbox diagonal, used to make radii resolution-independent
    this.rippleUniforms = null;
    this.hiddenSplatsTexture = null;
    this.hiddenSplatsData = null;
    this.hiddenSplatsTextureSize = null;
    this.pendingHiddenSplats = new Set();
    this.temporaryHiddenSplats = new Set();
    this.qualityHiddenSplats = null;
    this.qualityFilterEnabled = false;
    this.initialSortRequested = false;
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

    useExplicitViewerUpdates(viewer);
    if (suppressTree) suppressSplatTree(viewer);

    const t0 = performance.now();

    // NOTE: showLoadingUI is the SECOND POSITIONAL argument — passing it inside
    // the per-scene options object is silently ignored. DropInViewer also drops
    // the onProgress callback entirely, so we go through the inner Viewer.
    await viewer.viewer.addSplatScenes(
      [{ path: url, format, splatAlphaRemovalThreshold: 5, ...(sceneOptions || {}) }],
      false,
      (percent, _label, status) => {
        // This callback covers two very different operations. Keep their
        // progress ranges monotonic so the UI never jumps from 100% back to
        // zero when CPU-side selection data is extracted below.
        if (status === DOWNLOADING) {
          onProgress(percent / 100 * 0.55, `Loading scene file · ${percent.toFixed(0)}%`);
        } else {
          onProgress(0.58, 'Preparing the 3D renderer');
        }
      },
    );
    console.log(`[splat] download + build: ${since(t0)}`);

    this.object3D = viewer;
    this.viewer = viewer;
    await this._extract(viewer, (fraction) => {
      onProgress(
        0.58 + fraction * 0.42,
        `Preparing selection data · ${Math.round(fraction * 100)}%`,
      );
    });
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
    const inner = this.viewer?.viewer;
    inner?.update(renderer, camera);
    // The library's normal first-sort heuristic compares the camera against
    // the world origin and only reacts after a one-unit move. Small scenes can
    // start closer than that with the same forward direction, leaving the draw
    // count at zero forever. Force exactly one complete initial sort.
    if (!this.initialSortRequested && inner?.splatMesh?.getSplatCount?.() > 0) {
      this.initialSortRequested = true;
      inner.runSplatSort?.(true, true)?.catch?.((error) => {
        console.warn('[splat] initial depth sort failed', error);
      });
    }
  }

  /**
   * Force a complete depth sort for an offscreen/novel camera. The caller can
   * pause visible rendering while this promise is pending, render the novel
   * view to a target, then call it again for the cockpit camera.
   */
  async prepareView(renderer, camera) {
    const inner = this.viewer?.viewer;
    if (!inner) return;
    // update() starts a sort but does not return its promise. Calling a forced
    // sort afterward merely sees "sortRunning" and resolves immediately,
    // allowing stale ordering to render. Bind/init the drop-in camera first,
    // await the one forced sort, then perform the remaining maintenance pass.
    inner.updateForDropInMode(renderer, camera);
    await waitForSortIdle(inner);
    const sort = inner.runSplatSort?.(true, true);
    if (sort?.then) await sort;
    inner.update(renderer, camera);
  }

  /**
   * Build a temporary native-Gaussian renderer containing only the selected
   * object's spatial neighborhood. Synthetic tracking views sort this compact
   * cutout instead of re-sorting the entire multi-million-splat scene.
   *
   * The source PLY buffer is copied directly into a new uncompressed
   * SplatBuffer, preserving scale, rotation, color, and opacity. No lossy point
   * proxy or screenshot cache is involved.
   */
  async createTrackingCutout(
    indices,
    {
      priority = null,
      maxSplats = CUTOUT_MAX_SPLATS,
      onProgress = () => {},
      canceled = () => false,
    } = {},
  ) {
    const mesh = this.viewer?.splatMesh ?? this.viewer?.getSplatMesh?.();
    const scenes = mesh?.scenes;
    const sceneMap = mesh?.globalSplatIndexToSceneIndexMap;
    const localMap = mesh?.globalSplatIndexToLocalSplatIndexMap;
    if (!mesh || !scenes?.length || !sceneMap || !localMap) return null;

    // Direct row copying currently targets the uncompressed buffers produced
    // by ordinary PLY loads. Other formats retain the safe full-scene fallback.
    const sourceViews = [];
    for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
      const source = scenes[sceneIndex].splatBuffer;
      const levels = source?.constructor?.CompressionLevels?.[0];
      if (!source || source.compressionLevel !== 0 || !levels
        || !source.bufferData || !source.sections
        || !source.globalSplatIndexToSectionMap) return null;
      sourceViews.push({
        source,
        rows: [],
      });
    }

    const sampled = sampleCutoutIndices(
      indices,
      priority,
      Math.max(1, maxSplats),
      this.hiddenSplatsData,
    );
    for (let i = 0; i < sampled.length; i++) {
      sourceViews[sceneMap[sampled[i]]].rows.push(sampled[i]);
    }
    if (canceled()) throw new DOMException('Tracking cutout superseded', 'AbortError');

    const buffers = [];
    const options = [];
    let copied = 0;
    for (let sceneIndex = 0; sceneIndex < sourceViews.length; sceneIndex++) {
      const sourceView = sourceViews[sceneIndex];
      if (!sourceView.rows.length) continue;
      const count = sourceView.rows.length;
      // Use the library's native allocator so its current header/section
      // layout remains the single source of truth.
      const {
        splatBuffer,
        splatBufferDataOffsetBytes: outputBase,
      } = GS.SplatBuffer.preallocateUncompressed(count, 0);
      const output = new Uint8Array(splatBuffer.bufferData);
      const bytesPerSplat = splatBuffer.sections[0].bytesPerSplat;
      for (let row = 0; row < count; row++) {
        const globalIndex = sourceView.rows[row];
        const localIndex = localMap[globalIndex];
        const targetBase = outputBase + row * bytesPerSplat;
        copyUncompressedSplatRow(
          sourceView.source,
          localIndex,
          output,
          targetBase,
        );
        copied++;
        if (copied % CUTOUT_CHUNK === 0) {
          onProgress(copied / sampled.length);
          await nextFrame();
          if (canceled()) {
            throw new DOMException('Tracking cutout superseded', 'AbortError');
          }
        }
      }
      buffers.push(splatBuffer);
      const sourceScene = scenes[sceneIndex];
      options.push({
        splatAlphaRemovalThreshold: 5,
        position: sourceScene.position.toArray(),
        rotation: sourceScene.quaternion.toArray(),
        scale: sourceScene.scale.toArray(),
      });
    }
    onProgress(1);
    if (!buffers.length) return null;

    const viewer = new GS.DropInViewer({
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: crossOriginIsolated,
    });
    useExplicitViewerUpdates(viewer);
    suppressSplatTree(viewer);
    await viewer.viewer.addSplatBuffers(
      buffers,
      options,
      true,
      false,
      false,
      false,
      true,
      false,
    );
    const inner = viewer.viewer;
    return {
      object3D: viewer,
      count: sampled.length,
      indices: sampled,
      update(renderer, camera) {
        inner.update(renderer, camera);
      },
      async prepareView(renderer, camera) {
        inner.updateForDropInMode(renderer, camera);
        await waitForSortIdle(inner);
        const sort = inner.runSplatSort?.(true, true);
        if (sort?.then) await sort;
        inner.update(renderer, camera);
      },
      dispose() {
        return inner.dispose?.();
      },
    };
  }

  /**
   * Apply a small travelling wavefront in the splat vertex shader. Only a
   * narrow spatial band moves; the rest of the scene remains perfectly still.
   * Sorting still uses the original centers, which is safe at this amplitude.
   */
  setEncodingRipple(
    strength = 0,
    phase = 0,
    width = this.scale * 0.12,
    travelDirection = null,
    liftDirection = null,
  ) {
    if (!this.rippleUniforms) return;
    this.rippleUniforms.strength.value = strength;
    this.rippleUniforms.phase.value = phase;
    this.rippleUniforms.width.value = Math.max(width, this.scale * 0.001);
    if (travelDirection) this.rippleUniforms.travel.value.copy(travelDirection).normalize();
    if (liftDirection) this.rippleUniforms.lift.value.copy(liftDirection).normalize();
  }

  /**
   * Remove owned/docked Gaussians from the source scene without rebuilding the
   * splat buffer. A compact one-byte GPU texture is sampled by the existing
   * splat vertex shader, so moving an object to or from the dock is immediate.
   */
  setHiddenSplats(indices = []) {
    this.pendingHiddenSplats = indices instanceof Set ? new Set(indices) : new Set(indices);
    this._applyHiddenSplats();
  }

  /**
   * Temporarily hide foreground geometry while rendering an explicitly
   * labelled diagnostic scan. This is kept separate from the persistent dock
   * mask so clearing a reveal pass can never put extracted objects back into
   * the source scene.
   */
  setTemporaryHiddenSplats(indices = []) {
    this.temporaryHiddenSplats =
      indices instanceof Set ? new Set(indices) : new Set(indices);
    this._applyHiddenSplats();
  }

  clearTemporaryHiddenSplats() {
    if (!this.temporaryHiddenSplats.size) return;
    this.temporaryHiddenSplats.clear();
    this._applyHiddenSplats();
  }

  /**
   * Supply a reversible visibility mask for obvious reconstruction artifacts,
   * such as a tiny tail of splats hundreds of times larger than the scene's
   * normal surface splats. The original scene buffer is never modified.
   */
  setQualityHiddenSplats(mask = null, enabled = true) {
    this.qualityHiddenSplats = mask?.length === this.count ? mask : null;
    this.qualityFilterEnabled = Boolean(enabled && this.qualityHiddenSplats);
    this._applyHiddenSplats();
  }

  setQualityFilterEnabled(enabled) {
    this.qualityFilterEnabled = Boolean(enabled && this.qualityHiddenSplats);
    this._applyHiddenSplats();
  }

  isSplatHidden(index) {
    return this.pendingHiddenSplats.has(index)
      || this.temporaryHiddenSplats.has(index)
      || Boolean(this.qualityFilterEnabled && this.qualityHiddenSplats?.[index]);
  }

  getHiddenSplatsData() {
    return this.hiddenSplatsData;
  }

  _applyHiddenSplats() {
    if (!this.hiddenSplatsData || !this.hiddenSplatsTexture) return;
    if (this.qualityFilterEnabled && this.qualityHiddenSplats) {
      this.hiddenSplatsData.set(this.qualityHiddenSplats);
      this.hiddenSplatsData.fill(0, this.count);
    } else {
      this.hiddenSplatsData.fill(0);
    }
    for (const index of this.pendingHiddenSplats) {
      if (index >= 0 && index < this.count) this.hiddenSplatsData[index] = 255;
    }
    for (const index of this.temporaryHiddenSplats) {
      if (index >= 0 && index < this.count) this.hiddenSplatsData[index] = 255;
    }
    this.hiddenSplatsTexture.needsUpdate = true;
  }

  dispose() {
    this.viewer?.viewer?.dispose?.();
    this.hiddenSplatsTexture?.dispose();
    this.centers = this.colors = this.opacity = this.radii = null;
    this.rippleUniforms = null;
    this.hiddenSplatsTexture = null;
    this.hiddenSplatsData = null;
    this.hiddenSplatsTextureSize = null;
    this.pendingHiddenSplats.clear();
    this.temporaryHiddenSplats.clear();
    this.qualityHiddenSplats = null;
    this.qualityFilterEnabled = false;
    this.initialSortRequested = false;
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
    material.uniforms.encodingRippleTravel = { value: new THREE.Vector3(1, 0, 0) };
    material.uniforms.encodingRippleLift = { value: new THREE.Vector3(0, 1, 0) };
    const hiddenTextureWidth = 2048;
    const hiddenTextureHeight = Math.max(1, Math.ceil(this.count / hiddenTextureWidth));
    this.hiddenSplatsData = new Uint8Array(hiddenTextureWidth * hiddenTextureHeight);
    this.hiddenSplatsTexture = new THREE.DataTexture(
      this.hiddenSplatsData,
      hiddenTextureWidth,
      hiddenTextureHeight,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.hiddenSplatsTexture.minFilter = THREE.NearestFilter;
    this.hiddenSplatsTexture.magFilter = THREE.NearestFilter;
    this.hiddenSplatsTexture.generateMipmaps = false;
    this.hiddenSplatsTexture.unpackAlignment = 1;
    this.hiddenSplatsTexture.needsUpdate = true;
    this.hiddenSplatsTextureSize = new THREE.Vector2(hiddenTextureWidth, hiddenTextureHeight);
    material.uniforms.hiddenSplatsTexture = { value: this.hiddenSplatsTexture };
    material.uniforms.hiddenSplatsTextureSize = { value: this.hiddenSplatsTextureSize };

    material.vertexShader = material.vertexShader
      .replace(declarationNeedle, `${declarationNeedle}
        uniform float encodingRippleStrength;
        uniform float encodingRipplePhase;
        uniform float encodingRippleWidth;
        uniform vec3 encodingRippleTravel;
        uniform vec3 encodingRippleLift;
        uniform sampler2D hiddenSplatsTexture;
        uniform vec2 hiddenSplatsTextureSize;`)
      .replace(centerNeedle, `${centerNeedle}
            float hiddenSplatLinearIndex = float(splatIndex);
            vec2 hiddenSplatUv = (
                vec2(
                    mod(hiddenSplatLinearIndex, hiddenSplatsTextureSize.x),
                    floor(hiddenSplatLinearIndex / hiddenSplatsTextureSize.x)
                ) + vec2(0.5)
            ) / hiddenSplatsTextureSize;
            if (texture(hiddenSplatsTexture, hiddenSplatUv).r > 0.5) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }
            if (encodingRippleStrength > 0.0) {
                vec3 encodingRippleOffset = splatCenter - sceneCenter;
                float encodingRippleDistance = dot(
                    encodingRippleOffset,
                    normalize(encodingRippleTravel)
                );
                float encodingRippleDelta = encodingRippleDistance - encodingRipplePhase;
                float encodingRippleWidthSafe = max(encodingRippleWidth, 0.00001);
                float encodingRippleEnvelope = exp(
                    -2.4 * (encodingRippleDelta * encodingRippleDelta)
                    / (encodingRippleWidthSafe * encodingRippleWidthSafe)
                );
                float encodingRippleWave = sin(
                    encodingRippleDelta / encodingRippleWidthSafe * 2.35
                );
                splatCenter += normalize(encodingRippleLift)
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
      travel: material.uniforms.encodingRippleTravel,
      lift: material.uniforms.encodingRippleLift,
    };
    this.setHiddenSplats(this.pendingHiddenSplats);
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
    const radii = new Float32Array(n);

    const t0 = performance.now();
    const fast = await this._readBulk(
      mesh,
      n,
      centers,
      colors,
      opacity,
      radii,
      onProgress,
    );
    if (!fast) {
      await this._readPerSplat(
        mesh,
        n,
        centers,
        colors,
        opacity,
        radii,
        onProgress,
      );
    }
    console.log(`[splat] extract ${n.toLocaleString()} splats (${fast ? 'bulk' : 'per-splat'}): ${since(t0)}`);

    this.centers = centers;
    this.colors = colors;
    this.opacity = opacity;
    this.radii = radii;

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
  async _readBulk(mesh, n, centers, colors, opacity, radii, onProgress) {
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
        scaleOffset: levels.ScaleOffsetBytes,
        worldScale: Math.max(
          Math.hypot(m.elements[0], m.elements[1], m.elements[2]),
          Math.hypot(m.elements[4], m.elements[5], m.elements[6]),
          Math.hypot(m.elements[8], m.elements[9], m.elements[10]),
        ),
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
        const sb = base + v.scaleOffset;
        radii[i] = Math.max(
          Math.abs(v.view.getFloat32(sb, true)),
          Math.abs(v.view.getFloat32(sb + 4, true)),
          Math.abs(v.view.getFloat32(sb + 8, true)),
        ) * v.worldScale;
      }
      onProgress(i1 / n, `reading splats ${Math.round((i1 / n) * 100)}%`);
      if (i1 < n) await nextFrame();
    }
    return true;
  }

  /** Correct for any compression level, but allocation-heavy — see _readBulk. */
  async _readPerSplat(mesh, n, centers, colors, opacity, radii, onProgress) {
    const c = new THREE.Vector3();
    const col = new THREE.Vector4();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const hasColor = typeof mesh.getSplatColor === 'function';
    const hasScale = typeof mesh.getSplatScaleAndRotation === 'function';

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
        if (hasScale) {
          mesh.getSplatScaleAndRotation(i, scale, rotation);
          radii[i] = Math.max(
            Math.abs(scale.x),
            Math.abs(scale.y),
            Math.abs(scale.z),
          );
        }
      }
      onProgress(i1 / n, `reading splats ${Math.round((i1 / n) * 100)}%`);
      if (i1 < n) await nextFrame();
    }
  }
}
