# GaussianEdit implementation tasks

This is the durable checklist for the current object-selection work. A task is
complete only when its behavior is implemented and verified in the live app.
The interaction north star and plain-language rules live in
[`PRODUCT_VISION.md`](PRODUCT_VISION.md).

## 0. Active priority — responsive synthetic-view pipeline

Do these in order. New UX requests are queued below and do not replace this
work until the scan path is measured and responsive.

- [ ] Fix the current-view coordinate contract before any model call: a click
  on the cockpit canvas must land on the identical pixel in the captured 2D
  image, cropped editor, detector guidance, SAM prompt, and Gaussian lift.
- [ ] Freeze one immutable selection-frame record containing camera matrices,
  framebuffer size, CSS-to-frame scale, crop transform, color transform, and
  scene revision. YOLO, SAM, 2D editing, lift, main highlight, and hologram
  must consume that same record or reject their result as stale.
- [ ] Make offscreen capture visually identical to the cockpit image: same
  camera pose, framing, output color space, tone mapping, and orientation.
- [ ] Bound and time each part of “finishing the visible side”; a front-surface
  mask must not launch an unbounded full-scene growth/refinement pass.
- [ ] Never apply a synthetic-view visibility mask to the live cockpit
  renderer. Occluder-removal passes may mutate only an isolated scan renderer
  and must restore it before yielding.
- [x] Fail closed before loading any scene or model unless WebGL reports a
  supported discrete NVIDIA/AMD adapter. Never silently run the app on an
  integrated or software renderer.
- [x] Build one resident offscreen native-Gaussian cutout around the selected
  object and reuse it for the entire ordered orbit.
- [ ] Prove the normal scan path never sorts or re-prepares the full 8.8M-splat
  cockpit scene for a synthetic camera.
- [x] Measure cutout construction, per-view sorting, GPU readback, image copy,
  and JPEG encoding separately; expose the last scan timings for diagnostics.
- [ ] Render the complete ordered view sequence first, but present exactly one
  active FIFO evidence transaction at a time. Never show a gallery row or empty
  placeholder thumbnails.
- [ ] Submit that fixed sequence once to the GPU SAM 3 service; keep the main
  renderer and controls free while inference runs and provide one Cancel action.
- [ ] For the active FIFO item, show the real RGB view first, then the real
  tracked mask beside it. Slide them together, overlap them, and flash the
  accepted masked area exactly twice before any transfer begins.
- [ ] Animate only the accepted mask evidence as particles flying from the
  overlapped thumbnail into the 3D hologram. Remove the pair after transfer and
  fusion complete, then advance the next queued view.
- [ ] Ensure cancel/restart releases cutout buffers, staged image blobs, backend
  sessions, and stale masks immediately.

### Crash safety and resource budgets

- [x] Store synthetic-view projections only for the scan ROI. Never allocate
  another screen/depth/radius array for every Gaussian in the full scene.
- [x] Reuse one global-to-local ROI lookup for projection and evidence fusion
  rather than allocating one lookup per view or subsystem.
- [x] Release bridge-view JPEG/blob references immediately after the backend
  accepts them; retain only the small review thumbnails and key-view frames.
- [ ] Put explicit byte budgets on the scan cutout, staged frames, projection
  data, and evidence buffers. Reduce view resolution/count or fail safely
  before an allocation can destabilize the machine.
- [x] Store undo/refinement history sparsely by selected Gaussian id instead of
  retaining full-scene confidence and lock arrays for every history entry.
- [x] Prevent overlapping detector encoding, browser segmentation encoding,
  synthetic rendering, uploads, and tracking sessions.
- [x] Make Cancel free the cutout, projection lookup, staged frames, provider
  session, and temporary canvases immediately.
- [ ] Record estimated and actual host/GPU scan memory in diagnostics.
- [ ] Verify stable RAM/VRAM and interaction on the 8.8M-Gaussian Nelson scene.

### Lightweight component boundaries

- [x] Keep selection sources, segmentation models, detection models, temporal
  mask propagation, and the Gaussian renderer behind replaceable interfaces.
- [x] Keep projection, mask lifting, 3D growth, and evidence fusion callable
  independently; cover compact projection/fusion with a browser-free test.
- [ ] Extract the all-sides scan coordinator from `main.js`. Inject only
  `renderView`, `trackMask`, `liftMask`, `fuseEvidence`, cancellation, and a
  small progress-event sink—no dependency-injection framework.
- [ ] Drive the scan UI from coordinator events rather than letting the core
  pipeline write DOM state directly.
- [ ] Add one small fake-provider test for ordered rendering/tracking/fusion,
  cancellation, mask-edit restart, and guaranteed resource cleanup.

### Queued immediately after the renderer

- [ ] Add one stable top-level stage rail that never changes vocabulary:
  `Select visible side` → `Scan all sides` → `Fix if needed` → `Dock object`.
- [ ] Under `Scan all sides`, show independently monotonic real-unit progress:
  `Rendering n/m`, `Tracking n/m`, and `Adding to 3D n/m`. Do not collapse
  these into a vague percentage or switch the main stage label per subtask.
- [ ] Delete the generic `Review` stage and status everywhere. When the system
  is checking identity or consistency, say `Checking object match` and proceed
  automatically. When a genuinely ambiguous result requires the person, pause
  under `Fix if needed`, label it `Your decision`, explain the uncertainty in
  one sentence, and show concrete Keep/Skip/Edit actions.
- [ ] Keep actor ownership explicit in every status: app actions use active
  verbs (`Rendering`, `Tracking`, `Adding to 3D`); user gates say `Your
  decision`; technical failures say what failed and whether the app skipped or
  stopped. Never use `review`, `processing`, or `working` without an actor.
- [ ] Remove the stale “Selection click queued” work item. Retain only the most
  recent click briefly while its exact settled projection finishes encoding,
  with plain user-facing status.
- [ ] Report progress by real units: visible side mapped, views rendered out of
  total, masks tracked out of total, and views fused out of total.
- [ ] Delete obsolete/legacy selection controls and their code paths instead of
  keeping hidden compatibility UI. Keep one automatic Fast intent mask followed
  by automatic SAM 3 tracking, plus the explicitly chosen classic/manual tools.
- [ ] Let the user choose the starting method before clicking and make hover
  feedback match that method. Keep targeting controls in the left scene panel.
- [ ] When editing, grow the editable 2D mask into the main workspace. Replace
  the former mask-postcard slot below the left scene menu with a live orbitable
  3D camera postcard, without overlapping the menu or the main editor.
- [ ] Keep the small contextual selection hologram below the right-hand object
  workflow so it remains close to refinement and docking actions.

## 1. One-renderer HUD architecture

- [x] Render the isolated selection with the primary Three.js renderer.
- [x] Keep HTML/CSS limited to accessible labels, controls, and hit targets.
- [x] Remove the second WebGL context.
- [ ] Verify resizing, inspector-open positioning, and reduced-motion behavior.

## 2. Floating selection hologram

- [x] Use robust bounds so provisional floaters do not make the object tiny.
- [x] Replace the framed mini-viewport look with a projector ring, beam particles,
  and a short scan wave.
- [x] Align the preview to the camera view that produced the mask.
- [x] Rock a single-view estimate instead of implying verified 360-degree coverage.
- [ ] Hover pauses the hologram at its current orientation and hands orbit
  control to the user. It must not reset the spin, camera, or fitted framing;
  leaving hover resumes from the same orientation.
- [ ] Render selected Gaussians with their actual anisotropic scale/rotation, or
  another representation that preserves the splat silhouette better than points.
- [ ] Switch to full continuous rotation only after multiview coverage exists.

## 3. Shared HUD visual language

- [x] Cyan scanned brackets for hover proposals.
- [x] Orange for confident selected Gaussians.
- [x] Amber restrained ripple for uncertain Gaussians.
- [x] Blue coherence wave for newly included Gaussians.
- [x] Stable green for locked Gaussians.
- [x] Short gray lift-away for removed/rejected Gaussians.
- [ ] Tune timings and intensity in direct Chrome screenshots.

## 4. Object-aware hover suggestions

- [x] Add a pluggable detector-model interface.
- [x] Run YOLOv10n lazily once per settled projection.
- [x] Run a content-cropped pass and overlapping high-resolution detail passes
  when the first pass is sparse.
- [x] Consolidate repeated tiled detections into one physical-object proposal,
  including similarly sized conflicting labels such as car/truck/boat.
- [x] Cache proposals for the current view and discard stale results after movement.
- [x] Start detector analysis as soon as the view freezes; hover only queries
  cached YOLO boxes or the bounded classic-region cache.
- [x] Remove the artificial hover delay and show a partial HUD outline on its
  first rendered frame.
- [x] Use YOLO boxes, an interior point, and outside exclusion points as SAM
  prompts when a detector target is clicked.
- [x] Rank SAM hypotheses by overlap with the clicked detector region and guard
  against accepting a mask that jumps to an unrelated connected object.
- [x] Add an edge-aware color-region fallback when YOLO has no relevant class.
- [x] Fuse the classic region with SAM instead of presenting it as a YOLO result.
- [x] Draw restrained leader sticks with label opacity derived from detector score.
- [ ] Add a cached backend YOLO12-S/M refinement provider for stronger
  high-resolution known-class boxes without blocking the browser HUD.
- [ ] Use refined boxes plus shared visible Gaussian IDs as a secondary SAM3
  identity-drift guard and re-anchor cue.
- [ ] Add category-free SAM automatic-mask/objectness proposals for arbitrary content.
- [ ] Add an open-vocabulary provider (YOLO-World/YOLOE, OWLv2, or Grounding DINO)
  as a separate optional discovery path; never present a fixed-vocabulary YOLO as general objectness.
- [ ] Calibrate provider scores on held-out splat renders before describing them
  as probabilities; until then expose them as model match/ranking strength.
- [ ] Verify the true YOLO branch on a photographed Gaussian scene.

## 5. Guided control pipeline and visible diffs

- [x] Rename technical sections toward user-visible outcomes.
- [x] Define the diff language: blue added/refined, gray removed, orange became confident,
  amber became uncertain, and “visual only” for appearance changes.
- [x] Capture a baseline at the start of each slider drag.
- [x] Compare the current result against that stable baseline.
- [x] Show a compact last-control diff HUD with exact added and removed counts.
- [x] Overlay added/removed 2D mask pixels in the projection PIP.
- [x] Make the HUD's actual membership explicit: every displayed splat is
  included; evidence colors explain quality and never block docking.
- [x] Keep strong, low-evidence, protected, and newly-added states semantically
  distinct and hide legend entries that are not currently present.
- [x] Reclassify the strong/low-evidence colors synchronously without rerunning
  3D growth, while preserving explicit multiview review holds.
- [x] Show the same blue-add/gray-remove 3D delta in the main scene and isolated
  hologram, with additions falling into place and removals lifting away.
- [x] Clear the diff after a short readable hold without losing the selection.
- [ ] Keep the normal path to four plain stages: Fast + YOLO, optional 2D mask
  correction, automatic SAM 3 fill, optional 3D splat cleanup, then dock.
- [ ] Start SAM 3 tracking automatically from every accepted Fast mask and
  cancel/restart it when the user commits a new 2D mask edit.
- [x] Make the enlarged 2D projection the only manual mask-editing surface,
  with add/erase brushes, SAM keep/exclude points, and point-to-point outlines.
- [x] Keep Brush add/erase and Keep/Exclude visible above the enlarged image,
  constrain the editor to the viewport, and never strand its controls below screen.
- [x] Add an explicit Back to scene action that minimizes the 2D editor without
  discarding its mask edits.
- [x] Rename misleading `visible points` to `3D seed points`; explain that these
  are sampled front-surface lift seeds while the hologram count is the full result.
- [x] Hide projected Gaussian origins from the normal 2D editor and expose them
  only through an explicitly labelled diagnostic toggle.
- [x] Render the mask and its added/removed diff as continuous pixels in 2D;
  never use sparse Gaussian origins as the apparent brush result.
- [x] Use conservative projected footprint overlap for immediate 2D-to-3D
  lifting so a large splat can be reached even when its origin misses the
  painted pixels.
- [ ] Make 2D-to-3D lifting footprint-aware with renderer contributor IDs and
  weights so large anisotropic splats can be selected when painted pixels touch
  their footprint even if the Gaussian center lies outside the mask.
- [ ] Make main-scene highlights, hologram layers, diffs, and 3D cleanup
  hit-testing use visible splat footprints rather than center-point stand-ins.
- [x] Make the 3D hologram the only manual Gaussian-cleanup surface.
- [x] Keep technical evidence and growth controls collapsed outside the normal path.
- [x] Correct inspector close so it closes the panel without docking the object.

## 6. Finalized segment dock

- [x] Define a persistent cargo snapshot:
  Gaussian IDs, confidence, locks, source prompts, original anchor, and display name.
- [x] Rename the primary confirmation action to the direct “Dock this object”.
- [x] Materialize the confirmed object into a camera-attached 3D cargo miniature.
- [x] Hide the extracted Gaussian IDs from the source scene while the dock owns them.
- [x] Render dock miniatures as ray-pickable Three.js geometry in the main scene.
- [x] Support multiple finalized segments as independent cargo entries.
- [x] Clicking a miniature reopens its hologram and highlights its origin ghost.
- [x] Exclude cockpit cargo geometry from detector and segmentation captures.
- [ ] Add the full world-to-cockpit shrink/tractor transition.
- [ ] Provide rename, visibility, lock, duplicate, and delete actions without clutter.

## 7. Drag from dock to origin

- [ ] Start a Three.js drag hologram from a dock miniature.
- [ ] Make the origin ghost brighten as the valid landing target.
- [ ] Snap to the exact original Gaussian IDs and transform on release over the ghost.
- [ ] Cancel safely when released elsewhere; never create an accidental duplicate.
- [ ] Add arbitrary repositioning only after exact-origin restore is reliable.

## 8. Whole-object and multiview refinement

- [x] Label the current browser feature accurately as per-view 3D-guided mask propagation.
- [x] Stop implying that the current per-view SAM 3 checkpoint use is temporal tracking.
- [x] Allow a bounded app-generated synthetic scan after selection; the user is
  never expected to supply custom views for an interactive selection.

### 8.1 Selection volume and orbit planning

- [x] Compute robust selected-object center, scale, principal axes, and visible-side coverage.
- [ ] Reject unsafe orbit poses inside scene geometry or outside useful distance/FOV limits.
- [x] Generate a bounded horizontal orbit first, then add elevated/depressed rings when useful.
- [x] Keep sparse two/four-angle scans closer to the seed view; widen the orbit only when
  intermediate frames give the tracker a continuous appearance change.
- [x] Bridge the accepted cockpit camera into the object-framed orbit with smooth
  dolly and orientation steps; a small yaw delta alone is not a continuous video.
- [ ] Score candidate views for expected new coverage, baseline, occlusion, and redundancy.
- [ ] Prefer calibrated source cameras when available; synthesize only the missing coverage.
- [ ] Expose view count/coverage as a simple Fast, Balanced, Thorough choice before advanced settings.

### 8.2 Synthetic view rendering

- [x] Render novel views offscreen without moving or flashing the user's cockpit camera.
- [ ] Render RGB plus depth, Gaussian contributor IDs/weights, and a visibility buffer.
- [x] Keep extracted cargo, HUD geometry, highlights, and transient effects out of model input.
- [ ] Cancel the current view immediately when the selection, scene, or requested orbit changes.
- [ ] Cache renders by scene revision, object IDs, camera pose, and render dimensions.
- [ ] Bound GPU/CPU buffers and release rejected or superseded views promptly.

### 8.3 Mask propagation provider

- [x] Define a pluggable `MaskPropagationProvider` interface separate from click segmentation.
- [x] Add the browser client contract for an official SAM 3/SAM 2 stateful video-predictor service.
- [x] Finish checkpoint loading and verify the local Python service against the official
  SAM 3.1 Object Multiplex predictor on the live synthetic orbit.
- [x] Remove the redundant first 3.5 GB checkpoint load, retain the
  checkpoint-required 16-lane tensor shape, and expose only one active object.
- [x] Keep CUDA bfloat16 autocast in the inference worker thread and verify a
  tracked frame succeeds on the RTX 5090.
- [x] Download the official SAM 3.1 Object Multiplex checkpoint into the isolated,
  git-ignored local runtime and expose truthful loading/ready capability state.
- [x] Stage each tracking branch as a complete ordered frame sequence, as required by
  the official predictor, instead of pretending frames can be appended to a live video.
- [x] Add the isolated local service runtime, Vite proxy, automatic development launcher,
  capability probe, session cleanup, and truthful fallback.
- [x] Keep the browser-only projected-prompt provider as an explicitly named fallback.
- [ ] Verify two tracking sessions at the accepted seed view: one left and one right.
- [x] Seed each tracking branch from the accepted current-view mask.
- [x] Use actual SAM 3 temporal tracking when the installed/runtime provider supports it.
- [x] Seed SAM 3 from a loose Fast-mask visual-prompt box so it can generate
  its own frame-zero mask; validate that result against the visible intent and
  fall back to one deepest-interior SAM2 point when it is empty or latches onto
  a much larger/different region.
- [x] Keep validation anchored to the selection that started the scan so
  provisional discoveries cannot drag the tracked identity to a new object.
- [x] Allow temporal continuity to carry an object through angles where the
  original front-side seed is occluded; keep that evidence provisional instead
  of declaring the object absent before asking the tracker.
- [ ] Verify that the object mask remains coherent through both smooth orbit
  branches on the pinned Nelson Ghost Town water-tower scene.
- [x] Re-anchor a drifting tracker with projected positive points and background
  guard points when its mask loses the original Gaussian support.
- [ ] Add a masked DINOv2/SigLIP identity embedding memory containing the
  original seed plus diverse accepted key views; never validate only against
  the immediately previous frame, which permits gradual drift.
- [ ] Combine projected original-Gaussian overlap, embedding similarity,
  temporal area/centroid continuity, and explicit corrections as the identity
  gate; treat YOLO class agreement as optional weak metadata only.
- [x] Lock the normal all-sides workflow when temporal tracking is unavailable;
  retain per-view prompt segmentation only for explicitly labelled diagnostic
  altered-visibility proposals.
- [x] Preserve provider name, per-view quality, stability, and failure reason as evidence metadata.
- [x] Detect lost tracking, empty masks, full-frame masks, sudden area jumps, and identity switches.

### 8.3a Progressive occluder reveal

- [x] First process every angle with the original scene intact.
- [ ] Estimate foreground occluders from the exact view projection and 3D object bounds.
- [ ] Offer a later diagnostic pass that hides only confidently unrelated foreground Gaussians.
- [ ] Run any occluder-reveal attempt only as a separate later pass after all
  intact views, never inline with the normal scan.
- [ ] Mark every altered render visibly as `occluders hidden` in review and evidence metadata.
- [ ] Let altered views propose newly visible candidates, but never confirm membership by themselves.
- [ ] Require intact synthetic/captured support or manual acceptance before promoting those candidates.
- [ ] Never hide uncertain boundary Gaussians, locked object parts, or possible thin structures.

### 8.4 Visibility-aware Gaussian evidence

- [x] Reproject each accepted 2D mask through its exact synthetic/calibrated camera.
- [ ] Introduce immutable, provenance-rich evidence events with explicit
  membership, boundary, hard-constraint, affinity, and quality semantics.
- [ ] Cap correlated observations by family so YOLO→SAM and adjacent tracked
  bridge frames cannot multiply into false certainty.
- [ ] Accumulate positive, negative, occluded, and unknown evidence per contributing Gaussian.
- [ ] Add an authoritative backend lift weighted by exact `alpha × transmittance`
  pixel contribution; retain the current centre/tile lift as the instant preview.
- [ ] Weight observations by contribution, calibrated mask evidence, boundary
  distance, view quality, and viewing angle.
- [ ] Prevent background visible through holes from receiving foreground support.
- [ ] Treat shared-boundary, low-opacity, and transparent Gaussians as uncertain rather than binary.
- [x] Require independent angular support before promoting a newly discovered back-side Gaussian.
- [x] Retain one-view additions as explicitly forced provisional, even when their local
  mask score is high; only enough independent views can clear that state.
- [ ] Fuse weighted support/conflict/unknown evidence across views.
- [ ] Build a local Gaussian graph from covariance-normalized distance, DC color,
  stable orientation, and repeated multiview boundary evidence.
- [ ] Apply seed connectivity first, then a GaussianCut-style graph cut only to
  changed supernodes or a narrow disputed boundary ROI.
- [ ] Keep opacity, sparse density, huge scale, and detached components as
  cleanup flags; never silently reinterpret them as semantic non-membership.
- [ ] Stream revisioned added/removed/disputed Gaussian IDs and discard stale
  refinement results after camera, prompt, or mask edits.

### 8.5 Progressive review and control

- [x] Add discovered Gaussians incrementally with the blue materialization wave.
- [x] Drive the main-scene and hologram ripple from actual accepted evidence arrival.
- [x] Stream newly supported splats in small center-out spatial batches before advancing views.
- [x] Keep one-view evidence amber/provisional after its short cyan arrival wave.
- [ ] Let rejected evidence dissolve without ever appearing as a finalized object part.
- [ ] Show `view n of m`, newly found count, verified coverage, and ambiguous-view count.
- [ ] Update compute/review/total estimates from measured render, inference, and review times.
- [ ] Let users inspect intermediate object geometry without blocking the next view.
- [ ] Let users accept, reject, repaint, skip, pause, cancel, undo, and resume each proposal.
- [ ] Preserve locked Gaussians and explicit exclusions throughout later views.
- [x] Retry a technical tracker-frame failure once, then skip it automatically;
  never ask the user to accept/reject a server error as if it were a valid mask.
- [x] Auto-apply clean tracked masks without mounting a review card; reserve
  the stable review panel for genuinely ambiguous evidence.
- [ ] Distinguish single-view growth, tracked evidence, calibrated evidence, and manual evidence.

### 8.7 Fast Auto object quality and visible tuning

- [ ] Make the first click choose a useful object without requiring technical adjustments in the normal case.
- [x] Reject empty, near-full-frame, identity-lost, and background-spill Fast masks automatically.
- [ ] Retry a rejected Fast mask with stronger prompts or the accurate per-view model when available.
- [ ] Expose plain-language Fast choices such as tighter/broader object and nearby-color tolerance.
- [x] Keep the existing selection and all edit controls live while an optional
  detailed 2D provider downloads/encodes; switching back cancels the pending swap.
- [x] Stop assigning fake confidence to deterministic Color fill and Radius;
  Auto-led fusion keeps the learned mask authoritative, with explicit Add all
  and Overlap only alternatives.
- [x] Snapshot the result at slider drag start and keep that baseline stable until release.
- [x] Show added regions in blue and removed regions in gray over both the 2D mask and 3D scene.
- [x] Explain the last changed control in one sentence with exact added/removed Gaussian counts.
- [ ] Fade the diff after release while keeping an explicit compare/revert action.

### 8.6 Edge cases and validation

- [ ] Handle severe occlusion, thin parts, transparency, and nearly edge-on views.
- [ ] Handle similar adjacent objects and tracking identity switches.
- [ ] Handle disconnected parts that belong to one object without absorbing nearby clutter.
- [ ] Handle floaters, reconstruction artifacts, and views where the object is absent.
- [ ] Compare the final label from several held-out views and surface unresolved disagreement.
- [ ] Verify on both clean object-centric splats and real 500k+ multiview reconstructions.

### 8.8 Research-derived selection-ready scenes

- [ ] Keep arbitrary RGB-only PLYs working through the zero-setup SAM + 3D evidence path.
- [ ] Define an optional versioned sidecar for per-Gaussian identity, affinity, semantic, and provenance features.
- [ ] Add a Gaussian Grouping-style preprocessing provider: ordered SAM masks, temporal ID association,
  compact identity encoding, and 3D spatial consistency.
- [ ] Add a SAGA-style scale-affinity provider so `part`, `object`, and `whole` are physical-scale
  queries rather than vague labels.
- [ ] Add a CoSeg/CoSSeg-style provider that unprojects DINO features with transmittance weights
  and fuses them with multi-scale spatial neighbors.
- [ ] Add an FMGS-style language/visual proposal provider for requests such as `select the chair`;
  keep precise instance boundary confirmation in the mask/affinity pipeline.
- [ ] Store source-camera and contribution metadata when available so captured views outrank
  synthetic evidence.
- [ ] Mark Gaussians that repeatedly straddle 2D boundaries as shared/uncertain instead of
  forcing a false binary answer.
- [ ] Design a reconstruction-aware export/refinement path that may split boundary Gaussians;
  do not pretend a static arbitrary PLY can gain exact new boundaries without changing geometry.
- [ ] Cache derived sidecars by source scene hash and preprocessing provider/version.

### 8.9 Fast handoff and recursive isolated refinement

- [x] Treat Fast/Detailed/Color/Radius as current-view seed generators only;
  the all-sides action hands the accepted mask to SAM 3.1 temporal tracking.
- [x] Explain in the scan gate that the app generates the synthetic views and
  that SAM 3.1 tracking is independent of which starting method made the seed.
- [x] Add a first-level `Refine inside` action from the hologram that isolates
  the current object in the real Three.js scene and runs the same selection flow
  against only that parent geometry.
- [x] Support recursive isolation with a persistent `Scene › isolated object ›
  refinement n` path and an exact `Back one level` escape.
- [x] On docking a recursively refined subset, return the unselected parent
  remainder to the source scene and hide only the docked Gaussian IDs.
- [ ] Preserve and show per-level prompt/method history in a compact breadcrumb
  popover without exposing implementation details.
- [ ] Add an explicit compare-parent gesture before docking a deeply nested result.
- [ ] Verify recursive refinement through at least three levels on a real
  multiview reconstruction and ensure every camera/cache transition cancels safely.
- [x] Add a main-camera `Orbit selected` mode that follows the current object centre.
- [x] Add one adaptive `Nearby scene` layer that hides splats farther than one
  object radius beyond the current selection edge, without exposing another radius knob.

## 9. Responsiveness and caching

- [x] Request the high-performance WebGL adapter before context creation and
  show the adapter the browser actually assigned in the top-left HUD.
- [x] Configure Windows high-performance preferences for the current Codex app,
  Microsoft Edge, and the installed Edge WebView2 runtime; clearly distinguish
  this host policy from the site's non-binding WebGL/WebGPU preference hint.
- [x] Debounce camera encoding and discard stale results after camera movement.
- [x] Decouple the frozen camera projection from model readiness so edge/color/
  radius selection works while Auto object prepares in the background.
- [x] Reuse the frozen projection for detector analysis and SAM view features
  instead of recapturing when either model becomes ready.
- [x] Serialize always-on SAM view encoding and YOLO inference on the browser
  GPU, with classic cached hover regions available while YOLO waits.
- [x] Use a smaller 640 px working image for the always-on Fast model while
  keeping the explicitly selected accurate model at 1024 px.
- [x] Preserve selected Gaussian IDs while navigating.
- [x] Keep YOLO off the critical scene-loading path.
- [x] Keep work/status lanes stable instead of flickering between phases.
- [x] Pin one segmentation method for the entire scan; never load or switch to a heavier
  model halfway through an orbit.
- [x] Let opening or touching the 2D mask editor preempt browser-side synthetic
  rendering immediately; restart the all-sides scan only after editing closes.
- [x] Yield an interactive browser frame between staged synthetic views so an
  edit/cancel action can interrupt before the next splat sort.
- [ ] Move authoritative synthetic RGB, depth, normals, and contributor-ID
  rendering to a backend `gsplat` service; the browser should receive progress
  and revisioned Gaussian diffs instead of sorting millions of splats per angle.
- [x] Reject attached-object flooding by limiting novel-view growth to tiny raster-gap bridges.
- [ ] Profile hover fill, SAM decode, grid growth, diff rendering, and dock thumbnails.
- [ ] Cancel or supersede every task that can safely stop after view/parameter changes.
- [ ] Bound caches and transient GPU buffers.
- [x] During camera motion show only the spatial scene ripple; reveal the
  text status only for an encode that lasts long enough to read.
- [x] Restart the restrained spatial ripple when the camera settles so the
  unselectable encoding interval is always visible without a full-object jello effect.
- [x] Show truthful hint-source state (`YOLO n`, queued, scanning, or visual-only)
  and never label a classic visual-region fallback as a detected object class.
- [x] Replace the lag-prone JavaScript-following unavailable cursor with the
  native progress cursor while retaining the scene ripple.

## 10. Demo, QA, and handoff

- [x] Use the requested Nelson Ghost Town water-tower PLY as the deterministic
  local development default.
- [x] Support deterministic demo selection with `?demo=<Downloads filename>`.
- [ ] Finish downloading and inspect the photographed train scene for YOLO QA.
- [ ] Capture direct Chrome screenshots of hover, selection, add/remove diff, lock,
  hologram, dock, drag, and multiview states.
- [ ] Run the production build and inspect console/network errors.
- [ ] Remove generated diagnostic files from the repository worktree.
- [ ] Commit and push the completed feature set.

## 11. Spaceship interaction arc

- [x] Document the flight → cockpit → scan → extract → cargo → restore vision.
- [ ] Ease from free flight into a stable cockpit scan posture when movement stops.
- [ ] Make target hints read as a combat HUD without obscuring the scene.
- [ ] Add a short alien-tech scan ray that communicates which target is being analyzed.
- [ ] Add a concise shrink/tractor-beam extraction transition into the object dock.
- [ ] Keep the one-click path simple while advanced evidence and model details remain available.

## 12. Navigation and exploration

- [ ] Add an explicit Exploration mode that immediately cancels selection,
  projection encoding, detector work, and multiview tracking while the user flies.
- [ ] Hide the 2D projection, selection hologram, inspector, and processing lanes
  in Exploration mode; leave only navigation and a concise exit control.
- [ ] On leaving Exploration mode, wait for the camera to settle and encode only
  the final view rather than replaying intermediate work.
- [ ] Preserve Q/E as heading-left/heading-right controls; do not overload them
  with the Exploration-mode toggle.
- [ ] Add world-origin navigation tools: show/hide axes and origin marker, frame
  the whole scene, frame the active selection, and orbit the active selection.
- [ ] Distinguish raw PLY world origin, robust scene centre, and current object
  centre so large/off-centre reconstructions are never framed ambiguously.
