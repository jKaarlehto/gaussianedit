# Fusion R&D tranche — exact evidence, bounded refinement, and active views

Status: **research contract and browser-free reference implementation only**.
Nothing in this document or the accompanying modules is connected to the live
selection path. `EXPERIMENTAL_EVIDENCE_V2_DEFAULT` remains `false`.

This tranche turns the direction in [`FUSION_ARCHITECTURE.md`](FUSION_ARCHITECTURE.md)
into falsifiable interfaces and experiments. It does not claim that the
proposed combination is state of the art, or that the proposed active-view
score is novel, until the benchmark matrix below supports those claims.

## Baseline audit

The live pipeline is useful but does not yet implement the evidence model:

- `lift.js` has a conservative projected-footprint sampler. It is an honest
  preview, but not the renderer's exact contributors.
- `multiviewRefinement.js` averages support over observations and records broad
  camera sectors in one 31-bit mask. Distinct sectors can alias, and the data
  model cannot represent visible negative, occluded, unknown, manual, or
  derived evidence independently.
- Synthetic frames carry an `evidenceGroup`, but outputs from the same seed,
  tracker session, rendered RGB, detector prompt, and angular neighborhood do
  not have explicit causal lineage.
- Browser YOLO and backend YOLO are proposal providers. A box may select or
  prompt a SAM result, but it is not an independent membership vote.
- `Item`, `Region`, and `Whole` currently select area-ordered SAM alternatives.
  SAM's alternatives are ambiguity hypotheses, not a validated semantic
  hierarchy.

The replacement must preserve the current preview and progressively supersede
it. It must not delay the first highlighted result.

## Target pipeline

```text
immutable mask/frame revision
  ├─ instant projected-footprint preview
  └─ authoritative contributor lift (isolated gsplat cutout)
       ├─ immutable sparse evidence event
       ├─ causal-family fusion
       ├─ seed-reachable topology cleanup
       └─ bounded changed-ROI graph cut
            └─ revisioned add/remove/disputed diff
```

Every stage receives scene, view, selection, mask, and scan revisions. A stale
result is discarded before it can mutate the object draft.

## 1. Exact contributor evidence

### Backend raster contract

Use an isolated object cutout plus a bounded halo, never the 8.8M-Gaussian live
scene. The authoritative renderer returns:

```ts
type ContributorFrame = {
  revision: RevisionTuple;
  camera: FrozenCameraRecord;
  width: number;
  height: number;
  contributorsPerPixel: number;
  // [H, W, K], front-to-back; -1/0 padding
  gaussianIds: Int32Array;
  alphaTimesTransmittance: Float32Array;
  accumulatedAlpha: Float32Array;
  expectedDepth?: Float32Array;
  normals?: Float32Array;
  globalCutoutIds: Uint32Array;
};
```

The official `gsplat` main branch now exposes all-contributor and top-contributor
ID/weight rasterization. The top-contributor weights are explicitly
`alpha × T`. These APIs were added on the unreleased main branch in June 2026;
PyPI 1.5.3 cannot be assumed to contain them. Pin a reviewed commit, feature
detect the functions, and fail closed to the current preview if unavailable.

Default experiment settings:

- 512 × 512 scan mask resolution.
- Top 8 contributors per pixel; compare K = 4, 8, 16 against the all-contributor
  oracle on small fixtures.
- Ignore returned weights below `1e-4`.
- Do not treat accumulated alpha below `0.02` as a negative observation.
- Crop contributor extraction to the mask bounding box plus a 16-pixel ring.
- Return sparse per-Gaussian reductions from CUDA/PyTorch. Do not transfer the
  full `[H,W,K]` tensor to the browser.

### Signed attribution

For each pixel and contributor:

```text
w(g,p,v) = alpha(g,p,v) * transmittance(g,p,v)
r(p,v)   = boundary reliability * view reliability

positive(g) += w * r  for attributed foreground pixels
negative(g) += w * r  for observed background inside negative scope
observed(g) += w * r
```

Foreground attribution uses the front-to-back prefix carrying 90% of returned
radiance mass in the initial experiment. The remaining translucent tail is
recorded as `unknown`, not deleted. This is a testable bias against assigning
background visible through translucent foreground to the object. It is not
assumed correct: benchmark prefix fractions 0.75, 0.9, 1.0 and a
segmentation-conditioned depth gate.

Top-K truncation mass and alpha not represented by returned contributors are
frame diagnostics. They cannot be assigned to a Gaussian and must never be
silently counted as foreground or background.

Negative evidence is legal only where the mask provider declares a negative
scope and a Gaussian has real visible contribution. An occluded or absent ID is
unknown, not negative.

The reference implementation is `liftContributorEvidence()` in
[`evidenceFusion.js`](evidenceFusion.js). Its JS loop is a correctness fixture,
not the production reducer.

## 2. Immutable causal evidence

The proposed event adds two distinct keys:

- `observationUnitId`: one rendered RGB observation. YOLO, SAM, color, and
  derived products from that RGB share this unit.
- `causalFamilyId`: one causal lineage, such as a captured camera or one
  tracker seed/session. Adjacent frames from a synthetic track share a family.

This is more expressive than one `correlationGroup`. The contract is:

```ts
type EvidenceEventV2 = {
  id: string;
  revision: {
    scene: number;
    view: number;
    selection: number;
    mask: number;
    scan: number;
  };
  provider: { id: string; version: string; modelId?: string };
  causalFamilyId: string;
  observationUnitId: string;
  target: "pixel" | "gaussian" | "supernode";
  semantics:
    | "calibrated-log-evidence"
    | "raw-model-score"
    | "binary-membership"
    | "hard-constraint"
    | "pairwise-affinity"
    | "quality-flag";
  effect: "membership" | "prompt-only" | "quality-only";
  fields?: {
    ids: Uint32Array;        // sorted, unique
    positive: Float32Array;  // finite, non-negative
    negative: Float32Array;  // finite, non-negative
    observed: Float32Array;  // positive + negative + unknown
    unknown: Float32Array;   // finite, non-negative
  };
  negativeScope:
    | "none"
    | "local-ring"
    | "proposal-box"
    | "visible-frame"
    | "manual-edit";
  calibrationId?: string;
  provenance: {
    parentEventIds?: string[];
    transformation?: {
      id: string;
      kind: "new-observation";
      correlation: "same-causal-family";
      provider: { id: string; version: string };
    };
    camera?: FrozenCameraRecord;
    prompt?: unknown;
    alteredVisibility?: boolean;
    elapsedMs?: number;
  };
};
```

A YOLO box used to prompt or rank SAM is `effect: "prompt-only"`. It remains in
provenance but contributes zero membership. A SAM result derived from it names
the YOLO event as a parent and shares the observation and causal family.

Fusion requires an exact expected `{scene, view, selection, mask, scan}` tuple
and rejects the entire batch when any event differs. Event IDs are idempotency
keys and must be unique within a batch. `negativeScope: "none"` cannot carry
negative mass. Labels and sparse mass are validated strictly; unknown labels,
NaN, infinity, or inconsistent observed mass fail closed.

Every parent must exist earlier in the same bounded batch. Forward references,
cycles, missing parents, cross-family inheritance, and implicit changes of
observation unit fail closed. Same-observation parent/child evidence shares a
lineage and cannot amplify itself: correlated contributions are combined
without exceeding the strongest member. A derived new observation requires
the explicit transformation record above and remains in the same causal
family, so the family cap still applies.

### Hierarchical caps

For one Gaussian:

```text
unit contribution =
  clamp(sum related event contributions, -unit cap, +unit cap)

family contribution =
  clamp(sum unit contributions, -family cap, +family cap)

bounded signed evidence =
  prior + sum family contributions
```

Initial reference caps are 1.0 per observation and 2.5 per family. They are
regularization strengths, not probabilities. Duplicating a SAM-derived event,
adding bridge frames, or running another detector on the same RGB therefore
cannot manufacture unlimited certainty. A calibrated captured camera may form
an independent family. Synthetic branches seeded from the same accepted mask
remain correlated even when they cover different angular units.

Manual include/exclude is a hard constraint and never enters the capped sum.
Contradictory manual constraints produce `disputed`; models do not break the
tie.

The reference functions are `createEvidenceEvent()` and
`fuseEvidenceFamilies()` in [`evidenceFusion.js`](evidenceFusion.js).
The returned `boundedSignedEvidence` is deliberately named as a heterogeneous,
capped accumulator. It is neither a posterior probability nor authoritative
log odds. A provider using `calibrated-log-evidence` must name its calibration;
raw scores remain visibly raw.

The disabled JS reference now supports at most 500,000 sparse fusion entries
and 250,000 touched Gaussians, down from the earlier aspirational limits.
Sparse shape/count/bytes are preflighted before value scans. Value scans,
provenance validation, and aggregation have time/cancellation checkpoints.
Lift and fusion reserve conservative peak working-memory estimates before
allocating their nested Maps/arrays and report input/output/peak bytes plus
elapsed time.

## 3. Bounded local GaussianCut-style refinement

Graph regularization is the third step, not the first lift and not a full-scene
operation.

### ROI and graph

1. Start from touched contributor IDs, current selection, and a spatial halo.
2. Collapse stable interior regions into cached supernodes.
3. Keep the component reachable from accepted seed nodes. Manual includes are
   additional roots. Detached components become quality flags.
4. Build graph edges from:
   - covariance-normalized spatial distance;
   - DC color compatibility;
   - stable covariance-normal compatibility;
   - repeated co-membership in independent causal families;
   - repeated boundary/depth/normal disagreement as an edge penalty.
5. Run binary min-cut on changed supernodes.
6. Expand only disputed boundary supernodes and optionally run one narrow
   splat-level cut.

Unary costs come from support, opposition, unknown coverage, and hard
constraints. Pairwise weights express local smoothness only. Spatial affinity
must never override a manual exclusion or turn opacity into semantics.

### Hard limits

Browser/reference tier:

- at most 4,096 nodes;
- at most 65,536 pairwise edges;
- estimated graph storage at most 24 MiB;
- solve budget 40 ms;
- cancellation checked during construction, BFS/DFS, residual traversal, and
  result materialization;
- abort before applying any result when a limit is exceeded.

Hard terminals are not a fixed magic number. The reference solver validates
every finite unary/pairwise cost, forms a conservative upper bound over all
finite energy, and uses the next representable capacity above that bound.
For a zero-energy graph the capacity is also strictly above the solver
residual epsilon. Overflow or a constraint violation fails closed. Candidate,
seed, and hard-root iterables are consumed incrementally with entry,
time, and cancellation checks before any array is built.

Backend experiment tier:

- supernode pass: at most 32,768 nodes, 524,288 edges, 128 MiB, p95 ≤ 50 ms;
- splat boundary pass: at most 20,000 nodes, 160,000 edges, 64 MiB,
  p95 ≤ 100 ms;
- a timeout returns the pre-cut contributor result unchanged.

The reference Dinic solver and seed-connectivity pass are in
[`localGraphCut.js`](localGraphCut.js). Production should use SciPy's sparse
Dinic solver with integer-scaled capacities first. Do not add GPL PyMaxflow to
a distributable product without an explicit licensing decision.

## 4. Honest Item / Region / Whole

`Item`, `Region`, and `Whole` are user intent, not names for three SAM output
slots.

Provider contract:

```ts
type ScaleHypothesis = {
  id: string;
  area: number;
  containsPrompt: boolean;
  recommended?: boolean;
  hierarchyClaim?: {
    providerId: string;
    providerVersion: string;
    validationId: string;
    validationDataset: string;
  };
  intent?: "item" | "region" | "whole";
  physicalScale?: number;
  semanticHierarchyId?: string;
  providerRank?: number;
};
```

- A validated scale-aware provider, such as a benchmarked SAGA-style sidecar,
  may directly satisfy an intent using physical scale.
- Direct intent requires the claim to match a separately configured hierarchy
  authority with the same provider/version/validation/dataset provenance.
  A caller-only `hierarchyValidated` boolean is rejected.
- Authority tuples are compared field-by-field, never by delimiter-joined
  keys. Every tuple field must be non-empty; `physicalScale` is positive and
  finite, and `providerRank` is finite.
- Plain SAM alternatives are filtered for prompt containment and plausibility,
  then area ordered. Smallest/middle-or-recommended/largest are an explicit
  approximation.
- Non-nested or disjoint alternatives stay alternatives; no false hierarchy is
  inferred.
- The selected event records the exact provider, hypothesis ID, area, and
  whether it was direct or approximate.

The reference resolver is [`scaleHypotheses.js`](scaleHypotheses.js).

SAGA demonstrates that learned scale-gated affinity can support
multi-granularity interaction, but it requires per-scene training. Its reported
fast inference is not evidence that zero-setup area ordering has the same
semantics.

## 5. Plausible product-specific research contribution

### Causal disagreement frontier view planning

**Hypothesis, not a published result:** choose a small synthetic sequence by
expected reduction of *segmentation disagreement with independent causal
support*, rather than fixed angular spacing or raw count of Gaussians pruned.

A low-resolution preflight contributor pass estimates, per candidate pose:

- visible alpha mass of currently disputed Gaussians;
- visible alpha mass of unknown/poorly covered Gaussians;
- visible alpha mass near the current object boundary;
- whether the pose adds a new angular observation unit;
- correlation with existing observations;
- seed-object consistency;
- render, upload, tracker-time, and byte cost.

The current surrogate is:

```text
gain =
  disputed mass
  + 0.35 * unknown mass
  + 0.8 * boundary mass
  + 0.45 * new observation unit

score =
  gain
  * (1 - causal correlation)
  * seed consistency
  / bounded compute cost
```

This is implemented only as a deterministic ranking fixture in
[`activeEvidencePlanner.js`](activeEvidencePlanner.js). It deliberately calls
itself a surrogate, not information gain.

Why it may be useful:

- SAGO's July 2026 virtual-drone method validates next-best-view planning for
  setup-free 3DGS segmentation, but its objective maximizes candidate pruning
  subject to seed-view consistency.
- POp-GS and GAVIS validate uncertainty/visibility-driven next-best-view
  selection for reconstruction and active mapping, not causal segmentation
  evidence.
- GaussianEdit already owns provenance, interactive disagreement, exact
  contributor mass, and a strict latency/byte budget. Combining those into a
  segmentation-specific active-view target is plausible and product-specific.

It is not yet safe to call this novel. The literature search must continue, and
the experiment must beat simpler planners on quality at equal compute.

## Benchmark matrix

Run each row with the same 2D masks, cameras, and object prompts:

| ID | Lift | Fusion | Refinement | Views |
| --- | --- | --- | --- | --- |
| B0 | projected center | current averaged votes | current growth | fixed orbit |
| B1 | footprint sampler | current averaged votes | current growth | fixed orbit |
| B2 | exact alpha×T | FlashSplat-style signed weighted vote | none | fixed orbit |
| B3 | exact alpha×T | causal-family caps | none | fixed orbit |
| B4 | exact alpha×T | causal-family caps | seed connectivity | fixed orbit |
| B5 | exact alpha×T | causal-family caps | bounded graph cut | fixed orbit |
| B6 | exact alpha×T | causal-family caps | bounded graph cut | SAGO prune-count NBV |
| X1 | exact alpha×T | causal-family caps | bounded graph cut | causal disagreement frontier |

Datasets and scenes:

- NVOS and SPIn-NeRF for published held-out-view comparison.
- LERF-Mask for clutter and occlusion.
- Tanks & Temples truck for a large known object.
- GaussianEdit living-room scene and Nelson 8.8M scene with a manually saved
  set of at least 12 object masks: thin, transparent, low-opacity, disconnected,
  same-color adjacency, and boundary-straddling cases.

Metrics:

- held-out-view mask mIoU and boundary F1;
- 3D precision/recall/IoU where labels exist;
- false-positive alpha mass, not only Gaussian count;
- thin-part recall and detached-stray count;
- causal-family support count and unresolved/unknown alpha mass;
- per-stage p50/p95/max latency;
- peak/released host and GPU bytes;
- scan views, tracker frames, and bytes needed to reach equal quality;
- cancellation cleanup and stale-result count.

Do not compare methods at different view counts or tracker budgets without
reporting both quality and compute.

## Nelson acceptance thresholds

These are go/no-go engineering thresholds, not paper claims:

1. No authoritative stage iterates 8.8M scene entries after the resident cutout
   and global-to-local lookup exist.
2. The exact-lift sparse result is bitwise revision-stable and agrees with an
   all-contributor oracle within:
   - ≥ 0.98 weighted-support rank correlation for K=8, or
   - K automatically increases/fails closed.
3. Exact lift plus causal fusion:
   - p95 ≤ 150 ms per 512² view after rasterization;
   - no browser main-thread slice over 50 ms;
   - ≤ 192 MiB contributor scratch and ≤ 64 MiB sparse evidence per active
     object.
4. Local refinement:
   - supernode cut p95 ≤ 50 ms;
   - optional splat boundary cut p95 ≤ 100 ms;
   - no result applied after timeout, cancellation, or revision change.
5. Total incremental scan allocation stays below the smaller of 1 GiB or 8% of
   available GPU memory, and below 768 MiB host memory.
6. After 20 select/edit/cancel cycles, retained host/GPU allocation returns
   within 10% of the post-load baseline.
7. B3 must not reduce mean held-out mIoU or boundary F1 versus B2. B5 and X1
   advance only if each improves at least one primary quality metric without a
   > 2% regression in another and stays inside latency/byte caps.
8. X1 must reach equal or better quality than fixed orbit with at least 25%
   fewer tracked frames on the median test object. Otherwise keep the simpler
   fixed/SAGO-style planner.

## Failure modes and safe fallback

| Failure | Required behavior |
| --- | --- |
| gsplat contributor API absent | Keep footprint preview; mark authoritative lift unavailable. |
| Top-K omitted mass too high | Increase K within byte cap or leave affected evidence unknown. |
| Transparent foreground leaks background support | Compare prefix/depth attribution; keep unresolved mass disputed. |
| Tracker drifts | Reject the event before fusion; do not turn it into negative evidence. |
| Repeated synthetic frames inflate support | Observation and causal-family caps stop accumulation. |
| Graph ROI exceeds cap or times out | Keep pre-cut contributor result unchanged. |
| One Gaussian straddles two objects | Mark shared/boundary disputed; do not invent a binary geometric edge. |
| No validated scale provider | Use visibly approximate area ordering. |
| Active-view planner selects unstable pose | Fail seed-consistency/pose guard and fall back to fixed bridge steps. |
| Any revision changes | Cancel backend work and discard the late diff. |

## Dependency and licensing audit

| Component | Status | Decision |
| --- | --- | --- |
| `gsplat` | Apache-2.0; official repository. Top-contributor IDs are currently unreleased main-branch functionality. | Acceptable candidate. Pin a reviewed commit and record notices. |
| SciPy sparse max-flow | BSD; integer capacities; Dinic available. | Preferred first backend graph-cut dependency if already compatible with the tracker runtime. |
| PyMaxflow | GPL, with citation requirement inherited from its core. | Do not add by default. Requires explicit product-license review. |
| GaussianCut code | Official repository exposes no detected license at review time. | Use the paper as prior art; do not copy/vendor code. |
| FlashSplat code | Repository carries the original research-only, non-commercial Gaussian-Splatting license. | Do not copy/vendor. Implement equations independently and retain citation. |
| SAGA | Apache-2.0 official repository. | Optional sidecar research is legally plausible; model/checkpoint licenses still need separate audit. |
| Gaussian Grouping | Apache-2.0 official repository. | Optional identity-sidecar research is legally plausible; DEVA/SAM/model assets need separate audit. |
| SAGO/SAGOnline | No official reusable code dependency selected in this tranche. | Treat papers as baselines; independently implement benchmark planners. |

This is an engineering audit, not legal advice.

## Implementation sequence

1. Keep the new modules disabled and land their browser-free contract tests.
2. Add a backend-only gsplat capability probe and pinned contributor fixture.
3. Validate top-K against the all-contributor oracle before accepting K=8.
4. Return one sparse `EvidenceEventV2` from the backend for the accepted seed
   view; compare it with the live footprint preview without applying it.
5. Add causal-family fusion behind a debug export and verify YOLO/SAM lineage.
6. Apply revisioned diffs only after B2/B3 quality and cancellation tests pass.
7. Add seed connectivity, then supernode cut, then boundary cut as separate
   feature flags with independent rollback.
8. Add scale-aware sidecars only after the zero-setup path is stable.
9. Benchmark the proposed active planner last; it must earn its complexity.

## Primary sources

- [gsplat rasterization API](https://docs.gsplat.studio/main/apis/rasterization.html)
  and [contributor utilities](https://docs.gsplat.studio/main/apis/utils.html)
- [GaussianCut, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/a26f3dc32a913b77fa70c33ffa5dcb37-Paper-Conference.pdf)
- [FlashSplat, ECCV 2024](https://arxiv.org/abs/2409.08270)
- [SAGA / Segment Any 3D Gaussians, AAAI 2025](https://arxiv.org/abs/2312.00860)
- [Gaussian Grouping, ECCV 2024](https://arxiv.org/abs/2312.00732)
- [Lifting by Gaussians, WACV 2025](https://openaccess.thecvf.com/content/WACV2025/html/Chacko_Lifting_by_Gaussians_A_Simple_Fast_and_Flexible_Method_for_WACV_2025_paper.html)
- [SAGOnline, 2025 preprint](https://arxiv.org/abs/2508.08219)
- [SAGO / Online Segment 3D Gaussians via Launching Virtual Drones, July 2026 preprint](https://arxiv.org/abs/2607.01628)
- [POp-GS, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/html/Wilson_POp-GS_Next_Best_View_in_3D-Gaussian_Splatting_with_P-Optimality_CVPR_2025_paper.html)
- [GAVIS, CVPR 2026](https://openaccess.thecvf.com/content/CVPR2026/html/Xue_Uncertainty-driven_3D_Gaussian_Splatting_Active_Mapping_via_Anisotropic_Visibility_Field_CVPR_2026_paper.html)
