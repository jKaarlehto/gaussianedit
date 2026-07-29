import * as THREE from 'three';

/**
 * Selection feedback without touching the splat renderer's shaders.
 *
 * Drawn as additive points at the selected splat centres, depth-tested
 * against nothing (splat renderers rarely write usable depth), so it reads
 * as a glowing marker layer over the splats. If you'd rather tint the
 * splats themselves, see README > "Tinting in-shader".
 */
export class Highlight {
  constructor(centers, color = 0xff5c2b) {
    this.centers = centers;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({
      color,
      size: 2.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 999;
    this._capacity = 0;
  }

  set(indices) {
    const n = indices.size ?? indices.length;
    if (n > this._capacity) {
      this._capacity = Math.ceil(n * 1.5);
      this.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(this._capacity * 3), 3),
      );
    }
    const arr = this.geometry.getAttribute('position').array;
    let w = 0;
    for (const i of indices) {
      arr[w++] = this.centers[i * 3];
      arr[w++] = this.centers[i * 3 + 1];
      arr[w++] = this.centers[i * 3 + 2];
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
