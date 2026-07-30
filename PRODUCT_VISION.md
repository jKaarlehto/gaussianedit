# GaussianEdit product vision

## North star

GaussianEdit should feel like piloting a small spacecraft with advanced alien
scanning equipment, not operating a computer-vision research console.

The interface may use bleeding-edge segmentation, detection, tracking, and
multiview fusion internally. The primary experience must explain those systems
through readable actions, immediate visual cause-and-effect, and a playful
physical metaphor.

## Core interaction story

1. **Fly** — the user pilots around a Gaussian scene from a small ship.
2. **Enter the cockpit** — when movement settles, the view eases into a stable
   scanning posture. Selection becomes available only when the view is ready.
3. **Discover targets** — a restrained combat-style HUD marks objects found by
   YOLO or another detector. Hints remain suggestions, not unexplained decisions.
4. **Scan** — pointing at or clicking a target sends an alien-style scan ray
   through it. SAM, classic region methods, depth, and other providers combine
   behind this one understandable action.
5. **Inspect evidence** — the visible result opens as a 2D mask, then the user
   promotes its actual Gaussians into the 3D Object workspace. Confident,
   uncertain, newly discovered, locked, and removed regions have distinct but
   tasteful visual behavior. Every adjustment shows its exact difference.
6. **Scan all sides** — `Use this object` confirms the current visible 3D
   selection and starts tracked hidden-side work while the 3D Object workspace
   remains active.
7. **Extract** — `Dock object` triggers a short shrink/tractor-beam sequence.
   The selected Gaussians leave the world instead of remaining highlighted in
   place.
8. **Store as cargo** — the object settles into the ship's bottom dock as a live
   miniature. The dock owns the extracted splats.
9. **Inspect or return** — selecting cargo opens its hologram and shows a subtle
   origin ghost. Dragging it back to that ghost restores the exact object.

## UX rules

- Use plain actions first: scan, include, remove, protect, extract, return.
  Put model and algorithm names in secondary details and tooltips.
- Never leave the user wondering whether work is happening, whether input is
  accepted, or why an action is unavailable.
- Never show a control without showing what its last change added, removed, or
  reclassified.
- Preserve continuity: camera movement must not silently discard objects,
  selections, suggestions, or completed work.
- Suggestions must look provisional. User-confirmed state must look stable.
- Motion should communicate state change, then settle. Avoid permanent visual
  noise and decorative animation that competes with the scene.
- Use one coherent visual language across 2D masks, 3D splats, holograms, the
  object dock, and multiview refinement.
- Advanced controls should unfold only when requested. A normal interaction is
  still: point at an object, check its 2D mask and 3D form, use it, then dock it.
- Failure states should offer a comprehensible alternative, such as manual edge
  editing or color fill, rather than exposing a model error as the main UX.

## Technical mapping

| User-facing action | Possible implementation |
| --- | --- |
| Target discovery | YOLO, open-vocabulary detector, classic region proposals |
| Scan | Promptable SAM mask plus provider fusion |
| Scan depth | Visible-splat lifting and spatial/color growth |
| Verify hidden surfaces | SAM tracking across calibrated or synthetic views |
| Evidence display | Per-Gaussian confidence and provider agreement |
| Protect part | Persistent Gaussian lock labels |
| Extract/store | Per-splat source visibility mask plus persistent dock snapshot |
| Return cargo | Restore exact Gaussian IDs and original transform |

This metaphor is a product constraint, not a requirement to make every control
look like a game. The effects should remain concise, professional, and useful.
