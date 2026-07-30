import * as THREE from 'three';

const CORNER_FRACTION = 0.18;

/**
 * Screen-space selection cues rendered by the primary Three.js renderer.
 * Geometry is expressed in normalized device coordinates, so it remains
 * aligned with the frozen detector projection at any display pixel ratio.
 */
export class HudEffects {
  constructor(renderer) {
    this.renderer = renderer;
    this._rendererState = createRendererStateSnapshot(renderer);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    this.bracketGeometry = new THREE.BufferGeometry();
    this.bracketMaterial = new THREE.LineBasicMaterial({
      color: 0x70d7ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.brackets = new THREE.LineSegments(this.bracketGeometry, this.bracketMaterial);
    this.brackets.renderOrder = 2000;
    this.scene.add(this.brackets);

    this.scanGeometry = new THREE.BufferGeometry();
    this.scanMaterial = new THREE.LineBasicMaterial({
      color: 0xb8fff4,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.scan = new THREE.LineSegments(this.scanGeometry, this.scanMaterial);
    this.scan.renderOrder = 2001;
    this.scene.add(this.scan);

    this.outlineGeometry = new THREE.BufferGeometry();
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: 0x58d6a8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.outline = new THREE.LineSegments(this.outlineGeometry, this.outlineMaterial);
    this.outline.renderOrder = 2002;
    this.scene.add(this.outline);

    this.suggestion = null;
    this.startedAt = 0;
    this._logicalSize = new THREE.Vector2();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setSuggestion(suggestion, sourceWidth, sourceHeight) {
    if (!suggestion) {
      this.suggestion = null;
      this.bracketMaterial.opacity = 0;
      this.scanMaterial.opacity = 0;
      this.outlineMaterial.opacity = 0;
      return;
    }
    if (this.suggestion?.id !== suggestion.id) this.startedAt = performance.now();
    this.suggestion = suggestion;
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    const color = suggestion.source?.startsWith?.('yolo') ? 0x70d7ff : 0x58d6a8;
    this.bracketMaterial.color.setHex(color);
    this.scanMaterial.color.setHex(color);
    this.outlineMaterial.color.setHex(color);
    this._writeBrackets();
  }

  _writeBrackets() {
    const { box } = this.suggestion;
    const x1 = box.x1 / this.sourceWidth * 2 - 1;
    const x2 = box.x2 / this.sourceWidth * 2 - 1;
    const y1 = 1 - box.y1 / this.sourceHeight * 2;
    const y2 = 1 - box.y2 / this.sourceHeight * 2;
    const lengthX = Math.min((x2 - x1) * CORNER_FRACTION, 0.08);
    const lengthY = Math.min((y1 - y2) * CORNER_FRACTION, 0.11);
    const segments = [
      x1, y1, 0, x1 + lengthX, y1, 0, x1, y1, 0, x1, y1 - lengthY, 0,
      x2, y1, 0, x2 - lengthX, y1, 0, x2, y1, 0, x2, y1 - lengthY, 0,
      x1, y2, 0, x1 + lengthX, y2, 0, x1, y2, 0, x1, y2 + lengthY, 0,
      x2, y2, 0, x2 - lengthX, y2, 0, x2, y2, 0, x2, y2 + lengthY, 0,
    ];
    this.bracketGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(segments, 3),
    );
    const outline = this.suggestion.outline ?? [];
    const outlineVertices = new Float32Array(outline.length / 2 * 3);
    for (let i = 0, write = 0; i < outline.length; i += 2) {
      outlineVertices[write++] = outline[i] / this.sourceWidth * 2 - 1;
      outlineVertices[write++] = 1 - outline[i + 1] / this.sourceHeight * 2;
      outlineVertices[write++] = 0;
    }
    this.outlineGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(outlineVertices, 3),
    );
    this.outlineGeometry.setDrawRange(0, outlineVertices.length / 3);
  }

  render(now = performance.now()) {
    if (!this.suggestion) return;
    // Selection cues are a visible-cockpit overlay, never part of an offscreen
    // model input or synthetic tracking frame.
    if (this.renderer.getRenderTarget() !== null) return;
    const age = now - this.startedAt;
    // Hover must acknowledge the target immediately; the short reveal remains
    // as polish rather than functioning as input latency.
    const reveal = this.reducedMotion ? 1
      : THREE.MathUtils.lerp(0.45, 1, THREE.MathUtils.smoothstep(age / 90, 0, 1));
    this.bracketMaterial.opacity = 0.74 * reveal;
    const outlineCount = this.outlineGeometry.getAttribute('position')?.count ?? 0;
    if (outlineCount) {
      const borderReveal = this.reducedMotion ? 1
        : THREE.MathUtils.lerp(0.28, 1, THREE.MathUtils.smoothstep(age / 220, 0, 1));
      const visibleVertices = Math.floor(outlineCount * borderReveal / 2) * 2;
      this.outlineGeometry.setDrawRange(0, visibleVertices);
      this.outlineMaterial.opacity = 0.64 * reveal;
    } else {
      this.outlineMaterial.opacity = 0;
    }

    if (!this.reducedMotion && age < 520) {
      const { box } = this.suggestion;
      const x1 = box.x1 / this.sourceWidth * 2 - 1;
      const x2 = box.x2 / this.sourceWidth * 2 - 1;
      const top = 1 - box.y1 / this.sourceHeight * 2;
      const bottom = 1 - box.y2 / this.sourceHeight * 2;
      const t = THREE.MathUtils.smoothstep(age / 520, 0, 1);
      const y = THREE.MathUtils.lerp(top, bottom, t);
      this.scanGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([x1, y, 0, x2, y, 0], 3),
      );
      this.scanMaterial.opacity = Math.sin(t * Math.PI) * 0.58;
    } else {
      this.scanMaterial.opacity = 0;
    }

    const rendererState = this._rendererState.capture();
    try {
      this.renderer.getSize(this._logicalSize);
      this.renderer.autoClear = false;
      // Default-target viewport APIs intentionally receive logical/CSS sizes;
      // WebGLRenderer applies its pixel ratio exactly once.
      this.renderer.setViewport(0, 0, this._logicalSize.x, this._logicalSize.y);
      this.renderer.setScissor(0, 0, this._logicalSize.x, this._logicalSize.y);
      this.renderer.setScissorTest(false);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
    } finally {
      rendererState.restore();
    }
  }

  dispose() {
    this.bracketGeometry.dispose();
    this.bracketMaterial.dispose();
    this.scanGeometry.dispose();
    this.scanMaterial.dispose();
    this.outlineGeometry.dispose();
    this.outlineMaterial.dispose();
  }
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
