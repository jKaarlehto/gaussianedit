// This is the single source of truth for the in-app build notice.
// Keep the notes short and describe behavior a user can actually verify.
export const releaseMetadata = Object.freeze({
  id: '2026.07.30-rc2',
  status: 'candidate',
  publishedAt: '2026-07-30T20:22:03+03:00',
  notes: Object.freeze([
    'The cockpit stays visible without black blinks while selecting and capturing all sides.',
    'The scan tray shows each real RGB view and exact mask, overlaps them, flashes twice, then transfers into the hologram.',
    'The 2D mask postcard docks on the left, and Edit starting mask opens a usable mask editor.',
    'Ambiguous angles offer Keep, Skip, and Edit; candidate checks and comments persist in the update banner.',
  ]),
  reviewItems: Object.freeze([
    Object.freeze({
      id: 'no-black-capture',
      label: 'The cockpit never blinks black during selection or all-sides capture.',
    }),
    Object.freeze({
      id: 'tray-evidence-choreography',
      label: 'Each tray item shows real RGB, its exact mask, full overlap, two flashes, and transfer.',
    }),
    Object.freeze({
      id: 'mask-postcard-edit',
      label: 'The 2D mask postcard docks left and Edit starting mask is usable.',
    }),
    Object.freeze({
      id: 'ambiguity-actions-feedback',
      label: 'Ambiguous angles offer Keep, Skip, and Edit, and this feedback persists.',
    }),
  ]),
});
