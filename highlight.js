import * as THREE from 'three';

const MODE_STATIC = 0;
const MODE_UNCERTAIN = 1;
const MODE_MATERIALIZE = 2;
const MODE_DISSOLVE = 3;

/**
 * Selection feedback without modifying the Gaussian renderer's shaders.
 *
 * Stable states stay quiet. Provisional points carry a restrained traveling
 * ripple, newly discovered points resolve behind a one-shot coherence wave,
 * and removed points briefly dissolve. The visual grammar communicates state
 * transitions without leaving the scene in constant motion.
 */
export class Highlight {
  constructor(centers) {
    this.centers = centers;
    this.points = new THREE.Group();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.layers = {
      confirmed: this._createLayer(0xff5c2b, 0.92, MODE_STATIC),
      provisional: this._createLayer(0xf2c14e, 0.54, MODE_UNCERTAIN),
      locked: this._createLayer(0x58d6a8, 1, MODE_STATIC),
      recent: this._createLayer(0x70d7ff, 1, MODE_MATERIALIZE),
      rejected: this._createLayer(0x8e979a, 0.82, MODE_DISSOLVE),
      ghost: this._createLayer(0x70d7ff, 0.2, MODE_STATIC),
    };
    for (const layer of Object.values(this.layers)) this.points.add(layer.points);
    this.material = this.layers.confirmed.material;
    this.previousIndices = null;
    this.rejectedStartedAt = -Infinity;
    this.recentSignature = '';
  }

  _createLayer(color, opacity, mode) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geometry.setDrawRange(0, 0);
    const material = mode === MODE_STATIC
      ? new THREE.PointsMaterial({
        color,
        size: 2.5,
        sizeAttenuation: false,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      })
      : createRippleMaterial({
        color,
        opacity,
        size: 2.5,
        mode,
        reducedMotion: this.reducedMotion,
      });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 999 + mode;
    return {
      geometry,
      material,
      points,
      capacity: 0,
      mode,
      opacity,
      size: 2.5,
      count: 0,
      baseColor: new THREE.Color(color),
    };
  }

  set(indices, {
    confidence = null,
    locked = null,
    provisional = null,
    confirmThreshold = 0.72,
    recentlyAdded = null,
    opacity = 0.9,
    boundarySoftness = 20,
  } = {}) {
    const current = indices instanceof Set ? indices : new Set(indices);
    const buckets = {
      confirmed: [],
      provisional: [],
      locked: [],
      recent: [],
    };
    for (const index of current) {
      const layer = locked?.[index] ? 'locked'
        : recentlyAdded?.has?.(index) ? 'recent'
          : provisional?.has?.(index) ? 'provisional'
            : (confidence?.[index] ?? 1) >= confirmThreshold ? 'confirmed' : 'provisional';
      buckets[layer].push(index);
    }
    for (const [name, values] of Object.entries(buckets)) {
      this._writeLayer(this.layers[name], values);
    }

    if (this.previousIndices) {
      const rejected = [];
      for (const index of this.previousIndices) {
        if (!current.has(index)) rejected.push(index);
      }
      if (rejected.length) {
        this._writeLayer(this.layers.rejected, rejected);
        this.rejectedStartedAt = performance.now() / 1000;
        this._setStart(this.layers.rejected, this.rejectedStartedAt);
      }
    }
    this.previousIndices = new Set(current);

    const size = 2.2 + boundarySoftness * 0.025;
    this._setAppearance(this.layers.confirmed, opacity, size);
    this._setAppearance(this.layers.provisional, opacity * 0.58, size);
    this._setAppearance(this.layers.locked, Math.min(1, opacity * 1.08), size);
    this._setAppearance(this.layers.recent, Math.min(1, opacity * 1.08), size);
    this._setAppearance(this.layers.rejected, Math.min(1, opacity * 0.86), size);
    const recentSignature = buckets.recent.length
      ? `${buckets.recent.length}:${buckets.recent[0]}:${buckets.recent.at(-1)}`
      : '';
    if (recentSignature && recentSignature !== this.recentSignature) {
      this._setStart(this.layers.recent, performance.now() / 1000);
    }
    this.recentSignature = recentSignature;
  }

  setGhost(indices = [], emphasized = false) {
    const values = indices instanceof Set ? [...indices] : [...indices];
    this._writeLayer(this.layers.ghost, values);
    this._setAppearance(
      this.layers.ghost,
      emphasized ? 0.38 : 0.18,
      emphasized ? 3.2 : 2.25,
    );
  }

  clearGhost() {
    this._writeLayer(this.layers.ghost, []);
  }

  showDiff(added = [], removed = []) {
    const addedValues = added instanceof Set ? [...added] : [...added];
    const removedValues = removed instanceof Set ? [...removed] : [...removed];
    const now = performance.now() / 1000;
    this._writeLayer(this.layers.recent, addedValues);
    this._setStart(this.layers.recent, now);
    this.recentSignature = addedValues.length
      ? `diff:${addedValues.length}:${addedValues[0]}:${addedValues.at(-1)}`
      : '';
    this._writeLayer(this.layers.rejected, removedValues);
    if (removedValues.length) {
      this.rejectedStartedAt = now;
      this._setStart(this.layers.rejected, now);
    }
  }

  _writeLayer(layer, indices) {
    if (indices.length > layer.capacity) {
      layer.capacity = Math.ceil(indices.length * 1.35);
      layer.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(layer.capacity * 3), 3),
      );
    }
    const positions = layer.geometry.getAttribute('position');
    const target = positions.array;
    let write = 0;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const index of indices) {
      const x = this.centers[index * 3];
      const y = this.centers[index * 3 + 1];
      const z = this.centers[index * 3 + 2];
      target[write++] = x;
      target[write++] = y;
      target[write++] = z;
      min.x = Math.min(min.x, x);
      min.y = Math.min(min.y, y);
      min.z = Math.min(min.z, z);
      max.x = Math.max(max.x, x);
      max.y = Math.max(max.y, y);
      max.z = Math.max(max.z, z);
    }
    positions.needsUpdate = true;
    layer.geometry.setDrawRange(0, indices.length);
    layer.count = indices.length;
    if (layer.material.isShaderMaterial && indices.length) {
      const centre = layer.material.uniforms.uCenter.value;
      centre.addVectors(min, max).multiplyScalar(0.5);
      layer.material.uniforms.uExtent.value = Math.max(min.distanceTo(max) * 0.5, 1e-5);
    }
  }

  _setAppearance(layer, opacity, size) {
    layer.opacity = opacity;
    layer.size = size;
    if (layer.material.isShaderMaterial) {
      layer.material.uniforms.uOpacity.value = opacity;
      layer.material.uniforms.uSize.value = size;
    } else {
      layer.material.opacity = opacity;
      layer.material.size = size;
    }
  }

  _setStart(layer, seconds) {
    if (layer.material.isShaderMaterial) layer.material.uniforms.uStarted.value = seconds;
  }

  animate(now = performance.now()) {
    const seconds = now / 1000;
    for (const layer of Object.values(this.layers)) {
      if (layer.material.isShaderMaterial) {
        layer.material.uniforms.uTime.value = seconds;
      }
    }
    if (seconds - this.rejectedStartedAt > 1.65 && this.layers.rejected.count) {
      this.layers.rejected.geometry.setDrawRange(0, 0);
      this.layers.rejected.count = 0;
    }
  }

  setPointSize(size) {
    for (const layer of Object.values(this.layers)) {
      this._setAppearance(layer, layer.opacity, size);
    }
  }

  setContextAppearance(enabled = false) {
    const contextColor = new THREE.Color(0x83a8ad);
    for (const [name, layer] of Object.entries(this.layers)) {
      if (name === 'ghost') continue;
      const color = enabled ? contextColor : layer.baseColor;
      if (layer.material.isShaderMaterial) {
        layer.material.uniforms.uColor.value.copy(color);
        layer.material.uniforms.uOpacity.value = enabled
          ? Math.min(0.16, layer.opacity * 0.2)
          : layer.opacity;
      } else {
        layer.material.color.copy(color);
        layer.material.opacity = enabled
          ? Math.min(0.16, layer.opacity * 0.2)
          : layer.opacity;
      }
    }
  }

  dispose() {
    for (const layer of Object.values(this.layers)) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
  }
}

function createRippleMaterial({
  color,
  opacity,
  size,
  mode,
  reducedMotion,
}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uSize: { value: size },
      uTime: { value: 0 },
      uStarted: { value: performance.now() / 1000 },
      uCenter: { value: new THREE.Vector3() },
      uExtent: { value: 1 },
      uMode: { value: mode },
      uReducedMotion: { value: reducedMotion ? 1 : 0 },
    },
    vertexShader: `
      uniform float uSize;
      uniform float uTime;
      uniform float uStarted;
      uniform vec3 uCenter;
      uniform float uExtent;
      uniform int uMode;
      uniform float uReducedMotion;
      varying float vAlpha;

      void main() {
        float radius = length(position - uCenter) / max(uExtent, 0.00001);
        float pointSize = uSize;
        vAlpha = 1.0;
        vec3 animatedPosition = position;

        if (uReducedMotion < 0.5 && uMode == ${MODE_UNCERTAIN}) {
          float wave = 0.5 + 0.5 * sin(uTime * 1.8 - radius * 12.0);
          vAlpha = 0.78 + wave * 0.22;
          pointSize *= 0.94 + wave * 0.12;
        } else if (uReducedMotion < 0.5 && uMode == ${MODE_MATERIALIZE}) {
          float progress = clamp((uTime - uStarted) / 1.35, 0.0, 1.0);
          float front = progress * 1.28;
          float ring = exp(-pow((radius - front) * 13.0, 2.0));
          float settled = smoothstep(radius / 1.28, radius / 1.28 + 0.16, progress);
          vAlpha = max(0.08 + ring * 0.92, settled);
          pointSize *= 0.62 + ring * 1.15 + settled * 0.38;
          animatedPosition.y += (1.0 - progress) * uExtent * 0.16;
        } else if (uReducedMotion < 0.5 && uMode == ${MODE_DISSOLVE}) {
          float progress = clamp((uTime - uStarted) / 1.55, 0.0, 1.0);
          float flicker = 0.5 + 0.5 * sin(
            dot(position - uCenter, vec3(31.7, 17.3, 23.9)) / max(uExtent, 0.00001)
            + uTime * 24.0
          );
          vAlpha = (1.0 - progress) * (0.48 + flicker * 0.52);
          pointSize *= 1.0 + progress * 0.65;
          animatedPosition.y += progress * uExtent * 0.18;
        }

        gl_PointSize = pointSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(animatedPosition, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;

      void main() {
        float distanceToCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float particle = 1.0 - smoothstep(0.2, 1.0, distanceToCenter);
        float alpha = particle * vAlpha * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    blending: mode === MODE_MATERIALIZE || mode === MODE_DISSOLVE
      ? THREE.NormalBlending
      : THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
}
