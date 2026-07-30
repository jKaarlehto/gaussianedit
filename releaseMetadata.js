// This is the single source of truth for the in-app build notice.
// Keep the notes short and describe behavior a user can actually verify.
export const releaseMetadata = Object.freeze({
  id: '2026.07.30-rc1',
  status: 'candidate',
  publishedAt: '2026-07-30T18:30:00+03:00',
  notes: Object.freeze([
    'Dedicated NVIDIA or AMD graphics are checked before the scene and AI models load.',
    'All-sides scans use a compact object region and release bridge images after backend upload.',
    'Selection undo stores only changed points, and offscreen scans restore the renderer state.',
    'Live development updates reload the page, so finish or stop an active selection before applying one.',
  ]),
});
