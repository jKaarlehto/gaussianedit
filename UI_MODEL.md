# GaussianEdit UI model

This document is the authoritative vocabulary and state model for the
GaussianEdit interface. Product copy, implementation names, tests, and agent
reports must use these terms consistently.

## Workspaces

There are exactly three workspaces:

| Workspace | Purpose | Input owner |
| --- | --- | --- |
| **Scene** | Explore the source scene, discover targets, and freeze a visible-side selection | Pointer-lock mouse look, target click, and `WASD`/`QE` |
| **2D Mask** | Inspect and edit the frozen image-space object mask | Mask prompts, brush, polygon, and other 2D edit gestures |
| **3D Object** | Inspect the current Gaussian object and continue its workflow | Drag-orbit and wheel zoom |

Exactly one workspace is active and owns workspace input. **Selection is not a
fourth workspace.** It is a substate and control context within the
Scene-to-object workflow.

The Scene workspace has exactly two substates:

- **Exploring** — flight/navigation is active. An existing object draft remains
  intact.
- **Selection view** — the camera is settled for target discovery and visible
  selection. A target click creates an immutable selection frame.

`Resume exploring` changes only the Scene substate. It never clears or replaces
the object draft.

## Interface objects

| Name | Definition |
| --- | --- |
| **Workspace Controller** | The single authority for the active workspace, input ownership, main-viewport content, Workspace controls, and Postcard deck. No other component may independently switch workspaces or route workspace input. Pipeline progress remains separate from this controller. |
| **Main viewport** | The large central surface owned by the active workspace. It shows only that workspace's primary interaction. |
| **Postcard deck** | A persistent left stack containing exactly the two inactive workspaces. The active workspace is never duplicated in the deck. A missing workspace artifact remains visible but honestly disabled. Clicking a postcard activates that exact workspace. |
| **Workspace controls** | The right-side panel containing only controls for the active workspace. Scene targeting controls appear only when relevant to Scene Selection view; 2D tools belong to 2D Mask; orbit/object controls belong to 3D Object. |
| **2D Mask Editor** | The 2D Mask workspace's content in the Main viewport. Its tools live in Workspace controls; it is not another workspace or a modal. `Edit mask` activates 2D Mask. |
| **3D Object Inspector/Editor** | The 3D Object workspace's content in the Main viewport. Its tools live in Workspace controls; it is not another workspace or a modal. `Edit object` activates 3D Object. |
| **Targeting method** | One of Auto object, Color fill, or Radius. These are methods used inside Scene Selection view, not workspaces or workspace states. |
| **Global status panel** | A compact persistent panel for scene/load state, GPU and backend health, the active workspace, and cross-workspace real-unit progress. It is not a second control drawer. |
| **Stage rail** | The ordered pipeline display: `Select visible side` → `Scan all sides` → `Fix if needed` → `Dock object`. It reports object progress; it is not workspace navigation. |
| **Selection frame** | The immutable captured Scene view used by the click, detector guidance, SAM, the 2D mask, 3D lift, highlight, and scan seed. Workspace navigation never mutates it. |
| **Object draft** | The one undocked object currently being selected, edited, scanned, or prepared for docking. One draft represents one object. Only explicit `Clear` / `Abandon current object` destroys it. |
| **`Use this object`** | The confirmation action for the exact visible 3D Gaussian selection and its current frame/mask/selection revision. It starts all-sides work while 3D Object remains in the main viewport. It does not dock or extract the object. |
| **Dock** | The persistent cargo area. `Dock object` performs clipboard-style CUT semantics: exact selected Gaussian IDs leave the source scene only after successful docking. |
| **Cargo** | A docked object containing the exact Gaussian IDs, confidence/provenance needed for display, original transform, and return information. |
| **Update banner** | The in-app notice identifying the exact loaded candidate or stable build and its user-verifiable changes. A newer candidate requires an explicit reload. |
| **Review checklist** | Candidate-specific feedback items in the update banner. Every item has exactly one state: `PENDING`, `OK`, or `ISSUE`, plus an optional note that survives state changes. It is unrelated to the pipeline's `Fix if needed` stage. |

## Navigation

- `Tab` cycles workspaces in the fixed order Scene → 2D Mask → 3D Object →
  Scene. `Shift+Tab` traverses the same order in reverse.
- Tab navigation changes workspaces, never Scene substates.
- Disabled workspaces are skipped without changing the fixed order.
- Direct postcard activation goes to the selected workspace, not to a
  state-dependent shortcut.
- `Edit mask` and `Edit object` activate their exact workspaces. Postcards
  provide navigation and status only; they never contain editing tools.
- Workspace switching preserves the selection frame, object draft, and each
  workspace's last relevant substate.

Reserve modal dialogs for genuinely blocking decisions. Editors and ordinary
workspace controls never appear as modal dialogs.

## Authoritative transitions

| Event | Main workspace afterward | Required state change |
| --- | --- | --- |
| App opens with a scene | Scene | Scene starts in Exploring; unavailable 2D Mask and 3D Object postcards are disabled. |
| Enter selection posture | Scene | Scene changes from Exploring to Selection view. |
| Click a target | Scene, then 2D Mask when ready | Freeze the exact Scene into a selection frame, produce the visible mask and lift, then automatically promote the ready 2D Mask to the main viewport. |
| User activates the 3D result | 3D Object | Promote the actual lifted/refined Gaussian draft into the main viewport; 2D Mask becomes an inactive postcard. |
| Choose `Use this object` | 3D Object | Confirm the exact current revision and begin ordered all-sides work. 3D Object remains main while rendering, tracking, and adding to 3D proceed. |
| Press `Tab` / `Shift+Tab` | Next available workspace | Change workspace only. Do not change Exploring versus Selection view, abandon the draft, or invalidate the selection frame. |
| Choose `Resume exploring` | Scene | Change Scene to Exploring without abandoning the object draft or its frozen selection frame. |
| Open 2D Mask without editing | 2D Mask | Preserve confirmation and any safely isolated all-sides work. |
| Make an actual 2D mask edit | 2D Mask | Cancel and invalidate the affected scan revision, clear `Use this object` confirmation, relift the edited mask, and require confirmation again. |
| Choose `Dock object` successfully | 3D Object or Scene according to the explicit dock transition | Move the exact selected IDs from the source scene into cargo. Failure or cancellation is a no-op. |
| Choose `Clear` / `Abandon current object` | Scene | Destroy the draft explicitly and disable unavailable 2D Mask and 3D Object workspaces. |

## Workspaces versus pipeline stages

Workspaces answer **where the user is working**. Pipeline stages answer **how
far the current object has progressed**. They are independent:

- The 3D Object workspace can remain active while the stage rail advances
  through `Scan all sides`.
- Scene can be active while isolated all-sides work continues.
- 2D Mask can be viewed without changing the stage; an actual edit invalidates
  the affected scan revision.
- `Fix if needed` is a persisted uncertainty gate, not a workspace and not the
  update banner's review checklist.

Never create a Selection workspace, use stage names as tabs, put the active
workspace in the postcard deck, bypass the Workspace Controller, or move
workspace-specific controls into the Global status panel.
