export const WORKSPACE_ORDER = Object.freeze(['scene', 'mask', 'object']);
export const WORKSPACE_DEFINITIONS = Object.freeze({
  scene: Object.freeze({ id: 'scene', label: 'Scene', drawer: 'camera' }),
  mask: Object.freeze({ id: 'mask', label: '2D mask', drawer: 'mask' }),
  object: Object.freeze({ id: 'object', label: '3D object', drawer: 'object' }),
});

export function workspaceAvailability({
  scene = false,
  mask = false,
  object = false,
} = {}) {
  return Object.freeze({
    scene: Boolean(scene),
    mask: Boolean(mask),
    object: Boolean(object),
  });
}

export function resolveWorkspace(current, requested, available) {
  if (!WORKSPACE_ORDER.includes(requested)) return current;
  return requested;
}

export function cycleWorkspace(current, available, reverse = false) {
  const index = Math.max(0, WORKSPACE_ORDER.indexOf(current));
  const direction = reverse ? -1 : 1;
  return WORKSPACE_ORDER[
    (index + direction + WORKSPACE_ORDER.length) % WORKSPACE_ORDER.length
  ];
}

export function workspaceInputOwner(workspace, { flying = false } = {}) {
  if (workspace === 'scene') return flying ? 'scene-flight' : 'scene-selection';
  if (workspace === 'mask') return 'mask-editor';
  if (workspace === 'object') return 'object-orbit';
  return 'none';
}

export function allowsInput(owner, input) {
  return {
    'scene-flight': new Set(['pointer-lock', 'flight-keys']),
    'scene-selection': new Set(['target-click', 'orbit-drag', 'orbit-wheel']),
    'mask-editor': new Set(['mask-pointer']),
    'object-orbit': new Set(['object-drag', 'object-wheel']),
  }[owner]?.has(input) ?? false;
}

export class WorkspaceController {
  #active;
  #history;

  constructor(active = 'scene') {
    if (!WORKSPACE_ORDER.includes(active)) throw new TypeError(`Unknown workspace: ${active}`);
    this.#active = active;
    this.#history = [];
  }

  get active() {
    return this.#active;
  }

  get previous() {
    return this.#history.at(-1) ?? null;
  }

  derive(context = {}) {
    const available = workspaceAvailability({
      scene: context.sceneLoaded,
      mask: context.frameReady,
      object: context.selectionCount > 0,
    });
    const postcardIds = this.#active === 'scene'
      ? ['mask', 'object']
      : this.#active === 'object'
        ? ['scene', 'mask']
        : ['object', 'scene'];
    const inputOwner = this.#active === 'scene'
      ? context.sceneFlying ? 'scene-flight' : 'scene-selection'
      : this.#active === 'mask'
        ? 'mask-editor'
        : 'object-orbit';
    const status = {
      scene: context.sceneLoaded
        ? context.sceneFlying ? 'LIVE' : 'FROZEN'
        : 'LOADING',
      mask: context.frameReady
        ? context.maskReady ? 'MASK READY' : 'LIVE'
        : 'LOADING',
      object: context.selectionCount > 0
        ? 'LIVE'
        : 'EMPTY',
    };
    return Object.freeze({
      active: this.#active,
      mainWorkspace: this.#active,
      postcardIds: Object.freeze(postcardIds),
      inputOwner,
      drawerOwner: WORKSPACE_DEFINITIONS[this.#active].drawer,
      primaryNext: postcardIds[0],
      available,
      status: Object.freeze(status),
    });
  }

  activate(requested, context = {}) {
    const derived = this.derive(context);
    const next = resolveWorkspace(this.#active, requested, derived.available);
    const previous = this.#active;
    if (next !== previous) {
      this.#history.push(previous);
      if (this.#history.length > 12) this.#history.shift();
    }
    this.#active = next;
    return Object.freeze({
      previous,
      active: next,
      changed: previous !== next,
      ...this.derive(context),
    });
  }

  activateScene() {
    const previous = this.#active;
    if (previous !== 'scene') {
      this.#history.push(previous);
      if (this.#history.length > 12) this.#history.shift();
    }
    this.#active = 'scene';
    return Object.freeze({ previous, active: 'scene', changed: previous !== 'scene' });
  }

  cycle(context = {}, reverse = false) {
    const derived = this.derive(context);
    const previous = this.#active;
    this.#active = this.next(context, reverse);
    if (this.#active !== previous) {
      this.#history.push(previous);
      if (this.#history.length > 12) this.#history.shift();
    }
    return Object.freeze({
      previous,
      active: this.#active,
      changed: previous !== this.#active,
      ...this.derive(context),
    });
  }

  next(context = {}, reverse = false) {
    return cycleWorkspace(this.#active, this.derive(context).available, reverse);
  }

  returnPrevious(context = {}) {
    const previous = this.#active;
    let next = this.#history.pop() ?? 'scene';
    while (next === previous && this.#history.length) next = this.#history.pop();
    this.#active = next;
    return Object.freeze({
      previous,
      active: next,
      changed: previous !== next,
      ...this.derive(context),
    });
  }
}
