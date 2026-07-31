// This is the single source of truth for the in-app build notice.
// Keep the notes short and describe behavior a user can actually verify.
export const releaseMetadata = Object.freeze({
  id: '2026.07.31-rc4',
  status: 'candidate',
  publishedAt: '2026-07-31T14:25:39+03:00',
  notes: Object.freeze([
    'All-sides scanning now stays on one ordered run and continues after accepted views add new splats.',
    'Pause and Resume stay on that same scan; editing or changing the confirmed seed cancels stale work safely.',
    'Large-object preparation yields between bounded chunks and stops with a clear limit instead of attempting scene-scale work.',
    'The 3D Object controls no longer advertise the disconnected Gaussians display mode.',
  ]),
  reviewItems: Object.freeze([
    Object.freeze({
      id: 'scan-runtime-continues-after-growth',
      label: 'After an accepted view adds splats, does scanning continue through the later angles?',
    }),
    Object.freeze({
      id: 'scan-runtime-pause-resume',
      label: 'Does Pause then Resume continue the same scan without duplicate tray work or restarted counters?',
    }),
    Object.freeze({
      id: 'scan-runtime-cancel-on-edit',
      label: 'Does editing the starting mask stop the scan promptly and require Use this object again?',
    }),
    Object.freeze({
      id: 'object-view-single-mode',
      label: 'Are the disconnected Gaussians toggle and its unavailable-mode message gone from 3D Object?',
    }),
  ]),
});
