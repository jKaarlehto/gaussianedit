# Multimodal and Gaussian evidence architecture

## Product rule

The user performs one action: **scan this object**. Internally, providers may
disagree, abstain, or refine the answer over time. The app must preserve those
differences instead of averaging unrelated scores into a vague confidence.

The normal visible progression is:

> Visible outline → Hidden sides → Close gaps → Review disagreements

Every later stage updates the same selected object with an exact added/removed
diff. Provider names and technical evidence remain available as secondary
explanation, not as the primary workflow.

## What each input is allowed to mean

| Input | Meaning | Not allowed |
| --- | --- | --- |
| SAM mask | object-membership evidence in one image | proof of hidden 3D membership |
| YOLO box | object location/class proposal and weak region prior | pixel mask or arbitrary-object detector |
| Color fill | deterministic connected appearance region | calibrated probability; outside is usually unknown |
| Radius | deterministic local guide | evidence that the full object is circular |
| Image/depth edge | boundary constraint | foreground membership by itself |
| Manual add/remove | hard user constraint | being diluted by model evidence |
| Tracked synthetic view | correlated new observation | a fully independent vote from the seed view |
| Calibrated captured view | independent observation when visibly supported | negative evidence for occluded Gaussians |
| Gaussian position/covariance/color | local affinity and cleanup constraint | semantic identity by itself |
| Opacity/density/component size | quality warning | silent deletion of transparent or thin object parts |

## Evidence event

Providers publish immutable observations. They do not mutate the selection
directly.

```ts
/**
 * Dense fields are typed arrays; large sparse fields are sorted Gaussian IDs
 * plus values. Pixel masks may use RLE.
 */
type EvidenceEvent = {
  id: string;
  revision: number;
  viewId?: string;
  provider: {
    id: string;
    version: string;
    modelId?: string;
  };
  // Related outputs from one RGB render are capped as one evidence family.
  correlationGroup: string;
  target: "pixel" | "gaussian" | "supernode";
  semantics:
    | "calibrated-probability"
    | "raw-model-score"
    | "binary-membership"
    | "hard-constraint"
    | "pairwise-affinity"
    | "quality-flag";
  positive: EvidenceField;
  negative?: EvidenceField;
  observed: EvidenceField;
  negativeScope: "none" | "local-ring" | "proposal-box" | "visible-frame";
  calibrationId?: string;
  provenance: {
    parentEventIds?: string[];
    prompt?: unknown;
    camera?: unknown;
    alteredVisibility?: boolean;
    elapsedMs?: number;
  };
};
```

The Gaussian aggregate keeps separate support, opposition, observation, manual
constraints, conflicts, and unknown coverage. The UI may derive included,
excluded, and review states, but must not destroy the underlying provenance.

## Fusion

Use bounded log-evidence per independent family:

```text
membership logit =
  prior +
  Σ family clamp(Σ event contribution, -family cap, +family cap)
```

- Calibrated probabilities may contribute log-odds.
- Raw neural scores remain raw scores until calibrated on held-out splat
  renders.
- Deterministic guides contribute named strengths, not probabilities.
- A provider may oppose only inside its declared negative scope.
- Unobserved and occluded Gaussians do not enter a negative denominator.
- Manual include/exclude and protected parts are hard constraints.
- Outputs derived from the same RGB image share a correlation group. A YOLO
  box that prompted SAM cannot independently double the SAM result.

User-facing summaries should prefer `4 of 6 useful views agree`, `edge stopped
growth`, or `back side not seen`. Only display a probability if its calibration
has actually been validated. Neural calibration is a separate engineering task;
see [Guo et al.](https://proceedings.mlr.press/v70/guo17a.html) and detection
calibration work by [Küppers et al.](https://arxiv.org/abs/2004.13546).

## Exact 2D-to-Gaussian lifting

The current projected-centre/tile-depth lift stays as the instant preview.
Authoritative refinement should use the contributors that actually formed each
pixel:

```text
Gaussian evidence +=
  normalized(alpha × transmittance contribution)
  × signed pixel evidence
  × boundary reliability
  × view reliability
```

This fixes large splats whose centre lies outside a painted region, background
visible through holes, and false negative votes for occluded splats. The
`gsplat` rasterizer exposes rendered features, depth/normals, and contributor
information suitable for a Python/CUDA refinement service:
[rasterization](https://docs.gsplat.studio/main/apis/rasterization.html) and
[contributor utilities](https://docs.gsplat.studio/main/apis/utils.html).

## Gaussian-native graph

Use the existing uniform grid to enumerate a local selection-plus-halo graph.
An edge is stronger when nearby Gaussians have:

- scale/covariance-normalized spatial proximity;
- compatible DC color;
- compatible planar orientation when covariance supports a stable normal;
- repeated co-membership in independent views.

It weakens across repeated mask, depth, or normal boundaries. A nonzero spatial
term must remain so multicolored parts of one object can stay connected.

Cost order:

1. Keep the seed-reachable component.
2. Flag small detached components without manual locks as possible strays.
3. Run binary min-cut on changed supernodes/ROI.
4. Run splat-level min-cut only in a narrow disputed boundary band.

[GaussianCut](https://arxiv.org/abs/2411.07555) is the primary training-free
reference: it turns 2D masks into unary evidence and regularizes them with a
Gaussian graph using scene position and color. Full-scene graph cuts are too
slow for every drag, so this app should use cached supernodes and local dynamic
updates.

A large Gaussian may physically straddle two objects. No label fusion can make
that edge exact. A future explicit `Repair boundary` process may split such
Gaussians; it must never happen silently during selection.

## YOLO roles

| Job | Provider direction | Role in fusion |
| --- | --- | --- |
| Immediate target HUD | cached browser YOLO nano | proposal/ranking only |
| Refined known-class boxes | backend YOLO12-S/M | replace/merge proposal geometry |
| SAM prompt | best box + interior positive + outside negatives | prompt provenance, not a second vote |
| Tracking guard | refined box + shared Gaussian overlap | detect identity drift/re-anchor |
| Cross-view association | box/label plus shared visible Gaussians | weak association cue |
| Known-class instance mask | pretrained YOLO11/26 segmentation | independent mask family after calibration |
| Arbitrary-object discovery | SAM automatic masks / OWLv2 objectness | category-free proposals |
| Open-vocabulary request | YOLO-World/YOLOE or Grounding DINO | text-conditioned proposal |
| Pose/classification/OBB | optional specialist tools | not part of normal extraction |

YOLO12 improves detection accuracy, but the currently released pretrained
YOLO12 weights are detection-only and retain a fixed vocabulary. It is a useful
backend refinement provider, not the answer to unknown user content. See the
[YOLO12 paper](https://arxiv.org/abs/2502.12524) and
[current task/weight availability](https://docs.ultralytics.com/models/yolo12/).

## Optional scene analysis

Arbitrary RGB PLY files keep the zero-setup path above. `Analyze scene` may
create a versioned, scene-hash-cached sidecar containing:

- local graph/supernode membership and boundary weights;
- per-Gaussian view coverage and contributor statistics;
- compressed instance/affinity features;
- optional DINO/CLIP or language features;
- provider versions and full provenance.

Recommended implementation order:

1. Training-free exact contributor lifting plus local GaussianCut-style graph.
2. Cached supernodes for million-splat interaction.
3. Training-free SAM/DINO/CLIP lifting, following
   [Lifting by Gaussians](https://openaccess.thecvf.com/content/WACV2025/html/Chacko_Lifting_by_Gaussians_A_Simple_Fast_and_Flexible_Method_for_WACV_2025_paper.html).
4. Optional scale-aware affinities based on
   [SAGA](https://arxiv.org/abs/2312.00860), so part/object/whole becomes a
   physical-scale query.
5. Optional persistent instance identities based on
   [Gaussian Grouping](https://arxiv.org/abs/2312.00732).
6. Sparse semantic supernodes for language selection rather than attaching a
   large feature vector to every splat.

## Incremental runtime

1. Publish the browser mask and fast lift immediately as `visible preview`.
2. Preserve its evidence event and start exact contributor lifting.
3. Update only changed evidence families.
4. Recompute conflict/unknown flags and local graph regularization.
5. Stream revisioned `addIds`, `removeIds`, and `disputedIds`; discard stale
   revisions after camera/mask changes.
6. Add synthetic SAM tracking views progressively. Correlated bridge frames
   stabilize identity but do not count as independent confirmations.
7. Cache derived evidence by scene hash, camera revision, provider/version, and
   prompt revision.

The main scene and hologram always show the current actual segment. Temporary
blue/gray/amber effects explain a change, then settle.
