/**
 * Update the persistent targeting-source selection. A normal activation
 * replaces the configured source; Shift intentionally combines or removes a
 * source while guaranteeing that at least one source remains configured.
 */
export function updateTargetingSources(currentSources, source, combine = false) {
  const next = new Set(currentSources?.size ? currentSources : ['auto']);
  if (!combine) return new Set([source]);
  if (next.has(source) && next.size > 1) next.delete(source);
  else next.add(source);
  return next;
}
