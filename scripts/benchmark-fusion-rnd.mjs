import { performance } from 'node:perf_hooks';
import {
  createEvidenceEvent,
  fuseEvidenceFamilies,
  liftContributorEvidence,
} from '../evidenceFusion.js';
import { runBoundedBinaryGraphCut } from '../localGraphCut.js';

let randomState = 0x5eed1234;
function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
}

const pixelCount = Number(process.argv[2] ?? 16_384);
const contributorsPerPixel = Number(process.argv[3] ?? 8);
const gaussianCount = 50_000;
const gaussianIds = new Int32Array(pixelCount * contributorsPerPixel);
const weights = new Float32Array(gaussianIds.length);
const labels = new Uint8Array(pixelCount);
const alpha = new Float32Array(pixelCount);
for (let pixel = 0; pixel < pixelCount; pixel++) {
  labels[pixel] = random() > 0.48 ? 1 : 0;
  let transmittance = 1;
  let accumulated = 0;
  for (let lane = 0; lane < contributorsPerPixel; lane++) {
    const offset = pixel * contributorsPerPixel + lane;
    gaussianIds[offset] = Math.floor(random() * gaussianCount);
    const localAlpha = 0.04 + random() * 0.25;
    weights[offset] = localAlpha * transmittance;
    accumulated += weights[offset];
    transmittance *= 1 - localAlpha;
  }
  alpha[pixel] = Math.min(1, accumulated);
}

const liftStart = performance.now();
const lifted = liftContributorEvidence({
  gaussianIds,
  weights,
  pixelLabels: labels,
  pixelAlpha: alpha,
  contributorsPerPixel,
});
const liftMs = performance.now() - liftStart;

const revision = Object.freeze({ scene: 1, view: 1, selection: 1, mask: 1, scan: 1 });
const event = createEvidenceEvent({
  id: 'fixture-view',
  revision,
  provider: { id: 'fixture', version: '1' },
  causalFamilyId: 'fixture-track',
  observationUnitId: 'fixture-sector',
  target: 'gaussian',
  semantics: 'binary-membership',
  effect: 'membership',
  fields: lifted.fields,
  negativeScope: 'visible-frame',
  provenance: {},
});
const fusionStart = performance.now();
const fused = fuseEvidenceFamilies([event], {
  expectedRevision: revision,
  maxProcessingMs: 5_000,
});
const fusionMs = performance.now() - fusionStart;

const graphNodes = 1_024;
const graphIds = Uint32Array.from({ length: graphNodes }, (_, index) => index);
const foregroundCost = new Float32Array(graphNodes);
const backgroundCost = new Float32Array(graphNodes);
const pairwiseEdges = [];
for (let index = 0; index < graphNodes; index++) {
  const foreground = index < graphNodes / 2;
  foregroundCost[index] = foreground ? 0.1 : 1.4;
  backgroundCost[index] = foreground ? 1.4 : 0.1;
  if (index > 0) pairwiseEdges.push({ a: index - 1, b: index, weight: 0.25 });
}
const graphStart = performance.now();
const cut = runBoundedBinaryGraphCut({
  nodeIds: graphIds,
  foregroundCost,
  backgroundCost,
  pairwiseEdges,
  limits: { maxSolveMs: 1_000 },
});
const graphMs = performance.now() - graphStart;

console.log(JSON.stringify({
  fixture: {
    pixelCount,
    contributorsPerPixel,
    intersections: gaussianIds.length,
    graphNodes,
    graphEdges: pairwiseEdges.length,
  },
  result: {
    touchedGaussians: lifted.fields.ids.length,
    fusedGaussians: fused.ids.length,
    graphIncluded: cut.includedIds.length,
  },
  elapsedMs: {
    contributorLift: +liftMs.toFixed(3),
    familyFusion: +fusionMs.toFixed(3),
    localGraphCut: +graphMs.toFixed(3),
  },
}, null, 2));
