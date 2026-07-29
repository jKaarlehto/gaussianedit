# splat-seg

Click-to-select regions of a Gaussian splat scene in Three.js. A fast one-click
SAM result is the default; the post-selection inspector can refine it with SAM
3 Tracker, contiguous edge-aware color fill, or a deterministic screen radius.

## Why SAM and not YOLO

YOLO-seg is useful here as a proposal layer, not the final authority. It can
pre-detect known object classes, provide hover targets, and pass boxes to SAM,
but a fixed-vocabulary detector cannot select arbitrary details such as one
tile. The current interaction therefore starts class-agnostic. A future YOLO or
open-vocabulary detector can be loaded on demand to add "select all chairs" and
object-candidate UX without weakening point selection or classic fill.

## Pipeline

```
camera settles ──► capture frame ──► model image encoder    (~150-400 ms, once per view/model)
                         │                │
                         └──── project splats + tile depth  (cached for this frozen view)
                                          │
click ──────────────────────────────► mask decoder          (~5-20 ms, cached per prompt)
                                          │
                         masks ranked by area and predicted quality
                                          │
                        ┌─────────────────┴─────────────────┐
                        │  lift: reuse frozen projections   │
                        │  and test (a) inside mask         │
                        │       (b) not occluded            │
                        └─────────────────┬─────────────────┘
                                          │ seeds = visible shell
                        ┌─────────────────┴─────────────────┐
                        │  grow: 3D flood fill through the  │
                        │  mask's frustum + depth band      │
                        └─────────────────┬─────────────────┘
                                          │
                                  Set<splatIndex>
```

### The bit you were asking about: relating 2D back to 3D

The obvious move is a splat-ID buffer — render splat indices to an offscreen target and read back which ID is under each masked pixel. Don't start there. Gaussian splats are alpha-blended with no hard surface, so a pixel is a weighted sum of dozens of splats and "the splat at this pixel" is genuinely ill-defined. Doing it properly means an argmax-of-contribution pass (`w_i = α_i · T_i`), which needs either a two-pass weighted-depth trick or `atomicMax` on a packed `(weight << 24 | id)` key in a compute shader.

So this goes the other direction — forward, not backward:

1. Freeze the exact `projectionMatrix · viewMatrixInverse` used for the frame SAM encoded. Everything downstream uses that snapshot, which is why orbiting invalidates the encoding.
2. Project all N splat centres through it in one pass. For a perspective camera the clip-space `w` *is* the view depth, so occlusion depth comes free.
3. In the same pass, accumulate a coarse min-depth buffer at 4×4 px tiles. That's your occlusion reference — no depth render target, no float readback, no dependency on the splat renderer's shaders.
4. Second pass: a splat is a seed if it lands on a masked pixel **and** its depth is within tolerance of that tile's nearest splat.

The O(N) projection is now performed once after each settled camera encode and
cached with that frozen view. A click only scans the cached screen/depth arrays,
and adjusting 3D completion settings reuses the lifted visible shell. Move the
projection to a worker or transform-feedback pass if the one-time encode-stage
cost is still too high for very large scenes.

### Reaching the splats SAM never saw

The mask only describes the visible shell. `grow.js` flood-fills from the seeds through a prebuilt uniform grid (CSR layout, built once at load), accepting a neighbour only if it *still projects inside the same mask* and sits inside a depth band around the seed surface. The mask acts as a generalised cone that constrains lateral leakage while letting the selection eat backwards into the object's thickness.

Be clear-eyed about this: it is a heuristic. It cannot know that the far face of an opaque wall belongs to the same tile, because at click time nothing can — that information was never observed from this viewpoint. It works well for thin structures and objects with some transparency at the silhouette, and it will under-select the backs of thick opaque things.

## Going 3D-complete

The real fix is offline feature lifting, which is what the literature does:

- **SAGA** and **Gaussian Grouping** attach a learned per-splat feature/identity vector, distilled from SAM masks rendered across many training views with a contrastive or identity loss.
- **OmniSeg3D**-style hierarchical contrastive lifting also preserves the subpart/part/whole hierarchy, which maps beautifully onto your granularity toggle — the level becomes a similarity threshold rather than a mask index.

Runtime then becomes: click → read the feature at the hit splat → cosine similarity against all splats → threshold. Milliseconds, fully 3D-complete, view-independent. The hook is trivial to add here: replace the body of `select()` with a similarity query and keep everything else. The cost is a preprocessing pass in Python over your training views.

If you want something in between with no training: run the current pipeline from 6–12 orbit positions automatically, and take the union (or a voting threshold) of the per-view selections. Cheap, no learning, and it closes most of the occlusion gap.

## Files

| file | job |
|---|---|
| `main.js` | wiring, camera-idle encoding, click handling, UI |
| `sam.js` | fast SlimSAM and lazy SAM 3 Tracker encode/decode |
| `segmentationModels.js` | pluggable model-provider registry and picker metadata |
| `selectionSources.js` | common 2D-mask provider registry for models and classic CV |
| `maskTools.js` | edge-aware color flood fill and screen-radius masks |
| `lift.js` | projection + tile depth buffer + mask test |
| `grow.js` | uniform grid + frustum-constrained flood fill |
| `highlight.js` | selection overlay |
| `splatSource.js` | the only file that knows about the splat renderer |

The running app also shows the frozen SAM input in a bottom-right **2D
projection** PiP. Orange is the decoded SAM mask, the white/orange ring is the
click prompt, and green dots are the front-surface splats accepted by the lift
pass. The PiP is marked stale while the camera has moved and re-encoding is
pending, so it is also a quick check that picking and projection refer to the
same frame.

While that projection is being encoded, selection clicks are paused. A subtle
radial ripple travels through the actual splat centers for 900 ms, rests, and
repeats every three seconds alongside a centered readiness message and a
cursor-following encoding indicator. The shader ripple is disabled during the
capture itself, so the model always encodes stable geometry. The effect clears
after the frozen camera projection and model embedding match, at which point
the viewport cursor changes back to the selection crosshair.

## Responsiveness and caching

- Camera motion invalidates picking immediately, but encoding waits for 280 ms
  of settled motion. Tiny pose jitter below the translation/rotation thresholds
  is ignored, so it cannot continuously restart the encoder.
- Only one encode runs at a time. Browser GPU/ONNX dispatches cannot always be
  interrupted after submission, so a camera move marks the result stale,
  discards it on completion, and retains exactly one queued request for the
  newest view. It never builds a backlog of obsolete encodes.
- A click made while the view is settling is visibly queued and runs once the
  matching frozen view is ready. Moving again cancels that click rather than
  applying it to the wrong pixels.
- Loaded model sessions and downloaded weights are reused. The browser's
  persistent cache avoids downloading weights on later visits; each loaded
  provider keeps at most its embedding for the current view.
- Decoder masks are cached by provider, frozen-view revision, and prompt set.
  Changing Tight/Suggested/Broad reuses those masks. Color/radius threshold
  changes rerun only their inexpensive deterministic provider.
- Splat projections and the tile-depth buffer are cached once per frozen view.
  Depth slack reuses that projection; neighbour radius and grow passes also
  reuse the lifted mask seeds.
- The uniform 3D grid is built once per scene. Grid construction, projection,
  and 3D growth yield in bounded chunks so rendering, progress updates, and
  superseding work remain responsive.
- The accepted selection is stored as world-space splat indices, so its 3D
  highlight stays attached while the camera moves. The 2D mask outline is
  dismissed because it is valid only for the view that produced it.

The work panel names the active stage (model, capture, encode, projection,
mask, lift, grow), shows elapsed time, and distinguishes queued, ready, and
failed states. This makes a slow first model download or WASM encode explicit
instead of looking like a hung tab.

## Running

```bash
npm install
npm run dev
```

Then drag a `.ply` / `.splat` / `.ksplat` onto the page, or uncomment the `loadSplat()` call in `main.js` and point it at your own asset. `.ksplat` loads fastest — convert with the tooling in `@mkkellogg/gaussian-splats-3d`.

Controls: click adds an automatic region and opens its properties;
`Shift`+click subtracts. In Auto mode, `Ctrl`/`Cmd`+click adds a positive
refinement prompt and `Alt`+click adds a negative prompt. Tight is the smallest
SAM mask, Suggested is the model's highest predicted-quality mask, and Broad is
the largest. Auto object, Color fill, and Radius can be enabled together and
combined by consensus, union, or intersection. The live border can be painted
with Add/Remove brushes before the shared 3D completion stage runs. Fill and
Radius remain deterministic fallbacks when model semantics are unhelpful.
For camera navigation, `W`/`S` move forward/back, `A`/`D` strafe,
`Q`/`E` change heading, `Ctrl`/`Space` move down/up, and `Shift` sprints.

## Things to verify on your machine

- **Splat accessors.** `splatSource.js` calls `splatMesh.getSplatCount()`, `getSplatCenter(i, out, true)` and `getSplatColor(i, out)`. These are the only internals touched, and they have moved between versions of `@mkkellogg/gaussian-splats-3d`. If the centres come out wrong, that's where to look — everything else is renderer-agnostic.
- **DropInViewer update call.** The main loop calls `viewer.update?.(renderer, camera)` defensively; some versions drive sorting from `onBeforeRender` instead and don't need it.
- **Model.** Defaults to `Xenova/slimsam-77-uniform` because it's small and loads fast. `Xenova/sam2.1-hiera-tiny` gives noticeably better boundaries on splat renders (which are noisy and floater-ridden) at a higher encode cost — swap the id in `new Sam(...)`.
- **WebGPU.** Falls back to q8 WASM automatically. On WASM the encode is closer to 1–3 s, so the camera-idle scheduling matters more.

## Known rough edges

- Floaters near the camera poison the tile min-depth buffer and can cause false occlusion. The depth-tolerance slider is the blunt fix; a proper weighted-depth pass is the real one.
- The 4×4 tile size in `lift.js` trades occlusion accuracy against silhouette bleed. Tune per scene.
- Selection is stored as splat indices into load order — stable for a given file, meaningless across re-exports.
- `Isolate` currently just toggles the splat cloud off so you can see the selection alone. Actually hiding *unselected* splats needs the in-shader route below.

## Tinting in-shader

If the points overlay isn't enough and you want the selected splats themselves recoloured or the rest hidden: upload the selection as a `DataTexture` of one byte per splat, indexed by splat id in the splat fragment shader, and patch `SplatMesh`'s material source (it's a `RawShaderMaterial` with explicit GLSL, so string patching rather than `onBeforeCompile`). Multiply into the output colour. That's the only place where this design has to reach into the renderer, which is why it isn't the default.
