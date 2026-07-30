import { defineConfig } from 'vite';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const trackerOrigin = process.env.GAUSSIANEDIT_TRACKER_ORIGIN?.trim();
const trackerStartupIssue = process.env.GAUSSIANEDIT_TRACKER_STARTUP_ISSUE?.trim();

function unavailableTracker() {
  return {
    name: 'unavailable-sam-tracker',
    configureServer(server) {
      if (trackerOrigin) return;
      server.middlewares.use('/api/sam-tracking', (request, response) => {
        if (request.url?.startsWith('/capabilities')) {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({
            temporalTracking: false,
            status: 'startup-error',
            detail: trackerStartupIssue
              || 'Start the app with npm run dev to launch the SAM 3.1 service.',
            provider: 'official-meta-sam3',
            modelId: 'facebook/sam3.1',
            family: 'sam3.1',
            device: 'unavailable',
            completeSequenceRequired: true,
          }));
          return;
        }
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          detail: trackerStartupIssue || 'SAM 3.1 tracking service is unavailable',
        }));
      });
      server.middlewares.use('/api/object-detection', (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        if (request.url?.startsWith('/capabilities')) {
          response.statusCode = 200;
          response.end(JSON.stringify({
            available: false,
            status: 'startup-error',
            detail: trackerStartupIssue
              || 'Start the app with npm run dev to launch the GPU model service.',
            provider: 'yolo12s-refined',
            modelId: 'yolo12s.pt',
            family: 'yolo12',
            device: 'unavailable',
          }));
          return;
        }
        response.statusCode = 503;
        response.end(JSON.stringify({
          detail: trackerStartupIssue || 'GPU model service is unavailable',
        }));
      });
    },
  };
}

function randomDemoPly() {
  let selected = null;
  let filesByName = new Map();
  return {
    name: 'random-downloads-ply',
    configureServer(server) {
      const downloads = join(homedir(), 'Downloads');
      const developmentDefault = join(
        downloads,
        'blender livingroom',
        'scene.ply',
      );
      const productDefault = join(
        downloads,
        'Nelson Ghost Town, Water Tower, Las Vegas NV (XGRIDS PortalCam)',
        'scene.ply',
      );
      const files = readdirSync(downloads, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ply'))
        .map((entry) => join(downloads, entry.name));
      if (existsSync(developmentDefault)) files.unshift(developmentDefault);
      if (existsSync(productDefault)) files.unshift(productDefault);
      filesByName = new Map(files.map((file) => [
        file.split(/[\\/]/).pop().toLowerCase(),
        file,
      ]));
      const configuredDemo = process.env.GAUSSIANEDIT_DEMO_PLY?.trim();
      selected = configuredDemo && existsSync(configuredDemo)
        ? configuredDemo
        : existsSync(developmentDefault)
          ? developmentDefault
          : existsSync(productDefault)
            ? productDefault
            : files.find((file) => file.toLowerCase().endsWith('gaussianedit_demo_scene.ply'))
              ?? (files.length ? files[Math.floor(Math.random() * files.length)] : null);
      if (!existsSync(developmentDefault)) {
        console.warn(
          `[demo] development default is missing: ${developmentDefault}; `
          + 'falling back to another Downloads .ply or drag-and-drop',
        );
      }
      if (selected) console.log(`[demo] auto-loading ${selected}`);
      else console.log(`[demo] no .ply files found in ${downloads}`);

      const requestedDemo = (request) => {
        const requested = new URL(request.url, 'http://localhost').searchParams.get('file');
        if (!requested) return selected;
        const safeName = basename(requested);
        const liveFile = join(downloads, safeName);
        if (safeName === requested
          && safeName.toLowerCase().endsWith('.ply')
          && existsSync(liveFile)) {
          filesByName.set(safeName.toLowerCase(), liveFile);
          return liveFile;
        }
        return filesByName.get(requested.toLowerCase()) ?? selected;
      };

      server.middlewares.use('/__demo__/info', (request, response) => {
        const demo = requestedDemo(request);
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(demo ? {
          filename: demo.split(/[\\/]/).pop(),
          bytes: statSync(demo).size,
        } : null));
      });
      server.middlewares.use('/__demo__/random.ply', (request, response) => {
        const demo = requestedDemo(request);
        if (!demo) {
          response.statusCode = 404;
          response.end('No .ply file found in Downloads');
          return;
        }
        const stat = statSync(demo);
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Length', stat.size);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        createReadStream(demo).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [unavailableTracker(), randomDemoPly()],
  server: {
    headers: {
      // Required for SharedArrayBuffer (multi-threaded WASM fallback in onnxruntime-web).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api/sam-tracking': {
        target: trackerOrigin || 'http://127.0.0.1:8091',
        changeOrigin: false,
      },
      '/api/object-detection': {
        target: trackerOrigin || 'http://127.0.0.1:8091',
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});
