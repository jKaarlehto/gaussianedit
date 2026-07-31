# Inspect evidence — finished-object provenance editor

Status: **feature-off design and browser-free reference grouping only**.
Nothing in this tranche is connected to `main.js`, the 3D Object workspace, or
the live fusion path. `INSPECT_EVIDENCE_DEFAULT` remains `false`.

## User intent

`Inspect evidence` answers one concrete question:

> Why is this part of my finished object here, and what would happen if I
> removed or adjusted the technique that put it there?

It is not a profiler, model log, generic debug drawer, or a list of every
intermediate tensor. The user should be able to identify a suspicious strand
or patch, see which passes uniquely or jointly support it, preview a change,
and apply the resulting exact add/remove diff deliberately.

The feature opens from a finished 3D Object result. It is a temporary
inspection surface over the same object draft, not a fourth workspace and not
part of the normal `Select visible side → Scan all sides → Fix if needed →
Dock object` rail.

## Compact popup information architecture

The 3D Object controls gain one secondary action only after a result exists:

```text
Inspect evidence
```

The action opens one bounded overlay:

```text
INSPECT EVIDENCE                           [Close]
Why these Gaussians belong to this object

PASSES
  Visible selection                 3,812
  Hidden-side tracking              1,406
  Gap fill                            128
  Local refinement                    74
  Manual changes                       6

PARTS
  Visible selection + tracking      1,121
  Tracking only                       203
  Gap fill only                        11
  Local refinement only                4
  Other small combinations             8       [Show]

Selected part: Tracking only · rear leg
  [Preview without]  [Tune pass…]

Preview: 23 removed · 2 disputed
  [Apply change]  [Cancel preview]
```

Names describe the user's workflow. Provider/model names, causal-family IDs,
event IDs, raw scores, and timings live in secondary details.

`PASSES` answers which techniques contributed. `PARTS` answers which exact
combinations contributed to spatially distinct pieces. Selecting a row
highlights only its Gaussians in the 3D Object view. The normal result remains
visible as restrained context.

The common path shows at most 12 impactful rows. A small-combinations row is
not directly toggleable; `Show` reveals its real cohorts. Spatial components
inside one cohort are expanded only when that cohort is selected. This makes a
small isolated strand available without rendering hundreds of singleton rows
up front.

## Provenance model

Each final Gaussian retains:

- the exact scene/view/selection/mask/scan revision;
- its final decision (`included`, `excluded`, `disputed`, or `unknown`);
- manual include/exclude event IDs;
- signed contributions grouped by authoritative causal family;
- a product pass key for each causal family;
- alpha mass (when available), uncertainty, and isolation/quality flags;
- the immutable event IDs needed to replay the affected local ROI.

The product pass keys initially are:

| Pass key | Product label | Typical source |
| --- | --- | --- |
| `visible-selection` | Visible selection | accepted 2D mask contributor lift |
| `bridge-growth` | Gap fill | bounded spatial bridge additions |
| `local-refinement` | Local refinement | cleanup/graph regularization |
| `hidden-side-tracking` | Hidden-side tracking | accepted tracked views |
| `manual-change` | Manual changes | hard include/exclude edits |

One product pass may contain several genuinely independent causal families,
such as captured cameras. Conversely, detector, prompt, mask, and lift products
derived from one RGB observation stay in the same causal lineage. Product
grouping never changes fusion independence and never turns correlated events
into extra votes.

An **exact support cohort** is the observed tuple:

```text
positive pass keys
+ opposing pass keys
+ hard-constraint state
+ final decision
```

Only signatures that actually occur are materialized. The implementation must
never enumerate the theoretical `2^N` pass power set. `Visible + tracking`,
`Gap fill only`, and three-pass combinations therefore appear naturally when
they exist.

Within one cohort, a **part** is a connected component in the current
object-local Gaussian adjacency graph. Components are computed lazily. Tiny
components are aggregated into `Other detached fragments` until explicitly
requested. Spatial proximity alone never merges different support signatures.

## Bounded presentation

The reference defaults are:

- at most 250,000 final Gaussians;
- at most 128 causal families and 32 product passes;
- at most 4,096 observed support cohorts;
- at most 2,000,000 total Gaussian-to-pass memberships;
- at most 1,000,000 object-local adjacency edges during one expansion;
- 12 primary cohort rows and 24 expanded spatial rows;
- cohorts enter the primary list through top impact, at least 0.25% of object
  mass, at least 25% uncertainty, or at least 0.65 mean isolation;
- smaller cohorts aggregate without losing their exact IDs.

Impact uses alpha mass when the renderer supplies it and Gaussian count
otherwise. Counts and bounded evidence are not presented as calibrated
probabilities.

## Toggle and parameter semantics

All controls are non-destructive previews:

1. Snapshot the exact current revision.
2. Select a pass, cohort, or spatial part.
3. Produce a bounded ROI containing only Gaussians touched by that target and
   its configured graph halo.
4. Replay retained events for that ROI with the pass disabled or its validated
   parameters changed.
5. Run the same causal fusion and bounded local regularization used by the
   object pipeline.
6. Display the exact `addIds`, `removeIds`, and `disputedIds` diff.
7. `Apply change` creates a new mask/selection revision. `Cancel preview`
   discards the temporary result.

A UI-only visibility toggle is allowed for comparison, but it must be labelled
`Hide in preview`; it cannot become the saved object. A causal pass toggle must
recompute. Removing orange points from the renderer without replaying fusion is
not evidence editing.

Parameter controls are provider-owned schemas with safe ranges and units.
Their initial values and provider/version are immutable provenance. The popup
shows only parameters that the pass declares adjustable. A change with no
bounded ROI or no replayable events fails closed.

## Required pipeline events

The live path must retain a compact immutable `PassEvidenceRecord` per accepted
pass transaction:

```ts
type PassEvidenceRecord = {
  id: string;
  revision: {
    scene: number;
    view: number;
    selection: number;
    mask: number;
    scan: number;
  };
  passKey:
    | "visible-selection"
    | "bridge-growth"
    | "local-refinement"
    | "hidden-side-tracking"
    | "manual-change";
  passRunId: string;
  causalFamilyId: string;
  observationUnitId: string;
  provider: { id: string; version: string; modelId?: string };
  parentEventIds: string[];
  parameters: Record<string, unknown>;
  parameterSchemaId?: string;
  roiIds: Uint32Array;          // sorted, object-local touched IDs
  positiveIds: Uint32Array;
  opposingIds: Uint32Array;
  addedIds: Uint32Array;
  removedIds: Uint32Array;
  disputedIds: Uint32Array;
  alteredVisibility?: boolean;
};
```

The materialized object snapshot additionally retains:

- causal-family contribution summaries aligned with final Gaussian IDs;
- family-to-pass catalog and user-facing pass labels;
- family-level event IDs (the current experimental fusion summary keeps only
  all event IDs plus family totals, which is insufficient for selective
  replay);
- object-local adjacency/supernode revision, or a callback that builds a
  bounded adjacency ROI lazily;
- alpha mass, uncertainty, and detached/isolation quality flags;
- a replay callback accepting the exact base revision, disabled pass keys,
  parameter overrides, ROI IDs, cancellation signal, and byte/time budgets.

`ScanCoordinator` progress events are not provenance by themselves. Its lift
and fusion dependencies must publish accepted immutable evidence transactions.
Rejected, failed, stale, and cancelled work stays in diagnostics but never
appears as support for a final Gaussian.

## Integration contract

The feature may be wired only when:

1. every visible, bridge, refinement, multiview, and manual addition has a
   product pass key and causal lineage;
2. the final materialization can answer family-level event IDs per Gaussian;
3. ROI replay returns a revisioned exact diff and rejects stale results;
4. cancellation releases temporary adjacency, event, and preview buffers;
5. a performance review confirms no whole-scene scan after object cutout
   creation;
6. the normal 3D Object flow stays unchanged while the feature flag is off.

The reference module [`evidenceInspector.js`](evidenceInspector.js) groups
already-materialized provenance and creates recompute plans. It deliberately
does not perform fusion, graph construction, or live mutation.
