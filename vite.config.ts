import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits sw.js listing every built file, so the app keeps working offline after
 * the first visit. The cache name changes whenever any file changes.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: 'offline-service-worker',
    apply: 'build',
    // Run after Vite writes the HTML pages, so they are in the bundle too.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map')).sort();
      const hash = createHash('sha256');
      for (const f of files) {
        const item = bundle[f];
        hash.update(f);
        hash.update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      const version = hash.digest('hex').slice(0, 12);
      // index.html (the landing page) is served as "./"; files copied from public/ are not in the bundle, so list them here.
      const precache = ['./', './icon.svg', './manifest.webmanifest', ...files.filter((f) => f !== 'index.html').map((f) => `./${f}`)];
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `// Generated at build time by vite.config.ts.
const CACHE = 'flow-visualizer-${version}';
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('flow-visualizer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Page: try the network for the newest version, fall back to the cached copy offline.
    event.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))));
    return;
  }
  // Built files have content hashes in their names, so a cached copy is always right.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`,
      });
    },
  };
}

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  // A classic (non-module) worker loads in older Firefox and Safari too.
  worker: { format: 'iife' },
  // Syntax older browsers can parse: roughly Chrome/Edge 87+, Firefox 78+, Safari 14+.
  build: {
    target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'],
    // Two pages: the landing page and the editor.
    rollupOptions: { input: { main: 'index.html', app: 'app.html' } },
  },
  plugins: [offlineServiceWorker()],
});
