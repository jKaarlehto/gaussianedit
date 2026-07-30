# Scan tray integration

`ScanTray` is a presentation-only FIFO state machine. The scan coordinator owns
rendering, tracking, lifting, and fusion; it reports each real transition to the
tray. A card is appended once and is updated in place:

`rendered view → tracked mask → ready to fuse → particle transfer → removed`

Only the queue head can be mounted, transfer, or leave. A later mask may become
ready early, but its record waits in memory as a 132 × 76 pixel snapshot. The
DOM therefore contains exactly one `.scan-view-pair` at any time—never a
gallery, placeholder row, or collection of hidden cards.

For every view, the visible sequence is:

`real RGB view → real mask beside it → pair overlaps → mask flashes twice → particles fly to hologram → item disappears → next RGB view`

## Exact calls from the scan coordinator

Create one tray for the lifetime of the app:

```js
const scanTray = new ScanTray(ui.scanTray, {
  getFusionTarget: () => ui.objectPreviewViewport.getBoundingClientRect(),
});
```

Start a new scan before generating frames:

```js
scanTray.begin({ id: session.id, total: session.views.length });
```

Immediately after each synthetic frame has actually rendered, copy it into the
tray. `rendered()` copies pixels synchronously, so the source canvas may be
reused afterwards:

```js
scanTray.rendered({
  id: view.id,
  label: view.label,
  canvas: renderedFrameCanvas,
});
```

When temporal tracking returns, update that same item:

```js
scanTray.tracked({
  id: view.id,
  label: view.label,
  mask,
  maskW,
  maskH,
  accepted: !validation.needsReview,
});
```

Call `fuse()` only after the corresponding evidence has been applied to the
3D selection. This queues the visual transfer. The item remains in place until
its mask has been shown and its particle transfer has completed:

```js
scanTray.fuse({ id: view.id, added: addedGaussianCount });
```

For a view that will not contribute:

```js
scanTray.skipped({ id: view.id, reason: 'object not found' });
```

After every scheduled view has reached `fuse()` or `skipped()`, finish the scan.
The tray waits for queued transfers before hiding:

```js
scanTray.finish({ label: 'All sides checked' });
```

Cancellation is immediate and invalidates pending timers/animations:

```js
scanTray.cancel();
```

## Connecting the transfer to the Three.js hologram

The DOM particle cue works from `getFusionTarget` without more integration.
The root also emits lifecycle events so the Three.js preview can synchronize a
short materialization wave with the exact transfer:

```js
ui.scanTray.addEventListener('scan-tray:transfer-start', ({ detail }) => {
  objectPreview.beginEvidenceArrival({
    viewId: detail.id,
    added: detail.added,
    sourceRect: detail.sourceRect,
  });
});

ui.scanTray.addEventListener('scan-tray:transfer-complete', ({ detail }) => {
  objectPreview.completeEvidenceArrival({ viewId: detail.id });
});
```

Available events are:

- `scan-tray:rendered`
- `scan-tray:tracked`
- `scan-tray:transfer-start`
- `scan-tray:transfer-complete`
- `scan-tray:removed`

The events contain only small metadata and rectangles, never mask buffers.
`snapshot()` exposes a small diagnostic view of queue state without DOM reads.
