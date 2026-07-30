import * as THREE from 'three';

const MAX_PREVIEW_POINTS = 180_000;
const MAX_CONTEXT_POINTS = 42_000;
const MAX_CONTEXT_CELL_VISITS = 90_000;

/**
 * A lightweight, isolated view of the selected splats rendered into a
 * scissored HUD region of the primary WebGL canvas. It intentionally uses
 * point primitives rather than a second Gaussian renderer: there is one GPU
 * context, one frame loop, and the primary renderer owns all resources.
 */
export class ObjectPreview {
  constructor(renderer, interactionElement, {
    onStats = () => {},
    onBrushStart = () => {},
    onBrush = () => {},
    onBrushEnd = () => {},
    onSurfacePick = () => {},
  } = {}) {
    this.renderer = renderer;
    this.interactionElement = interactionElement;
    this._rendererState = createRendererStateSnapshot(renderer);
    this.onStats = onStats;
    this.onBrushStart = onBrushStart;
    this.onBrush = onBrush;
    this.onBrushEnd = onBrushEnd;
    this.onSurfacePick = onSurfacePick;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.001, 1000);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.baseQuaternion = new THREE.Quaternion();
    this.interactionQuaternion = new THREE.Quaternion();
    this.interactionEuler = new THREE.Euler(0, 0, 0, 'XYZ');
    this.viewRotationMatrix = new THREE.Matrix4();

    this.layers = {
      context: this._makeLayer(0x98a4a8, 0.1, { context: true }),
      confirmed: this._makeLayer(0xff6b38, 0.92),
      provisional: this._makeLayer(0xf2c14e, 0.72),
      locked: this._makeLayer(0x58d6a8, 0.96),
      new: this._makeLayer(0x70d7ff, 1),
      removed: this._makeLayer(0x8e979a, 0.84),
    };
    for (const layer of Object.values(this.layers)) this.root.add(layer.points);

    this.contextCube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
      new THREE.LineBasicMaterial({
        color: 0x8fb9ba,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.root.add(this.contextCube);

    const ring = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(makeBrokenRing(0.88, -0.72)),
      new THREE.LineBasicMaterial({
        color: 0x70dcca,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.ring = ring;
    this.scene.add(ring);

    this.scanRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(makeRing(0.72, 0)),
      new THREE.LineBasicMaterial({
        color: 0xa8fff2,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.scene.add(this.scanRing);

    this.beam = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.68, -0.7, 0), new THREE.Vector3(-0.22, 0.52, 0),
        new THREE.Vector3(0.68, -0.7, 0), new THREE.Vector3(0.22, 0.52, 0),
        new THREE.Vector3(0, -0.7, -0.2), new THREE.Vector3(0, 0.42, -0.06),
        new THREE.Vector3(0, -0.7, 0.2), new THREE.Vector3(0, 0.42, 0.06),
      ]),
      new THREE.LineBasicMaterial({
        color: 0x65dbc9,
        transparent: true,
        opacity: 0.075,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.scene.add(this.beam);

    const dustPositions = new Float32Array(120 * 3);
    for (let i = 0; i < 120; i++) {
      const y = -0.67 + pseudoRandom(i * 3 + 1) * 1.2;
      const spread = 0.16 + (0.6 - y) * 0.22;
      dustPositions[i * 3] = (pseudoRandom(i * 3 + 2) - 0.5) * spread;
      dustPositions[i * 3 + 1] = y;
      dustPositions[i * 3 + 2] = (pseudoRandom(i * 3 + 3) - 0.5) * spread * 0.45;
    }
    this.dust = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(dustPositions, 3),
      ),
      new THREE.PointsMaterial({
        color: 0x8bf0df,
        size: 1.25,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.scene.add(this.dust);

    this.spin = true;
    this.updating = false;
    this.hasData = false;
    this.userYaw = 0;
    this.userPitch = 0.08;
    this.fadeStartedAt = 0;
    this.evidencePulseStartedAt = -Infinity;
    this.periodicPulseOrigin = performance.now();
    this.addedStartedAt = -Infinity;
    this.removedStartedAt = -Infinity;
    this.previousSelection = null;
    this.objectRadius = 1;
    this.stats = null;
    this.opacity = 0.9;
    this.pointSize = 2.8;
    this._drag = null;
    this._brush = null;
    this.editMode = 'view';
    this.hovered = false;
    this._pickVector = new THREE.Vector3();
    this._pickMatrix = new THREE.Matrix4();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    interactionElement.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (this.editMode === 'cleanup') {
        const indices = this._pickIndices(event.clientX, event.clientY);
        this._brush = {
          id: event.pointerId,
          lastX: event.clientX,
          lastY: event.clientY,
        };
        interactionElement.setPointerCapture(event.pointerId);
        this.onBrushStart(indices);
        event.preventDefault();
        return;
      }
      this._drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        yaw: this.userYaw,
        pitch: this.userPitch,
        moved: false,
      };
      interactionElement.setPointerCapture(event.pointerId);
    });
    interactionElement.addEventListener('pointermove', (event) => {
      if (this._brush && event.pointerId === this._brush.id) {
        if (Math.hypot(
          event.clientX - this._brush.lastX,
          event.clientY - this._brush.lastY,
        ) < 3) return;
        this._brush.lastX = event.clientX;
        this._brush.lastY = event.clientY;
        const indices = this._pickIndices(event.clientX, event.clientY);
        if (indices.length) this.onBrush(indices);
        event.preventDefault();
        return;
      }
      if (!this._drag || event.pointerId !== this._drag.id) return;
      if (Math.hypot(
        event.clientX - this._drag.x,
        event.clientY - this._drag.y,
      ) > 3) this._drag.moved = true;
      this.userYaw = this._drag.yaw + (event.clientX - this._drag.x) * 0.01;
      this.userPitch = THREE.MathUtils.clamp(
        this._drag.pitch + (event.clientY - this._drag.y) * 0.008,
        -0.8,
        0.8,
      );
    });
    const release = (event) => {
      if (this._brush && event.pointerId === this._brush.id) {
        this._brush = null;
        if (interactionElement.hasPointerCapture(event.pointerId)) {
          interactionElement.releasePointerCapture(event.pointerId);
        }
        this.onBrushEnd();
        return;
      }
      if (!this._drag || event.pointerId !== this._drag.id) return;
      const shouldPick = !this._drag.moved;
      this._drag = null;
      if (interactionElement.hasPointerCapture(event.pointerId)) {
        interactionElement.releasePointerCapture(event.pointerId);
      }
      if (shouldPick) {
        const picked = this._pickSurface(event.clientX, event.clientY);
        if (picked) {
          this.onSurfacePick({
            ...picked,
            centre: this.selectionCentre?.clone?.() ?? null,
            cutawayHalfSize: this.cutawayHalfSize ?? this.objectRadius,
          });
        }
      }
    };
    interactionElement.addEventListener('pointerup', release);
    interactionElement.addEventListener('pointercancel', release);
    interactionElement.addEventListener('pointerenter', () => {
      this.hovered = true;
    });
    interactionElement.addEventListener('pointerleave', () => {
      if (!this._drag && !this._brush) this.hovered = false;
    });
  }

  _makeLayer(color, opacity, { context = false } = {}) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(3), 3, true));
    geometry.setAttribute('labelColor', new THREE.BufferAttribute(new Uint8Array(3), 3, true));
    geometry.setAttribute('splatSize', new THREE.BufferAttribute(new Float32Array(1), 1));
    geometry.setAttribute('pointAlpha', new THREE.BufferAttribute(new Float32Array(1), 1));
    geometry.setDrawRange(0, 0);
    const label = new THREE.Color(color);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: context ? THREE.NormalBlending : THREE.NormalBlending,
      uniforms: {
        uOpacity: { value: opacity },
        uEvidence: { value: context ? 0 : 0 },
        uBaseSize: { value: context ? 1.1 : 1.5 },
        uViewportHeight: { value: 200 },
        uContext: { value: context ? 1 : 0 },
        uFallbackLabel: { value: label },
      },
      vertexShader: `
        attribute vec3 color;
        attribute vec3 labelColor;
        attribute float splatSize;
        attribute float pointAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uEvidence;
        uniform float uBaseSize;
        uniform float uViewportHeight;
        uniform float uContext;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float perspectiveSize = splatSize * uViewportHeight
            / max(0.5, -mvPosition.z) * 0.72;
          gl_PointSize = clamp(uBaseSize + perspectiveSize, 1.0, uContext > 0.5 ? 4.2 : 10.0);
          gl_Position = projectionMatrix * mvPosition;
          vColor = mix(color, labelColor, uEvidence);
          vAlpha = pointAlpha;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uOpacity;
        void main() {
          vec2 delta = gl_PointCoord - vec2(0.5);
          float radius2 = dot(delta, delta);
          if (radius2 > 0.25) discard;
          float gaussian = exp(-radius2 * 10.5);
          float alpha = gaussian * vAlpha * uOpacity;
          if (alpha < 0.012) discard;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return {
      geometry,
      material,
      points,
      count: 0,
      context,
      label: [label.r, label.g, label.b],
    };
  }

  setSpin(spin) {
    this.spin = Boolean(spin);
  }

  setUpdating(updating) {
    this.updating = Boolean(updating);
  }

  setEditMode(mode = 'view') {
    this.editMode = mode === 'cleanup' ? 'cleanup' : 'view';
    this.interactionElement.dataset.editing =
      this.editMode === 'cleanup' ? 'cleanup' : 'view';
  }

  resetView() {
    this.userYaw = 0;
    this.userPitch = 0.08;
  }

  setAppearance({ opacity = this.opacity, boundarySoftness = 20 } = {}) {
    this.opacity = opacity;
    this.pointSize = 2.2 + boundarySoftness * 0.025;
    this.layers.context.material.uniforms.uOpacity.value = 0.1;
    this.layers.confirmed.material.uniforms.uOpacity.value = opacity;
    this.layers.provisional.material.uniforms.uOpacity.value = opacity * 0.9;
    this.layers.locked.material.uniforms.uOpacity.value = Math.min(1, opacity * 1.04);
    this.layers.new.material.uniforms.uOpacity.value = Math.min(1, opacity * 1.08);
    this.layers.removed.material.uniforms.uOpacity.value = Math.min(0.9, opacity);
    for (const layer of Object.values(this.layers)) {
      layer.material.uniforms.uBaseSize.value = layer.context
        ? 1.05
        : Math.max(1.25, this.pointSize * 0.62);
    }
  }

  update({
    centers,
    colors,
    sourceOpacity,
    radii,
    grid,
    selection,
    confidence,
    locked,
    provisional = null,
    confirmThreshold = 0.72,
    recentlyAdded = null,
    viewMatrix = null,
    opacity = this.opacity,
    boundarySoftness = 20,
  }) {
    this.updating = false;
    this.setAppearance({ opacity, boundarySoftness });
    if (viewMatrix?.length === 16) {
      this.viewRotationMatrix.fromArray(viewMatrix);
      this.baseQuaternion.setFromRotationMatrix(this.viewRotationMatrix);
    } else {
      this.baseQuaternion.identity();
    }
    if (!centers || !selection?.size) {
      for (const layer of Object.values(this.layers)) {
        layer.geometry.setDrawRange(0, 0);
        layer.count = 0;
      }
      this.hasData = false;
      this.stats = null;
      this.onStats({
        total: 0,
        confirmed: 0,
        provisional: 0,
        locked: 0,
        new: 0,
        removed: 0,
        sampled: 0,
      });
      this.previousSelection = null;
      return;
    }

    const { centre, size } = robustSelectionBounds(centers, selection);
    const radius = Math.max(size.length() * 0.5, 1e-4);
    const cubeHalfSize = Math.max(
      Math.max(size.x, size.y, size.z) * 0.9,
      radius * 0.78,
      1e-4,
    );
    this.objectRadius = radius;
    this.selectionCentre = centre.clone();
    this.cutawayHalfSize = cubeHalfSize;
    const removedIndices = [];
    if (this.previousSelection) {
      for (const index of this.previousSelection) {
        if (!selection.has(index)) removedIndices.push(index);
      }
    }
    const stride = Math.max(1, Math.ceil(selection.size / MAX_PREVIEW_POINTS));
    const buckets = {
      confirmed: [],
      provisional: [],
      locked: [],
      new: [],
    };
    const contextIndices = collectContextIndices({
      grid,
      centers,
      sourceOpacity,
      selection,
      centre,
      halfSize: cubeHalfSize,
      maximum: MAX_CONTEXT_POINTS,
    });
    // These are mutually exclusive display buckets. "New" is also counted
    // independently because it is a short-lived explanation of the last
    // change, not a confidence class.
    const stats = {
      total: selection.size,
      confirmed: 0,
      provisional: 0,
      locked: 0,
      new: 0,
      removed: removedIndices.length,
      sampled: 0,
    };

    let ordinal = 0;
    for (const index of selection) {
      const isLocked = Boolean(locked?.[index]);
      const isNew = Boolean(recentlyAdded?.has?.(index));
      const isConfirmed = !provisional?.has?.(index)
        && (confidence?.[index] ?? 1) >= confirmThreshold;
      if (isLocked) {
        stats.locked++;
      }
      else if (isConfirmed) stats.confirmed++;
      else stats.provisional++;
      if (isNew && !isLocked) stats.new++;
      if (ordinal++ % stride !== 0) continue;

      const bucket = isLocked ? buckets.locked
        : isNew ? buckets.new
          : isConfirmed ? buckets.confirmed : buckets.provisional;
      bucket.push(index);
      stats.sampled++;
    }

    for (const [name, indices] of Object.entries(buckets)) {
      this._writeLayer(this.layers[name], indices, {
        centers,
        colors,
        sourceOpacity,
        radii,
        centre,
        objectRadius: radius,
        tint: name === 'locked' ? [88, 214, 168]
          : name === 'new' ? [112, 215, 255]
            : name === 'provisional' ? [242, 193, 78] : [255, 107, 56],
      });
    }
    this._writeLayer(this.layers.context, contextIndices, {
      centers,
      colors: null,
      sourceOpacity,
      radii,
      centre,
      objectRadius: radius,
      tint: [142, 151, 154],
      context: true,
    });
    if (removedIndices.length) {
      this._writeLayer(this.layers.removed, removedIndices, {
        centers,
        colors,
        sourceOpacity,
        radii,
        centre,
        objectRadius: radius,
        tint: [142, 151, 154],
      });
      this.removedStartedAt = performance.now();
      this.layers.removed.points.position.set(0, 0, 0);
    }

    this.hasData = true;
    this.root.scale.setScalar(1 / radius);
    this.contextCube.scale.setScalar(cubeHalfSize);
    this.contextCube.position.set(0, 0, 0);
    this.camera.near = 0.01;
    this.camera.far = 20;
    this.camera.position.set(0, 0.05, 2.38);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    const now = performance.now();
    const selectionChanged = !this.previousSelection
      || removedIndices.length > 0
      || stats.new > 0
      || this.previousSelection.size !== selection.size;
    this.fadeStartedAt = now;
    if (selectionChanged) this.evidencePulseStartedAt = now;
    if (stats.new) this.addedStartedAt = now;
    this.previousSelection = new Set(selection);
    this.stats = stats;
    this.onStats(stats);
  }

  _writeLayer(layer, indices, {
    centers,
    colors,
    sourceOpacity,
    radii,
    centre,
    objectRadius,
    tint,
    context = false,
  }) {
    const positions = new Float32Array(Math.max(1, indices.length) * 3);
    const outColors = new Uint8Array(Math.max(1, indices.length) * 3);
    const labelColors = new Uint8Array(Math.max(1, indices.length) * 3);
    const splatSizes = new Float32Array(Math.max(1, indices.length));
    const pointAlpha = new Float32Array(Math.max(1, indices.length));
    for (let n = 0; n < indices.length; n++) {
      const index = indices[n];
      const p = n * 3;
      positions[p] = centers[index * 3] - centre.x;
      positions[p + 1] = centers[index * 3 + 1] - centre.y;
      positions[p + 2] = centers[index * 3 + 2] - centre.z;
      const sourceAlpha = (sourceOpacity?.[index] ?? 255) / 255;
      const alpha = context
        ? 0.22 + sourceAlpha * 0.34
        : 0.5 + sourceAlpha * 0.5;
      for (let c = 0; c < 3; c++) {
        outColors[p + c] = context
          ? tint[c]
          : colors?.[index * 3 + c] ?? 220;
        labelColors[p + c] = tint[c];
      }
      splatSizes[n] = Math.max(
        0.0004,
        (radii?.[index] ?? objectRadius * 0.004) / Math.max(objectRadius, 1e-6),
      );
      pointAlpha[n] = alpha;
    }
    layer.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    layer.geometry.setAttribute('color', new THREE.BufferAttribute(outColors, 3, true));
    layer.geometry.setAttribute('labelColor', new THREE.BufferAttribute(labelColors, 3, true));
    layer.geometry.setAttribute('splatSize', new THREE.BufferAttribute(splatSizes, 1));
    layer.geometry.setAttribute('pointAlpha', new THREE.BufferAttribute(pointAlpha, 1));
    layer.geometry.computeBoundingSphere();
    layer.geometry.setDrawRange(0, indices.length);
    layer.sourceIndices = Int32Array.from(indices);
    layer.count = indices.length;
  }

  _pickIndices(clientX, clientY, radiusPx = 18) {
    if (!this.hasData) return [];
    const rect = this.interactionElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    const found = [];
    const radiusSquared = radiusPx * radiusPx;
    for (const [name, layer] of Object.entries(this.layers)) {
      if (name === 'context' || name === 'removed') continue;
      const position = layer.geometry.getAttribute('position');
      if (!position || !layer.sourceIndices?.length) continue;
      this._pickMatrix.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      ).multiply(layer.points.matrixWorld);
      for (let ordinal = 0; ordinal < layer.count; ordinal++) {
        this._pickVector.fromBufferAttribute(position, ordinal)
          .applyMatrix4(this._pickMatrix);
        if (this._pickVector.z < -1 || this._pickVector.z > 1) continue;
        const x = rect.left + (this._pickVector.x * 0.5 + 0.5) * rect.width;
        const y = rect.top + (-this._pickVector.y * 0.5 + 0.5) * rect.height;
        const dx = x - clientX;
        const dy = y - clientY;
        if (dx * dx + dy * dy <= radiusSquared) {
          found.push(layer.sourceIndices[ordinal]);
        }
      }
    }
    return found;
  }

  _pickSurface(clientX, clientY, radiusPx = 16) {
    if (!this.hasData || !this.selectionCentre) return null;
    const rect = this.interactionElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    let best = null;
    const radiusSquared = radiusPx * radiusPx;
    for (const [name, layer] of Object.entries(this.layers)) {
      if (name === 'context' || name === 'removed') continue;
      const position = layer.geometry.getAttribute('position');
      if (!position || !layer.sourceIndices?.length) continue;
      this._pickMatrix.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      ).multiply(layer.points.matrixWorld);
      for (let ordinal = 0; ordinal < layer.count; ordinal++) {
        this._pickVector.fromBufferAttribute(position, ordinal)
          .applyMatrix4(this._pickMatrix);
        if (this._pickVector.z < -1 || this._pickVector.z > 1) continue;
        const x = rect.left + (this._pickVector.x * 0.5 + 0.5) * rect.width;
        const y = rect.top + (-this._pickVector.y * 0.5 + 0.5) * rect.height;
        const distanceSquared = (x - clientX) ** 2 + (y - clientY) ** 2;
        if (distanceSquared > radiusSquared) continue;
        // Prefer the nearest rendered splat, then the closest pointer hit.
        const rank = this._pickVector.z * 0.35
          + distanceSquared / Math.max(1, radiusSquared);
        if (best && rank >= best.rank) continue;
        const index = layer.sourceIndices[ordinal];
        best = {
          index,
          rank,
          position: new THREE.Vector3(
            position.getX(ordinal) + this.selectionCentre.x,
            position.getY(ordinal) + this.selectionCentre.y,
            position.getZ(ordinal) + this.selectionCentre.z,
          ),
        };
      }
    }
    return best;
  }

  render(now = performance.now()) {
    if (!this.hasData) return;
    // This HUD belongs exclusively to the visible cockpit. Never draw it into
    // a model-input or synthetic-view target owned by another renderer pass.
    if (this.renderer.getRenderTarget() !== null) return;
    const target = this.interactionElement.getBoundingClientRect();
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const width = Math.max(1, target.width);
    const height = Math.max(1, target.height);
    if (target.right <= canvas.left || target.left >= canvas.right
      || target.bottom <= canvas.top || target.top >= canvas.bottom) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // A single-view selection has no verified back side yet. Rock around the
    // captured view instead of implying complete 360° evidence.
    const automaticYaw = this.spin && !this.hovered
      ? Math.sin(now * 0.00034) * 0.42
      : 0;
    this.interactionEuler.set(
      this.userPitch,
      this.userYaw + automaticYaw,
      0,
    );
    this.interactionQuaternion.setFromEuler(this.interactionEuler);
    this.root.quaternion.copy(this.interactionQuaternion).multiply(this.baseQuaternion);
    const addedProgress = THREE.MathUtils.clamp((now - this.addedStartedAt) / 1050, 0, 1);
    const addedEase = THREE.MathUtils.smoothstep(addedProgress, 0, 1);
    this.layers.new.points.position.y = this.reducedMotion
      ? 0
      : THREE.MathUtils.lerp(this.objectRadius * 0.16, 0, addedEase);
    this.layers.new.material.uniforms.uOpacity.value =
      this.opacity * (0.18 + addedEase * 0.82);

    const removedProgress = THREE.MathUtils.clamp((now - this.removedStartedAt) / 1250, 0, 1);
    this.layers.removed.points.position.y = this.reducedMotion
      ? 0
      : this.objectRadius * 0.18 * removedProgress;
    this.layers.removed.material.uniforms.uOpacity.value =
      this.opacity * (1 - removedProgress) * 0.84;
    if (removedProgress >= 1 && this.layers.removed.count) {
      this.layers.removed.geometry.setDrawRange(0, 0);
      this.layers.removed.count = 0;
      if (this.stats?.removed) {
        this.stats = { ...this.stats, removed: 0 };
        this.onStats(this.stats);
      }
    }
    const scanPeriod = this.updating ? 1900 : 4600;
    const scanDuration = this.updating ? 1500 : 820;
    const scanCycle = (now - this.fadeStartedAt) % scanPeriod;
    if (!this.reducedMotion && scanCycle < scanDuration) {
      const scanProgress = scanCycle / scanDuration;
      this.scanRing.position.y = THREE.MathUtils.lerp(-0.58, 0.62, scanProgress);
      this.scanRing.scale.setScalar(0.72 + Math.sin(scanProgress * Math.PI) * 0.16);
      this.scanRing.material.opacity = Math.sin(scanProgress * Math.PI)
        * (this.updating ? 0.22 : 0.32);
    } else {
      this.scanRing.material.opacity = 0;
    }
    const periodicCycle = (now - this.periodicPulseOrigin) % 4200;
    const periodicPulse = periodicCycle < 760
      ? Math.sin(periodicCycle / 760 * Math.PI)
      : 0;
    const changeAge = now - this.evidencePulseStartedAt;
    const changePulse = changeAge >= 0 && changeAge < 920
      ? Math.sin(changeAge / 920 * Math.PI)
      : 0;
    const evidencePulse = this.reducedMotion
      ? 0
      : Math.max(periodicPulse * 0.78, changePulse);
    for (const name of ['confirmed', 'provisional', 'locked']) {
      this.layers[name].material.uniforms.uEvidence.value = evidencePulse;
    }
    this.layers.new.material.uniforms.uEvidence.value = Math.max(
      evidencePulse,
      1 - addedEase,
    );
    this.layers.removed.material.uniforms.uEvidence.value = 1;
    this.layers.context.material.uniforms.uEvidence.value = 0;
    const physicalViewportHeight = height * this.renderer.getPixelRatio();
    for (const layer of Object.values(this.layers)) {
      // gl_PointSize is measured in drawing-buffer pixels, while DOM bounds
      // and WebGLRenderer's default-target viewport API use logical pixels.
      layer.material.uniforms.uViewportHeight.value = physicalViewportHeight;
    }
    this.dust.rotation.y = now * 0.000035;

    const x = target.left - canvas.left;
    const y = canvas.bottom - target.bottom;
    const clippedLeft = Math.max(target.left, canvas.left);
    const clippedRight = Math.min(target.right, canvas.right);
    const clippedTop = Math.max(target.top, canvas.top);
    const clippedBottom = Math.min(target.bottom, canvas.bottom);
    const scissorX = clippedLeft - canvas.left;
    const scissorY = canvas.bottom - clippedBottom;
    const scissorWidth = clippedRight - clippedLeft;
    const scissorHeight = clippedBottom - clippedTop;
    if (!(scissorWidth > 0) || !(scissorHeight > 0)) return;

    const rendererState = this._rendererState.capture();
    try {
      this.renderer.autoClear = false;
      this.renderer.setViewport(x, y, width, height);
      this.renderer.setScissor(scissorX, scissorY, scissorWidth, scissorHeight);
      this.renderer.setScissorTest(true);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
    } finally {
      rendererState.restore();
    }
  }

  dispose() {
    for (const layer of Object.values(this.layers)) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.scanRing.geometry.dispose();
    this.scanRing.material.dispose();
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    this.dust.geometry.dispose();
    this.dust.material.dispose();
    this.contextCube.geometry.dispose();
    this.contextCube.material.dispose();
  }
}

function collectContextIndices({
  grid,
  centers,
  sourceOpacity,
  selection,
  centre,
  halfSize,
  maximum,
}) {
  if (!grid?.start || !grid?.items || !Number.isFinite(halfSize)) return [];
  const minX = centre.x - halfSize;
  const minY = centre.y - halfSize;
  const minZ = centre.z - halfSize;
  const maxX = centre.x + halfSize;
  const maxY = centre.y + halfSize;
  const maxZ = centre.z + halfSize;
  const ix0 = clampCell(Math.floor((minX - grid.minX) / grid.cell), grid.nx);
  const iy0 = clampCell(Math.floor((minY - grid.minY) / grid.cell), grid.ny);
  const iz0 = clampCell(Math.floor((minZ - grid.minZ) / grid.cell), grid.nz);
  const ix1 = clampCell(Math.floor((maxX - grid.minX) / grid.cell), grid.nx);
  const iy1 = clampCell(Math.floor((maxY - grid.minY) / grid.cell), grid.ny);
  const iz1 = clampCell(Math.floor((maxZ - grid.minZ) / grid.cell), grid.nz);
  const cellCount = (ix1 - ix0 + 1) * (iy1 - iy0 + 1) * (iz1 - iz0 + 1);
  const cellStep = Math.max(
    1,
    Math.ceil(Math.cbrt(cellCount / MAX_CONTEXT_CELL_VISITS)),
  );

  let candidateCount = 0;
  for (let iz = iz0; iz <= iz1; iz += cellStep) {
    for (let iy = iy0; iy <= iy1; iy += cellStep) {
      for (let ix = ix0; ix <= ix1; ix += cellStep) {
        const cell = (iz * grid.ny + iy) * grid.nx + ix;
        candidateCount += grid.start[cell + 1] - grid.start[cell];
      }
    }
  }
  const stride = Math.max(1, Math.ceil(candidateCount / Math.max(1, maximum)));
  const context = [];
  let ordinal = 0;
  for (let iz = iz0; iz <= iz1 && context.length < maximum; iz += cellStep) {
    for (let iy = iy0; iy <= iy1 && context.length < maximum; iy += cellStep) {
      for (let ix = ix0; ix <= ix1 && context.length < maximum; ix += cellStep) {
        const cell = (iz * grid.ny + iy) * grid.nx + ix;
        for (let cursor = grid.start[cell]; cursor < grid.start[cell + 1]; cursor++) {
          if (ordinal++ % stride !== 0) continue;
          const index = grid.items[cursor];
          if (selection.has(index) || (sourceOpacity?.[index] ?? 255) < 8) continue;
          const x = centers[index * 3];
          const y = centers[index * 3 + 1];
          const z = centers[index * 3 + 2];
          if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) {
            continue;
          }
          context.push(index);
          if (context.length >= maximum) break;
        }
      }
    }
  }
  return context;
}

function clampCell(value, count) {
  return Math.max(0, Math.min(count - 1, value));
}

function robustSelectionBounds(centers, selection) {
  const maxSamples = 50_000;
  const stride = Math.max(1, Math.ceil(selection.size / maxSamples));
  const xs = [];
  const ys = [];
  const zs = [];
  let ordinal = 0;
  for (const index of selection) {
    if (ordinal++ % stride !== 0) continue;
    xs.push(centers[index * 3]);
    ys.push(centers[index * 3 + 1]);
    zs.push(centers[index * 3 + 2]);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const low = Math.floor(xs.length * 0.015);
  const high = Math.max(low, Math.ceil(xs.length * 0.985) - 1);
  const min = new THREE.Vector3(xs[low], ys[low], zs[low]);
  const max = new THREE.Vector3(xs[high], ys[high], zs[high]);
  return {
    centre: min.clone().add(max).multiplyScalar(0.5),
    size: max.sub(min),
  };
}

function makeRing(radius, y, segments = 96) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  });
}

function makeBrokenRing(radius, y, segments = 96) {
  const points = [];
  for (let index = 0; index < segments; index++) {
    const phase = index / segments;
    if ((phase > 0.11 && phase < 0.18) || (phase > 0.58 && phase < 0.68)) continue;
    const next = (index + 1) / segments;
    const a = phase * Math.PI * 2;
    const b = next * Math.PI * 2;
    points.push(
      new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius),
      new THREE.Vector3(Math.cos(b) * radius, y, Math.sin(b) * radius),
    );
  }
  return points;
}

function pseudoRandom(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function createRendererStateSnapshot(renderer) {
  return {
    renderTarget: null,
    activeCubeFace: 0,
    activeMipmapLevel: 0,
    viewport: new THREE.Vector4(),
    scissor: new THREE.Vector4(),
    clearColor: new THREE.Color(),
    capture() {
      this.renderTarget = renderer.getRenderTarget();
      this.activeCubeFace = renderer.getActiveCubeFace?.() ?? 0;
      this.activeMipmapLevel = renderer.getActiveMipmapLevel?.() ?? 0;
      renderer.getViewport(this.viewport);
      renderer.getScissor(this.scissor);
      this.scissorTest = renderer.getScissorTest();
      renderer.getClearColor(this.clearColor);
      this.clearAlpha = renderer.getClearAlpha();
      this.autoClear = renderer.autoClear;
      this.outputColorSpace = renderer.outputColorSpace;
      this.toneMapping = renderer.toneMapping;
      this.toneMappingExposure = renderer.toneMappingExposure;
      this.restored = false;
      return this;
    },
    restore() {
      if (this.restored) return;
      this.restored = true;
      renderer.outputColorSpace = this.outputColorSpace;
      renderer.toneMapping = this.toneMapping;
      renderer.toneMappingExposure = this.toneMappingExposure;
      renderer.setRenderTarget(
        this.renderTarget,
        this.activeCubeFace,
        this.activeMipmapLevel,
      );
      renderer.setViewport(this.viewport);
      renderer.setScissor(this.scissor);
      renderer.setScissorTest(this.scissorTest);
      renderer.setClearColor(this.clearColor, this.clearAlpha);
      renderer.autoClear = this.autoClear;
    },
  };
}
