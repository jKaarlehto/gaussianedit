// This is the single source of truth for the in-app build notice.
// Keep the notes short and describe behavior a user can actually verify.
export const releaseMetadata = Object.freeze({
  id: '2026.07.30-rc3',
  status: 'candidate',
  publishedAt: '2026-07-30T22:59:12+03:00',
  notes: Object.freeze([
    'The selected mask and highlight stay aligned; orbit hides the 2D raster, and Return to captured view restores the exact pose without a jump.',
    'TARGET stays animated with current-frame YOLO hover and target-centered orbit and zoom; pan and flight stay blocked, with no YOLO in Mask or 3D Object.',
    'The wider 3D card has no edge slivers; hover freezes its exact orientation, then unhover or promotion resumes the same phase.',
    'Retargeting highlights the candidate first, then shows one compact SWITCH TARGET? Replace/Cancel choice without overlapping acquired and new-target HUDs.',
  ]),
  reviewItems: Object.freeze([
    Object.freeze({
      id: 'selection-return-alignment',
      label: 'Does orbit hide the aligned 2D raster, then Return to captured view restore the exact pose without a jump?',
    }),
    Object.freeze({
      id: 'target-controls-yolo',
      label: 'Does TARGET keep current-frame YOLO hover and target-centered orbit/zoom while blocking pan, flight, and YOLO in Mask or 3D Object?',
    }),
    Object.freeze({
      id: 'object-card-continuity',
      label: 'Is the wider 3D card free of slivers, with hover pausing exactly and unhover or promotion resuming the same phase?',
    }),
    Object.freeze({
      id: 'retarget-single-decision',
      label: 'Does retargeting highlight first, then show one compact SWITCH TARGET? Replace/Cancel choice without overlapping HUDs?',
    }),
  ]),
});
