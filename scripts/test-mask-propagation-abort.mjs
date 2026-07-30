import assert from 'node:assert/strict';

import { TemporalSamTrackingProvider } from '../maskPropagation.js';

const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function fakeCanvas() {
  return {
    toBlob(callback) {
      queueMicrotask(() => callback(new Blob(['seed'], { type: 'image/png' })));
    },
  };
}

function stagedBranch(id = 'view-1') {
  return new Map([[
    'orbit',
    [{
      view: { id, yawDegrees: 10, elevationDegrees: 0 },
      blob: new Blob(['frame'], { type: 'image/jpeg' }),
    }],
  ]]);
}

function beginOptions() {
  return {
    seedCanvas: fakeCanvas(),
    seedMask: new Uint8Array([1, 0, 0, 0]),
    maskW: 2,
    maskH: 2,
    branches: ['orbit'],
    branchFrames: stagedBranch(),
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

async function rejectsAbort(promise) {
  await assert.rejects(promise, (error) => error?.name === 'AbortError');
}

async function testCloseAbortsUpload() {
  const provider = new TemporalSamTrackingProvider({ timeoutMs: 40 });
  let uploadSignal = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/sessions') && options.method === 'POST') {
      uploadSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
  };

  const begin = provider.begin(beginOptions());
  await waitFor(() => uploadSignal, 'session upload did not begin');
  await provider.close();
  assert.equal(uploadSignal.aborted, true);
  await rejectsAbort(begin);
  assert.equal(provider.hasSession('orbit'), false);
}

async function testLateUploadResultIsDeleted() {
  const provider = new TemporalSamTrackingProvider({ timeoutMs: 40 });
  let uploadSignal = null;
  let resolveUpload;
  const deleted = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/sessions') && options.method === 'POST') {
      uploadSignal = options.signal;
      return new Promise((resolve) => {
        resolveUpload = resolve;
        // Deliberately ignore the signal: the server may finish creating a
        // session at the same instant the browser aborts its upload.
      });
    }
    if (options.method === 'DELETE') {
      deleted.push(url);
      return jsonResponse({ isSuccess: true });
    }
    throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
  };

  const begin = provider.begin(beginOptions());
  await waitFor(() => uploadSignal, 'late upload did not begin');
  await provider.close();
  resolveUpload(jsonResponse({ sessionId: 'session-created-late' }));
  await rejectsAbort(begin);
  await waitFor(() => deleted.length === 1, 'late backend session was not deleted');
  assert.deepEqual(
    deleted,
    ['/api/sam-tracking/sessions/session-created-late'],
  );
}

async function testCloseAbortsFrameAndDeletesSession() {
  const provider = new TemporalSamTrackingProvider({ timeoutMs: 40 });
  let frameSignal = null;
  const deleted = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/sessions') && options.method === 'POST') {
      return jsonResponse({ sessionId: 'session-live' });
    }
    if (url.endsWith('/frames') && options.method === 'POST') {
      frameSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    if (options.method === 'DELETE') {
      deleted.push(url);
      return jsonResponse({ isSuccess: true });
    }
    if (!options.method || options.method === 'GET') {
      return jsonResponse({ phase: 'tracking' });
    }
    throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
  };

  assert.equal(await provider.begin(beginOptions()), true);
  const propagate = provider.propagate({
    canvas: fakeCanvas(),
    guidance: {
      positive: [{ x: 1, y: 1 }],
      negative: [],
      reference: [],
      projectedAreaRatio: 0.1,
    },
    branch: 'orbit',
    view: { id: 'view-1' },
    onProgress: () => {},
  });
  await waitFor(() => frameSignal, 'frame request did not begin');
  await provider.close();
  assert.equal(frameSignal.aborted, true);
  await rejectsAbort(propagate);
  assert.deepEqual(
    deleted,
    ['/api/sam-tracking/sessions/session-live'],
  );
  assert.equal(provider.hasSession('orbit'), false);
}

async function testLateFrameResultFailsClosed() {
  const provider = new TemporalSamTrackingProvider({ timeoutMs: 40 });
  let resolveFrame;
  const deleted = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/sessions') && options.method === 'POST') {
      return jsonResponse({ sessionId: 'session-stale' });
    }
    if (url.endsWith('/frames') && options.method === 'POST') {
      return new Promise((resolve) => {
        resolveFrame = resolve;
        // Deliberately ignore options.signal to emulate a transport that
        // delivers a response after local cancellation.
      });
    }
    if (options.method === 'DELETE') {
      deleted.push(url);
      return jsonResponse({ isSuccess: true });
    }
    if (!options.method || options.method === 'GET') {
      return jsonResponse({ phase: 'tracking' });
    }
    throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
  };

  assert.equal(await provider.begin(beginOptions()), true);
  const propagate = provider.propagate({
    canvas: fakeCanvas(),
    guidance: {
      positive: [],
      negative: [],
      reference: [],
      projectedAreaRatio: 0,
    },
    branch: 'orbit',
    view: { id: 'view-1' },
  });
  await waitFor(() => resolveFrame, 'late frame request did not begin');
  await provider.close();
  resolveFrame(jsonResponse({
    mask: { w: 2, h: 2, runs: [0, 1] },
    score: 0.99,
  }));
  await rejectsAbort(propagate);
  assert.equal(deleted.length, 1);
}

async function testPartialBeginCleansCreatedSession() {
  const provider = new TemporalSamTrackingProvider({ timeoutMs: 40 });
  const deleted = [];
  const options = {
    ...beginOptions(),
    branches: ['left', 'right'],
    branchFrames: new Map([
      ['left', stagedBranch().get('orbit')],
      ['right', stagedBranch('view-2').get('orbit')],
    ]),
  };
  let uploads = 0;
  globalThis.fetch = async (url, request = {}) => {
    if (url.endsWith('/sessions') && request.method === 'POST') {
      uploads++;
      return uploads === 1
        ? jsonResponse({ sessionId: 'session-partial' })
        : jsonResponse({ detail: 'failed' }, 500);
    }
    if (request.method === 'DELETE') {
      deleted.push(url);
      return jsonResponse({ isSuccess: true });
    }
    throw new Error(`Unexpected fetch: ${request.method || 'GET'} ${url}`);
  };

  await assert.rejects(
    provider.begin(options),
    /Tracker session failed \(500\)/,
  );
  assert.deepEqual(
    deleted,
    ['/api/sam-tracking/sessions/session-partial'],
  );
  assert.equal(provider.sessions.size, 0);
}

try {
  await testCloseAbortsUpload();
  await testLateUploadResultIsDeleted();
  await testCloseAbortsFrameAndDeletesSession();
  await testLateFrameResultFailsClosed();
  await testPartialBeginCleansCreatedSession();
  console.log('temporal tracking abort lifecycle: ok');
} finally {
  globalThis.fetch = originalFetch;
}
