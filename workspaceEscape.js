export const ESCAPE_ACTIONS = Object.freeze({
  CLOSE_LAYER: 'close-layer',
  CANCEL_TRANSIENT: 'cancel-transient',
  RETURN_WORKSPACE: 'return-workspace',
  FREEZE_SCENE: 'freeze-scene',
  NONE: 'none',
});

export function resolveEscapeAction({
  hasBlockingLayer = false,
  hasTransient = false,
  workspace = 'scene',
  sceneExploring = false,
} = {}) {
  if (hasBlockingLayer) return ESCAPE_ACTIONS.CLOSE_LAYER;
  if (hasTransient) return ESCAPE_ACTIONS.CANCEL_TRANSIENT;
  if (workspace === 'mask' || workspace === 'object') {
    return ESCAPE_ACTIONS.RETURN_WORKSPACE;
  }
  if (workspace === 'scene' && sceneExploring) return ESCAPE_ACTIONS.FREEZE_SCENE;
  return ESCAPE_ACTIONS.NONE;
}
