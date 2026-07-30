import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';
import { copyUncompressedSplatRow } from '../splatSource.js';

const rows = [
  [1, 2, 3, 0.1, 0.2, 0.3, 1, 0, 0, 0, 11, 22, 33, 244],
  [-4, 5, 6, 0.4, 0.5, 0.6, 0.9238795, 0, 0.3826834, 0, 44, 55, 66, 211],
  [7, -8, 9, 0.7, 0.8, 0.9, 0.7071068, 0.7071068, 0, 0, 77, 88, 99, 199],
];

const sourceAllocation = GS.SplatBuffer.preallocateUncompressed(rows.length, 0);
const source = sourceAllocation.splatBuffer;
const bytesPerSplat = source.sections[0].bytesPerSplat;
for (let row = 0; row < rows.length; row++) {
  GS.SplatBuffer.writeSplatDataToSectionBuffer(
    rows[row],
    source.bufferData,
    sourceAllocation.splatBufferDataOffsetBytes + row * bytesPerSplat,
    0,
    0,
  );
}

const targetAllocation = GS.SplatBuffer.preallocateUncompressed(2, 0);
const target = targetAllocation.splatBuffer;
const targetBytes = new Uint8Array(target.bufferData);
copyUncompressedSplatRow(
  source,
  2,
  targetBytes,
  targetAllocation.splatBufferDataOffsetBytes,
);
copyUncompressedSplatRow(
  source,
  0,
  targetBytes,
  targetAllocation.splatBufferDataOffsetBytes + bytesPerSplat,
);

const sourceBytes = new Uint8Array(source.bufferData);
for (const [targetRow, sourceRow] of [[0, 2], [1, 0]]) {
  const sourceStart = source.sections[0].dataBase + sourceRow * bytesPerSplat;
  const targetStart = target.sections[0].dataBase + targetRow * bytesPerSplat;
  assert.deepEqual(
    targetBytes.slice(targetStart, targetStart + bytesPerSplat),
    sourceBytes.slice(sourceStart, sourceStart + bytesPerSplat),
    `native Gaussian row ${sourceRow} should be byte-identical after copying`,
  );
}

const centre = new THREE.Vector3();
const color = new THREE.Vector4();
target.getSplatCenter(0, centre);
target.getSplatColor(0, color);
assert.deepEqual(
  centre.toArray().map((value) => Math.round(value)),
  [7, -8, 9],
);
assert.deepEqual(color.toArray(), [77, 88, 99, 199]);

console.log('tracking cutout buffer copy: ok');
