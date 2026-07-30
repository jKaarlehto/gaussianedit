import * as THREE from 'three';

const MAX_DOCK_POINTS = 24_000;

/**
 * Camera-attached 3D cargo dock.
 *
 * Finalized objects remain real Three.js geometry in the cockpit rather than
 * becoming DOM cards or independent viewports. The original Gaussian IDs are
 * represented by a sampled, normalized point miniature and picked with a
 * normal Three.js raycaster.
 */
export class SegmentDock {
  constructor(camera, interactionElement, {
    onInspect = () => {},
  } = {}) {
    this.camera = camera;
    this.interactionElement = interactionElement;
    this.onInspect = onInspect;
    this.entries = new Map();
    this.hitTargets = [];
    this.activeId = null;
    this.hoveredId = null;
    this.pointer = null;

    this.root = new THREE.Group();
    this.root.name = 'cockpit-object-dock';
    this.root.position.set(0, -1.04, -2.42);
    this.root.renderOrder = 2100;
    camera.add(this.root);

    this.shelf = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x70d7ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.shelf.frustumCulled = false;
    this.shelf.renderOrder = 2100;
    this.root.add(this.shelf);

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._onPointerMove = (event) => {
      if (this.pointer) return;
      const id = this.hitTest(event.clientX, event.clientY);
      if (id === this.hoveredId) return;
      this.hoveredId = id;
      this._updateAppearance();
      interactionElement.style.cursor = id == null ? '' : 'pointer';
    };
    this._onPointerLeave = () => {
      if (this.pointer) return;
      this.hoveredId = null;
      this._updateAppearance();
      interactionElement.style.cursor = '';
    };
    this._onPointerDown = (event) => {
      if (event.button !== 0) return;
      const id = this.hitTest(event.clientX, event.clientY);
      if (id == null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.pointer = {
        id: event.pointerId,
        segmentId: id,
        x: event.clientX,
        y: event.clientY,
      };
      interactionElement.setPointerCapture(event.pointerId);
    };
    this._onPointerUp = (event) => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const pointer = this.pointer;
      this.pointer = null;
      if (interactionElement.hasPointerCapture(event.pointerId)) {
        interactionElement.releasePointerCapture(event.pointerId);
      }
      const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
      if (distance < 7) this.onInspect(pointer.segmentId);
    };
    this._onPointerCancel = (event) => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      this.pointer = null;
      if (interactionElement.hasPointerCapture(event.pointerId)) {
        interactionElement.releasePointerCapture(event.pointerId);
      }
    };

    interactionElement.addEventListener('pointermove', this._onPointerMove, true);
    interactionElement.addEventListener('pointerleave', this._onPointerLeave, true);
    interactionElement.addEventListener('pointerdown', this._onPointerDown, true);
    interactionElement.addEventListener('pointerup', this._onPointerUp, true);
    interactionElement.addEventListener('pointercancel', this._onPointerCancel, true);
  }

  add(segment, {
    centers,
    colors,
    sourceOpacity,
  }) {
    const entry = makeDockEntry(segment, centers, colors, sourceOpacity);
    this.entries.set(segment.id, entry);
    this.hitTargets.push(entry.hitTarget);
    this.root.add(entry.group);
    this._layout();
    this._updateAppearance();
  }

  remove(segmentId) {
    const entry = this.entries.get(segmentId);
    if (!entry) return;
    this.root.remove(entry.group);
    this.hitTargets = this.hitTargets.filter((target) => target !== entry.hitTarget);
    disposeObject(entry.group);
    this.entries.delete(segmentId);
    if (this.activeId === segmentId) this.activeId = null;
    if (this.hoveredId === segmentId) this.hoveredId = null;
    this._layout();
    this._updateAppearance();
  }

  clear() {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.activeId = null;
    this.hoveredId = null;
    this.interactionElement.style.cursor = '';
  }

  setActive(segmentId) {
    this.activeId = this.entries.has(segmentId) ? segmentId : null;
    this._updateAppearance();
  }

  hitTest(clientX, clientY) {
    if (!this.hitTargets.length) return null;
    const rect = this.interactionElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.hitTargets, false)[0];
    return hit?.object?.userData?.segmentId ?? null;
  }

  animate(now = performance.now()) {
    if (!this.entries.size) return;
    const seconds = now / 1000;
    for (const [id, entry] of this.entries) {
      const arrival = THREE.MathUtils.smoothstep(
        (now - entry.arrivedAt) / 620,
        0,
        1,
      );
      entry.content.scale.setScalar(0.06 + arrival * 0.94);
      entry.content.position.y = (1 - arrival) * 0.46;
      if (!this.reducedMotion) {
        entry.object.rotation.y = seconds * 0.34 + id * 0.73;
        entry.scanRing.rotation.z = seconds * 0.18;
      }
      entry.beam.material.opacity = (1 - arrival) * 0.48 + 0.055;
    }
  }

  _layout() {
    const entries = [...this.entries.values()];
    const count = entries.length;
    const available = Math.max(1.5, this.camera.aspect * 2.12);
    const spacing = Math.min(0.72, available / Math.max(count, 1));
    entries.forEach((entry, index) => {
      entry.group.position.x = (index - (count - 1) * 0.5) * spacing;
    });

    const halfWidth = count ? Math.max(0.48, (count - 1) * spacing * 0.5 + 0.42) : 0;
    if (count) {
      this.shelf.geometry.setFromPoints([
        new THREE.Vector3(-halfWidth, -0.31, 0),
        new THREE.Vector3(halfWidth, -0.31, 0),
        new THREE.Vector3(-halfWidth, -0.31, 0),
        new THREE.Vector3(-halfWidth + 0.12, -0.24, 0),
        new THREE.Vector3(halfWidth, -0.31, 0),
        new THREE.Vector3(halfWidth - 0.12, -0.24, 0),
      ]);
    } else {
      this.shelf.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(0), 3),
      );
      this.shelf.geometry.setDrawRange(0, 0);
    }
    this.shelf.material.opacity = count ? 0.34 : 0;
  }

  _updateAppearance() {
    for (const [id, entry] of this.entries) {
      const active = id === this.activeId;
      const hovered = id === this.hoveredId;
      entry.points.material.opacity = active ? 1 : hovered ? 0.95 : 0.78;
      entry.points.material.size = active ? 2.8 : hovered ? 2.5 : 2.15;
      entry.ring.material.opacity = active ? 0.72 : hovered ? 0.48 : 0.26;
      entry.scanRing.material.opacity = active ? 0.55 : hovered ? 0.3 : 0.08;
      entry.group.scale.setScalar(active ? 1.08 : hovered ? 1.04 : 1);
    }
  }

  dispose() {
    this.clear();
    this.camera.remove(this.root);
    this.shelf.geometry.dispose();
    this.shelf.material.dispose();
    this.interactionElement.removeEventListener('pointermove', this._onPointerMove, true);
    this.interactionElement.removeEventListener('pointerleave', this._onPointerLeave, true);
    this.interactionElement.removeEventListener('pointerdown', this._onPointerDown, true);
    this.interactionElement.removeEventListener('pointerup', this._onPointerUp, true);
    this.interactionElement.removeEventListener('pointercancel', this._onPointerCancel, true);
  }
}

function makeDockEntry(segment, centers, colors, sourceOpacity) {
  const group = new THREE.Group();
  group.renderOrder = 2110;
  const content = new THREE.Group();
  group.add(content);

  const { centre, radius, sampledIds } = selectionBounds(centers, segment.ids);
  const positions = new Float32Array(Math.max(1, sampledIds.length) * 3);
  const outColors = new Uint8Array(Math.max(1, sampledIds.length) * 3);
  for (let ordinal = 0; ordinal < sampledIds.length; ordinal++) {
    const index = sampledIds[ordinal];
    const offset = ordinal * 3;
    positions[offset] = (centers[index * 3] - centre.x) / radius;
    positions[offset + 1] = (centers[index * 3 + 1] - centre.y) / radius;
    positions[offset + 2] = (centers[index * 3 + 2] - centre.z) / radius;
    const sourceAlpha = 0.62 + (sourceOpacity?.[index] ?? 255) / 255 * 0.38;
    outColors[offset] = Math.round(((colors?.[index * 3] ?? 220) * 0.78 + 112 * 0.22) * sourceAlpha);
    outColors[offset + 1] = Math.round(((colors?.[index * 3 + 1] ?? 220) * 0.78 + 215 * 0.22) * sourceAlpha);
    outColors[offset + 2] = Math.round(((colors?.[index * 3 + 2] ?? 220) * 0.78 + 255 * 0.22) * sourceAlpha);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(outColors, 3, true));
  geometry.setDrawRange(0, sampledIds.length);
  const material = new THREE.PointsMaterial({
    size: 2.15,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2120;
  const object = new THREE.Group();
  object.scale.setScalar(0.27);
  object.add(points);
  content.add(object);

  const ringPoints = Array.from({ length: 48 }, (_, index) => {
    const angle = index / 48 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * 0.3, -0.23, Math.sin(angle) * 0.12);
  });
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPoints),
    new THREE.LineBasicMaterial({
      color: 0x70d7ff,
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  ring.renderOrder = 2115;
  content.add(ring);

  const scanRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPoints.map((point) =>
      new THREE.Vector3(point.x * 0.72, point.y + 0.23, point.z * 0.72))),
    new THREE.LineBasicMaterial({
      color: 0xa8fff2,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  scanRing.renderOrder = 2125;
  content.add(scanRing);

  const beam = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.24, -0.22, 0), new THREE.Vector3(-0.08, 0.18, 0),
      new THREE.Vector3(0.24, -0.22, 0), new THREE.Vector3(0.08, 0.18, 0),
    ]),
    new THREE.LineBasicMaterial({
      color: 0x70d7ff,
      transparent: true,
      opacity: 0.055,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  beam.renderOrder = 2112;
  content.add(beam);

  const hitTarget = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.62),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    }),
  );
  hitTarget.position.y = -0.02;
  hitTarget.userData.segmentId = segment.id;
  hitTarget.renderOrder = 2130;
  group.add(hitTarget);

  return {
    group,
    content,
    object,
    points,
    ring,
    scanRing,
    beam,
    hitTarget,
    arrivedAt: performance.now(),
  };
}

function selectionBounds(centers, ids) {
  const stride = Math.max(1, Math.ceil(ids.length / MAX_DOCK_POINTS));
  const sampledIds = [];
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let ordinal = 0; ordinal < ids.length; ordinal += stride) {
    const index = ids[ordinal];
    sampledIds.push(index);
    const x = centers[index * 3];
    const y = centers[index * 3 + 1];
    const z = centers[index * 3 + 2];
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const radius = Math.max(min.distanceTo(max) * 0.5, 1e-5);
  return { centre, radius, sampledIds };
}

function disposeObject(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      for (const material of object.material) material.dispose();
    } else {
      object.material?.dispose?.();
    }
  });
}
