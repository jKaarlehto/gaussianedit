import * as THREE from 'three';

const MAX_SCENE_SAMPLES = 120_000;
const MAX_VIEW_SAMPLES = 48_000;
const FRAME_LOW_QUANTILE = 0.02;
const FRAME_HIGH_QUANTILE = 0.98;
const QUALITY_CHUNK = 500_000;

export function analyzeSceneFrame(centers, count, radii = null) {
  const sampleCount = Math.max(1, Math.min(count, MAX_SCENE_SAMPLES));
  const samples = new Float32Array(sampleCount * 3);
  const xs = [];
  const ys = [];
  const zs = [];
  const sampledRadii = [];
  let written = 0;

  for (let ordinal = 0; ordinal < sampleCount; ordinal++) {
    const index = Math.min(count - 1, Math.floor((ordinal + 0.5) * count / sampleCount));
    const x = centers[index * 3];
    const y = centers[index * 3 + 1];
    const z = centers[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    samples[written * 3] = x;
    samples[written * 3 + 1] = y;
    samples[written * 3 + 2] = z;
    xs.push(x);
    ys.push(y);
    zs.push(z);
    const radius = radii?.[index];
    if (Number.isFinite(radius) && radius > 0) sampledRadii.push(radius);
    written++;
  }
  if (!written) throw new Error('The scene contains no finite Gaussian positions.');

  xs.sort(ascending);
  ys.sort(ascending);
  zs.sort(ascending);
  const centre = new THREE.Vector3(
    quantile(xs, 0.5),
    quantile(ys, 0.5),
    quantile(zs, 0.5),
  );
  const min = new THREE.Vector3(
    quantile(xs, FRAME_LOW_QUANTILE),
    quantile(ys, FRAME_LOW_QUANTILE),
    quantile(zs, FRAME_LOW_QUANTILE),
  );
  const max = new THREE.Vector3(
    quantile(xs, FRAME_HIGH_QUANTILE),
    quantile(ys, FRAME_HIGH_QUANTILE),
    quantile(zs, FRAME_HIGH_QUANTILE),
  );
  const bounds = new THREE.Box3(min, max);
  const size = bounds.getSize(new THREE.Vector3());
  const scale = Math.max(size.length(), 1e-5);

  const retained = [];
  const densityBins = new Uint32Array(24 * 16 * 24);
  const distances = [];
  for (let ordinal = 0; ordinal < written; ordinal++) {
    const x = samples[ordinal * 3];
    const y = samples[ordinal * 3 + 1];
    const z = samples[ordinal * 3 + 2];
    if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) {
      continue;
    }
    retained.push(x, y, z);
    const dx = x - centre.x;
    const dy = y - centre.y;
    const dz = z - centre.z;
    distances.push(Math.hypot(dx, dy, dz));

    const bx = binCoordinate(x, min.x, max.x, 24);
    const by = binCoordinate(y, min.y, max.y, 16);
    const bz = binCoordinate(z, min.z, max.z, 24);
    densityBins[(by * 24 + bz) * 24 + bx]++;
  }
  distances.sort(ascending);
  const radius = Math.max(quantile(distances, 0.995), scale * 0.08);

  sampledRadii.sort(ascending);
  const typicalLargeRadius = quantile(sampledRadii, 0.95);
  const giantRadiusThreshold = sampledRadii.length
    ? Math.max(typicalLargeRadius * 4, scale * 0.003)
    : Infinity;
  let sampledGiantCount = 0;
  for (const sampleRadius of sampledRadii) {
    if (sampleRadius > giantRadiusThreshold) sampledGiantCount++;
  }
  const sampledGiantFraction = sampledRadii.length
    ? sampledGiantCount / sampledRadii.length
    : 0;
  const extremeRadius = quantile(sampledRadii, 0.999);
  // Large environmental splats are valid in some scenes. Only enable the
  // reversible cleanup automatically when the scale distribution has a clear
  // pathological tail and that tail is still a minority of the scene.
  const recommendQualityFilter = sampledRadii.length > 0
    && extremeRadius > giantRadiusThreshold * 3
    && sampledGiantFraction > 0
    && sampledGiantFraction < 0.08;

  let densestIndex = 0;
  for (let index = 1; index < densityBins.length; index++) {
    if (densityBins[index] > densityBins[densestIndex]) densestIndex = index;
  }
  const denseX = densestIndex % 24;
  const denseZ = Math.floor(densestIndex / 24) % 24;
  const denseY = Math.floor(densestIndex / (24 * 24));
  const denseCentre = new THREE.Vector3(
    binCentre(denseX, min.x, max.x, 24),
    binCentre(denseY, min.y, max.y, 16),
    binCentre(denseZ, min.z, max.z, 24),
  );

  return {
    centre,
    denseCentre,
    bounds,
    radius,
    scale,
    samples: new Float32Array(retained),
    sourceSampleCount: written,
    quality: {
      giantRadiusThreshold,
      sampledGiantFraction,
      extremeRadius,
      recommended: recommendQualityFilter,
    },
  };
}

/**
 * Mark only abnormally oversized reconstruction splats. This is a reversible
 * render/selection filter: the source buffer and exported scene remain intact.
 */
export async function buildSceneQualityMask({
  radii,
  count,
  frame,
  onProgress = () => {},
  isCanceled = () => false,
}) {
  const mask = new Uint8Array(count);
  const threshold = frame?.quality?.giantRadiusThreshold;
  if (!radii || !Number.isFinite(threshold)) {
    return { mask, hiddenCount: 0, threshold: Infinity, recommended: false };
  }

  let hiddenCount = 0;
  for (let start = 0; start < count; start += QUALITY_CHUNK) {
    if (isCanceled()) throw new DOMException('Scene analysis superseded', 'AbortError');
    const end = Math.min(count, start + QUALITY_CHUNK);
    for (let index = start; index < end; index++) {
      if (radii[index] > threshold) {
        mask[index] = 255;
        hiddenCount++;
      }
    }
    onProgress(end / count);
    if (end < count) await new Promise(requestAnimationFrame);
  }

  return {
    mask,
    hiddenCount,
    threshold,
    recommended: Boolean(frame.quality.recommended && hiddenCount),
  };
}

export function chooseHomeView({
  frame,
  fov,
  aspect,
  near,
  far,
  up = new THREE.Vector3(0, -1, 0),
}) {
  const limitingHalfFov = Math.min(
    THREE.MathUtils.degToRad(fov * 0.5),
    Math.atan(Math.tan(THREE.MathUtils.degToRad(fov * 0.5)) * Math.max(aspect, 0.1)),
  );
  const distance = frame.radius / Math.max(Math.sin(limitingHalfFov), 0.08) * 1.42;
  const candidateCamera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  candidateCamera.up.copy(up);
  const occupied = new Uint8Array(42 * 24);
  const sampleStride = Math.max(
    1,
    Math.ceil(frame.samples.length / 3 / MAX_VIEW_SAMPLES),
  );
  const candidateCentres = [frame.centre];
  if (frame.denseCentre.distanceToSquared(frame.centre) > frame.scale * frame.scale * 0.0004) {
    candidateCentres.push(frame.denseCentre);
  }
  let best = null;

  for (const [centreIndex, targetCentre] of candidateCentres.entries()) {
    // Build elevation along the supplied visual-up vector. Many 3DGS PLYs are
    // Y-down, so treating positive world Y as "above" can frame the scene from
    // underneath or leave Home with an inverted pitch.
    for (const elevation of [0.08, 0.2, 0.34]) {
      for (let step = 0; step < 16; step++) {
        const yaw = step / 16 * Math.PI * 2;
        const direction = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
          .addScaledVector(up, elevation)
          .normalize();
        candidateCamera.position.copy(targetCentre).addScaledVector(direction, distance);
        candidateCamera.lookAt(targetCentre);
        candidateCamera.updateProjectionMatrix();
        candidateCamera.updateMatrixWorld(true);
        const viewProjection = new THREE.Matrix4().multiplyMatrices(
          candidateCamera.projectionMatrix,
          candidateCamera.matrixWorldInverse,
        );
        occupied.fill(0);
        const elements = viewProjection.elements;
        let visible = 0;
        let occupiedCount = 0;
        let minX = 1;
        let minY = 1;
        let maxX = -1;
        let maxY = -1;

        for (let index = 0; index < frame.samples.length; index += 3 * sampleStride) {
          const x = frame.samples[index];
          const y = frame.samples[index + 1];
          const z = frame.samples[index + 2];
          const clipX = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
          const clipY = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
          const clipZ = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
          const clipW = elements[3] * x + elements[7] * y + elements[11] * z + elements[15];
          if (clipW <= 0) continue;
          const nx = clipX / clipW;
          const ny = clipY / clipW;
          const nz = clipZ / clipW;
          if (nx < -1 || nx > 1 || ny < -1 || ny > 1 || nz < -1 || nz > 1) continue;
          visible++;
          minX = Math.min(minX, nx);
          minY = Math.min(minY, ny);
          maxX = Math.max(maxX, nx);
          maxY = Math.max(maxY, ny);
          const gx = Math.min(41, Math.max(0, Math.floor((nx * 0.5 + 0.5) * 42)));
          const gy = Math.min(23, Math.max(0, Math.floor((-ny * 0.5 + 0.5) * 24)));
          const cell = gy * 42 + gx;
          if (!occupied[cell]) {
            occupied[cell] = 1;
            occupiedCount++;
          }
        }
        const screenArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
        const score = occupiedCount * 2 + screenArea * 180 + visible * 0.002;
        if (!best || score > best.score) {
          best = {
            position: candidateCamera.position.clone(),
            target: targetCentre.clone(),
            up: up.clone(),
            direction,
            distance,
            score,
            occupiedCells: occupiedCount,
            centreMode: centreIndex ? 'densest' : 'median',
          };
        }
      }
    }
  }
  return best;
}

export function chooseInteriorHomeView({
  frame,
  fov,
  aspect,
  near,
  far,
  up = new THREE.Vector3(0, -1, 0),
  position = new THREE.Vector3(),
}) {
  const paddedBounds = frame.bounds.clone().expandByScalar(frame.scale * 0.06);
  if (!paddedBounds.containsPoint(position)) return null;

  const candidateCamera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  candidateCamera.up.copy(up);
  candidateCamera.position.copy(position);
  const occupied = new Uint8Array(42 * 24);
  const sampleStride = Math.max(
    1,
    Math.ceil(frame.samples.length / 3 / MAX_VIEW_SAMPLES),
  );
  const targetDistance = Math.max(frame.scale * 0.18, near * 20);
  let best = null;

  for (const elevation of [-0.24, -0.12, 0, 0.1]) {
    for (let step = 0; step < 20; step++) {
      const yaw = step / 20 * Math.PI * 2;
      const lookDirection = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw))
        .addScaledVector(up, elevation)
        .normalize();
      const target = position.clone().addScaledVector(lookDirection, targetDistance);
      candidateCamera.lookAt(target);
      candidateCamera.updateProjectionMatrix();
      candidateCamera.updateMatrixWorld(true);
      const viewProjection = new THREE.Matrix4().multiplyMatrices(
        candidateCamera.projectionMatrix,
        candidateCamera.matrixWorldInverse,
      );
      const elements = viewProjection.elements;
      occupied.fill(0);
      let visible = 0;
      let occupiedCount = 0;
      let dangerouslyNear = 0;
      let minX = 1;
      let minY = 1;
      let maxX = -1;
      let maxY = -1;

      for (let index = 0; index < frame.samples.length; index += 3 * sampleStride) {
        const x = frame.samples[index];
        const y = frame.samples[index + 1];
        const z = frame.samples[index + 2];
        const dx = x - position.x;
        const dy = y - position.y;
        const dz = z - position.z;
        const distance = Math.hypot(dx, dy, dz);
        const clipX = elements[0] * x + elements[4] * y + elements[8] * z + elements[12];
        const clipY = elements[1] * x + elements[5] * y + elements[9] * z + elements[13];
        const clipZ = elements[2] * x + elements[6] * y + elements[10] * z + elements[14];
        const clipW = elements[3] * x + elements[7] * y + elements[11] * z + elements[15];
        if (clipW <= 0) continue;
        const nx = clipX / clipW;
        const ny = clipY / clipW;
        const nz = clipZ / clipW;
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1 || nz < -1 || nz > 1) continue;
        visible++;
        if (distance < frame.scale * 0.012) dangerouslyNear++;
        minX = Math.min(minX, nx);
        minY = Math.min(minY, ny);
        maxX = Math.max(maxX, nx);
        maxY = Math.max(maxY, ny);
        const gx = Math.min(41, Math.max(0, Math.floor((nx * 0.5 + 0.5) * 42)));
        const gy = Math.min(23, Math.max(0, Math.floor((-ny * 0.5 + 0.5) * 24)));
        const cell = gy * 42 + gx;
        if (!occupied[cell]) {
          occupied[cell] = 1;
          occupiedCount++;
        }
      }
      const screenArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
      const score = occupiedCount * 2
        + screenArea * 160
        + visible * 0.002
        - dangerouslyNear * 0.08;
      if (!best || score > best.score) {
        best = {
          position: position.clone(),
          target,
          up: up.clone(),
          direction: lookDirection.clone().negate(),
          distance: targetDistance,
          score,
          occupiedCells: occupiedCount,
          mode: 'interior',
        };
      }
    }
  }
  return best;
}

function binCoordinate(value, minimum, maximum, bins) {
  if (maximum <= minimum) return 0;
  return Math.min(
    bins - 1,
    Math.max(0, Math.floor((value - minimum) / (maximum - minimum) * bins)),
  );
}

function binCentre(index, minimum, maximum, bins) {
  return minimum + (index + 0.5) / bins * (maximum - minimum);
}

function quantile(sorted, fraction) {
  if (!sorted.length) return 0;
  const position = THREE.MathUtils.clamp(fraction, 0, 1) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return THREE.MathUtils.lerp(sorted[low], sorted[high], position - low);
}

function ascending(a, b) {
  return a - b;
}
