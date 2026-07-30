import * as THREE from 'three';

const MAX_ANALYSIS_POINTS = 60_000;

/**
 * Describe the selected Gaussian region without letting a few floaters define
 * its centre or scale. The principal axes are retained for later elevated
 * orbit planning and coverage visualization.
 */
export function analyzeSelectedObject({
  centers,
  selection,
  camera,
}) {
  if (!centers || !selection?.size) {
    throw new Error('Synthetic view planning needs a non-empty 3D selection.');
  }

  const stride = Math.max(1, Math.ceil(selection.size / MAX_ANALYSIS_POINTS));
  const samples = [];
  const xs = [];
  const ys = [];
  const zs = [];
  let ordinal = 0;
  for (const index of selection) {
    if (ordinal++ % stride !== 0) continue;
    const point = new THREE.Vector3(
      centers[index * 3],
      centers[index * 3 + 1],
      centers[index * 3 + 2],
    );
    samples.push(point);
    xs.push(point.x);
    ys.push(point.y);
    zs.push(point.z);
  }
  xs.sort(ascending);
  ys.sort(ascending);
  zs.sort(ascending);

  const centre = new THREE.Vector3(
    quantile(xs, 0.5),
    quantile(ys, 0.5),
    quantile(zs, 0.5),
  );
  const robustMin = new THREE.Vector3(
    quantile(xs, 0.02),
    quantile(ys, 0.02),
    quantile(zs, 0.02),
  );
  const robustMax = new THREE.Vector3(
    quantile(xs, 0.98),
    quantile(ys, 0.98),
    quantile(zs, 0.98),
  );
  const distances = samples.map((point) => point.distanceTo(centre)).sort(ascending);
  const radius = Math.max(
    quantile(distances, 0.96),
    robustMin.distanceTo(robustMax) * 0.18,
    1e-5,
  );

  const covariance = covarianceMatrix(samples, centre);
  const axis0 = powerIteration(covariance, new THREE.Vector3(1, 0.37, 0.13));
  const axis1 = powerIterationOrthogonal(
    covariance,
    axis0,
    new THREE.Vector3(-0.21, 1, 0.31),
  );
  const axis2 = new THREE.Vector3().crossVectors(axis0, axis1).normalize();

  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const viewDirection = cameraPosition.clone().sub(centre);
  if (viewDirection.lengthSq() < 1e-10) {
    camera.getWorldDirection(viewDirection).negate();
  }
  viewDirection.normalize();

  const worldUp = camera.up.clone().normalize();
  const horizontalDirection = viewDirection.clone()
    .addScaledVector(worldUp, -viewDirection.dot(worldUp));
  if (horizontalDirection.lengthSq() < 1e-8) {
    horizontalDirection.crossVectors(axis0, worldUp);
  }
  horizontalDirection.normalize();

  return {
    centre,
    radius,
    robustMin,
    robustMax,
    principalAxes: [axis0, axis1, axis2],
    cameraDistance: Math.max(cameraPosition.distanceTo(centre), radius * 2),
    viewDirection,
    horizontalDirection,
    worldUp,
    sampleCount: samples.length,
    selectionCount: selection.size,
  };
}

/**
 * Create two short tracking branches from the accepted view: clockwise and
 * counter-clockwise. Each branch starts close to the seed view, avoiding the
 * identity-breaking jump that a naively ordered full orbit would create.
 */
export function generateSyntheticOrbitViews({
  analysis,
  camera,
  count = 8,
  width,
  height,
  maxYawDegrees = 92,
  maxTrackingStepDegrees = 10,
}) {
  const safeCount = Math.max(2, Math.min(24, Math.round(count)));
  const branchLength = Math.ceil(safeCount / 2);
  // Sparse scans must stay close to the accepted camera. Jumping directly to
  // ±92° with only two frames gives a tracker no intermediate appearance
  // changes to follow. Denser scans earn a wider arc through small steps.
  const effectiveMaxYaw = safeCount <= 2
    ? Math.min(maxYawDegrees, 38)
    : safeCount <= 4
      ? Math.min(maxYawDegrees, 72)
      : maxYawDegrees;
  const fitDistance = analysis.radius
    / Math.max(Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)), 0.08)
    * 1.42;
  const sourcePosition = camera.getWorldPosition(new THREE.Vector3());
  const sourceDistance = Math.max(
    analysis.radius,
    sourcePosition.distanceTo(analysis.centre),
  );
  // The scan is about the selected object, not the whole scene. Preserving a
  // distant source camera makes a small object occupy only a few pixels and
  // encourages SAM to choose the background. Frame the robust selection at a
  // useful scale while retaining a conservative margin around it. A noisy
  // initial mask can inflate the robust radius, so never zoom substantially
  // farther out than the accepted source view where the user saw the target.
  const distance = Math.min(
    Math.max(fitDistance, analysis.radius * 2.05),
    sourceDistance * 1.08,
  );
  const views = [];
  const trackingViews = [];
  const sourceQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
  const entryPosition = analysis.centre.clone().addScaledVector(
    analysis.viewDirection,
    distance,
  );
  const entryCamera = new THREE.PerspectiveCamera(
    camera.fov,
    width / height,
    camera.near,
    camera.far,
  );
  entryCamera.position.copy(entryPosition);
  entryCamera.up.copy(analysis.worldUp);
  entryCamera.lookAt(analysis.centre);
  entryCamera.updateMatrixWorld(true);
  const entryQuaternion = entryCamera.getWorldQuaternion(new THREE.Quaternion());
  const zoomChange = Math.abs(Math.log(
    Math.max(sourceDistance, 1e-6) / Math.max(distance, 1e-6),
  ));
  const turnChange = sourceQuaternion.angleTo(entryQuaternion);
  // Bound scale changes to roughly 16% and orientation changes to 5° per
  // frame. A small duplicate/near-duplicate lead-in also gives the video
  // tracker one stable memory frame before the object begins to move.
  const entrySteps = THREE.MathUtils.clamp(
    Math.max(
      2,
      Math.ceil(zoomChange / Math.log(1.2)),
      Math.ceil(turnChange / THREE.MathUtils.degToRad(7)),
    ),
    2,
    10,
  );

  const createView = ({
    branch,
    id,
    label,
    trackOrder,
    yawDegrees,
    elevationDegrees,
  }) => {
    // Preserve the source camera's elevation at yaw 0. Flattening the orbit
    // onto the world-up plane made the first tracked frame jump vertically.
    const direction = analysis.viewDirection.clone().applyAxisAngle(
      analysis.worldUp,
      THREE.MathUtils.degToRad(yawDegrees),
    );
    if (elevationDegrees) {
      const right = new THREE.Vector3().crossVectors(analysis.worldUp, direction).normalize();
      direction.applyAxisAngle(right, THREE.MathUtils.degToRad(elevationDegrees));
    }
    direction.normalize();
    const position = analysis.centre.clone().addScaledVector(direction, distance);

    const orbitCamera = new THREE.PerspectiveCamera(
      camera.fov,
      width / height,
      camera.near,
      camera.far,
    );
    orbitCamera.position.copy(position);
    orbitCamera.up.copy(analysis.worldUp);
    orbitCamera.lookAt(analysis.centre);
    orbitCamera.updateProjectionMatrix();
    orbitCamera.updateMatrixWorld(true);

    return {
      id,
      label,
      source: 'synthetic',
      trackBranch: branch,
      trackOrder,
      yawDegrees,
      elevationDegrees,
      transform: orbitCamera.matrixWorld.elements.slice(),
      width,
      height,
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
      target: analysis.centre.toArray(),
      expectedNovelty: THREE.MathUtils.clamp(
        Math.abs(yawDegrees) / effectiveMaxYaw * 0.82
          + Math.abs(elevationDegrees) / 45 * 0.18,
        0,
        1,
      ),
      // Fusion counts broad angular sectors, not every correlated temporal
      // frame, as independent support.
      evidenceGroup: Math.round((yawDegrees + 180) / 24)
        + (elevationDegrees > 7 ? 16 : elevationDegrees < -7 ? 24 : 0),
    };
  };

  for (const sign of [1, -1]) {
    const branch = sign > 0 ? 'starboard' : 'port';
    let previousYaw = 0;
    let previousElevation = 0;
    let trackingOrder = 0;
    for (let step = 1; step <= entrySteps; step++) {
      const linearProgress = step / entrySteps;
      const progress = linearProgress * linearProgress * (3 - 2 * linearProgress);
      const transitionCamera = new THREE.PerspectiveCamera(
        camera.fov,
        width / height,
        camera.near,
        camera.far,
      );
      transitionCamera.position.copy(sourcePosition).lerp(entryPosition, progress);
      transitionCamera.quaternion.copy(sourceQuaternion).slerp(entryQuaternion, progress);
      transitionCamera.updateProjectionMatrix();
      transitionCamera.updateMatrixWorld(true);
      trackingOrder++;
      trackingViews.push({
        id: `synthetic-${branch}-entry-${step}`,
        label: 'Locking onto object',
        source: 'synthetic',
        trackBranch: branch,
        trackOrder: trackingOrder,
        trackingBridge: true,
        yawDegrees: 0,
        elevationDegrees: 0,
        transform: transitionCamera.matrixWorld.elements.slice(),
        width,
        height,
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        target: analysis.centre.toArray(),
        expectedNovelty: progress * 0.08,
      });
    }
    for (let step = 1; step <= branchLength && views.length < safeCount; step++) {
      const fraction = step / branchLength;
      const yawDegrees = sign * effectiveMaxYaw * fraction;
      let elevationDegrees = 0;
      if (safeCount > 8 && step > Math.ceil(branchLength * 0.62)) {
        elevationDegrees = (step % 2 ? 1 : -1) * 14;
      }
      const segmentSteps = Math.max(
        1,
        Math.ceil(Math.abs(yawDegrees - previousYaw) / maxTrackingStepDegrees),
      );
      for (let substep = 1; substep <= segmentSteps; substep++) {
        const blend = substep / segmentSteps;
        const denseYaw = THREE.MathUtils.lerp(previousYaw, yawDegrees, blend);
        const denseElevation = THREE.MathUtils.lerp(
          previousElevation,
          elevationDegrees,
          blend,
        );
        const isKeyView = substep === segmentSteps;
        trackingOrder++;
        const view = createView({
          branch,
          id: isKeyView
            ? `synthetic-${branch}-${step}`
            : `synthetic-${branch}-${step}-bridge-${substep}`,
          label: isKeyView
            ? `${branch === 'starboard' ? 'Right' : 'Left'} scan ${step}`
            : `${branch === 'starboard' ? 'Right' : 'Left'} tracking bridge`,
          trackOrder: trackingOrder,
          yawDegrees: denseYaw,
          elevationDegrees: denseElevation,
        });
        trackingViews.push(view);
        if (isKeyView) views.push(view);
      }
      previousYaw = yawDegrees;
      previousElevation = elevationDegrees;
    }
  }
  views.trackingViews = trackingViews;
  return views;
}

export function syntheticViewSet(views, analysis) {
  return {
    id: `synthetic:${analysis.selectionCount}:${views.length}`,
    filename: null,
    type: 'synthetic-orbit',
    views,
    trackingViews: views.trackingViews ?? views,
    analysis,
  };
}

function covarianceMatrix(points, centre) {
  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const point of points) {
    const x = point.x - centre.x;
    const y = point.y - centre.y;
    const z = point.z - centre.z;
    matrix[0][0] += x * x;
    matrix[0][1] += x * y;
    matrix[0][2] += x * z;
    matrix[1][0] += y * x;
    matrix[1][1] += y * y;
    matrix[1][2] += y * z;
    matrix[2][0] += z * x;
    matrix[2][1] += z * y;
    matrix[2][2] += z * z;
  }
  const scale = 1 / Math.max(1, points.length);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) matrix[row][column] *= scale;
  }
  return matrix;
}

function powerIteration(matrix, seed) {
  const vector = seed.clone().normalize();
  for (let iteration = 0; iteration < 18; iteration++) {
    vector.set(
      matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
      matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
      matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z,
    );
    if (vector.lengthSq() < 1e-16) return new THREE.Vector3(1, 0, 0);
    vector.normalize();
  }
  return vector;
}

function powerIterationOrthogonal(matrix, primary, seed) {
  const vector = seed.clone().addScaledVector(primary, -seed.dot(primary)).normalize();
  for (let iteration = 0; iteration < 18; iteration++) {
    vector.set(
      matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
      matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
      matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z,
    );
    vector.addScaledVector(primary, -vector.dot(primary));
    if (vector.lengthSq() < 1e-16) {
      return new THREE.Vector3().crossVectors(
        primary,
        Math.abs(primary.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
      ).normalize();
    }
    vector.normalize();
  }
  return vector;
}

function quantile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = THREE.MathUtils.clamp(fraction, 0, 1) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const t = index - low;
  return sorted[low] * (1 - t) + sorted[high] * t;
}

function ascending(a, b) {
  return a - b;
}
