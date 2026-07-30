import { defineConfig } from 'vite';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

function randomDemoPly() {
  let selected = null;
  let filesByName = new Map();
  return {
    name: 'random-downloads-ply',
    configureServer(server) {
      const downloads = join(homedir(), 'Downloads');
      const productDefault = join(
        downloads,
        'Nelson Ghost Town, Water Tower, Las Vegas NV (XGRIDS PortalCam)',
        'scene.ply',
      );
      const files = readdirSync(downloads, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ply'))
        .map((entry) => join(downloads, entry.name));
      if (existsSync(productDefault)) files.unshift(productDefault);
      filesByName = new Map(files.map((file) => [
        file.split(/[\\/]/).pop().toLowerCase(),
        file,
      ]));
      const configuredDemo = process.env.GAUSSIANEDIT_DEMO_PLY?.trim();
      selected = configuredDemo && existsSync(configuredDemo)
        ? configuredDemo
        : existsSync(productDefault)
          ? productDefault
          : files.find((file) => file.toLowerCase().endsWith('gaussianedit_demo_scene.ply'))
            ?? (files.length ? files[Math.floor(Math.random() * files.length)] : null);
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
  plugins: [randomDemoPly()],
  server: {
    headers: {
      // Required for SharedArrayBuffer (multi-threaded WASM fallback in onnxruntime-web).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api/sam-tracking': {
        target: 'http://127.0.0.1:8091',
        changeOrigin: false,
      },
      '/api/object-detection': {
        target: 'http://127.0.0.1:8091',
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});
