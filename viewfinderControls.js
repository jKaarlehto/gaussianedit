import * as THREE from 'three';

/**
 * First-person mouse-look for exploration mode.
 *
 * This owns pointer-lock and camera orientation only. Product state, selection
 * work, keyboard movement, and UI copy stay behind callbacks so this can be
 * replaced by gamepad, XR, or spaceship controls without touching selection.
 */
export class ViewfinderControls {
  constructor({
    camera,
    orbitControls,
    element,
    getSceneScale = () => 1,
    onViewChanged = () => {},
    onRequestSelection = () => {},
    onLockChange = () => {},
  }) {
    this.camera = camera;
    this.orbitControls = orbitControls;
    this.element = element;
    this.getSceneScale = getSceneScale;
    this.onViewChanged = onViewChanged;
    this.onRequestSelection = onRequestSelection;
    this.onLockChange = onLockChange;
    this.active = false;
    this.locked = false;
    this.speedMultiplier = 1;

    this.direction = new THREE.Vector3();
    this.candidate = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);
    // Capture prevents the click that exits Viewfinder from also becoming a
    // selection click in the canvas handler.
    element.addEventListener('pointerdown', this.handlePointerDown, true);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  setActive(active) {
    this.active = Boolean(active);
    this.orbitControls.enabled = !this.active;
    if (!this.active) this.release();
    this.element.dataset.viewfinder = String(this.active);
  }

  setSpeed(multiplier) {
    this.speedMultiplier = THREE.MathUtils.clamp(Number(multiplier) || 1, 0.05, 8);
  }

  async requestLock() {
    if (!this.active || document.pointerLockElement === this.element) return;
    try {
      await this.element.requestPointerLock();
    } catch (error) {
      console.warn('[viewfinder] pointer lock was not granted', error);
    }
  }

  release() {
    if (document.pointerLockElement === this.element) {
      document.exitPointerLock();
    }
    this.setLocked(false);
  }

  handlePointerDown(event) {
    if (!this.active || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.pointerLockElement === this.element) {
      this.onRequestSelection();
    } else {
      this.requestLock();
    }
  }

  handlePointerLockChange() {
    this.setLocked(document.pointerLockElement === this.element);
  }

  setLocked(locked) {
    const next = Boolean(locked && this.active);
    if (next === this.locked) return;
    this.locked = next;
    this.element.dataset.viewfinderLocked = String(next);
    this.onLockChange(next);
  }

  handleMouseMove(event) {
    if (!this.active || !this.locked) return;
    const dx = event.movementX;
    const dy = event.movementY;
    if (!dx && !dy) return;

    const sceneScale = Math.max(1e-5, this.getSceneScale());
    const targetDistance = Math.max(
      this.orbitControls.target.distanceTo(this.camera.position),
      sceneScale * 0.02,
    );
    this.direction.copy(this.orbitControls.target).sub(this.camera.position).normalize();

    // Horizontal movement rotates around visual up. With a Y-down scene this
    // still maps mouse-right to heading-right.
    this.rotation.setFromAxisAngle(this.camera.up, -dx * 0.0027);
    this.direction.applyQuaternion(this.rotation);

    this.right.crossVectors(this.direction, this.camera.up).normalize();
    this.rotation.setFromAxisAngle(this.right, -dy * 0.0025);
    this.candidate.copy(this.direction).applyQuaternion(this.rotation);
    // Stop short of the pole so pitch can never invert screen-up or heading.
    if (Math.abs(this.candidate.dot(this.camera.up)) < 0.985) {
      this.direction.copy(this.candidate);
    }

    this.orbitControls.target
      .copy(this.camera.position)
      .addScaledVector(this.direction, targetDistance);
    this.camera.lookAt(this.orbitControls.target);
    this.camera.updateMatrixWorld(true);
    this.onViewChanged();
  }

  dispose() {
    this.release();
    this.element.removeEventListener('pointerdown', this.handlePointerDown, true);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }
}
