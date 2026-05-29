import { defineConfig } from 'vite';

const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  worker: { format: 'es' },
  // Two top-level pages: the normal game at /index.html and an
  // AI-debug build at /debug.html (own boot script, wireframe-only
  // rendering, lobby skipped). Both bundle on `vite build`.
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'index.html',
        debug: 'debug.html',
      },
    },
  },
  optimizeDeps: { include: ['three', 'three-mesh-bvh'] },
  // Forward /ai → ai-server (3030), /lobby → session-server (3040),
  // /game → game-server (3050), and /world → game-server (3050) so the
  // dev experience matches the Docker build, where nginx does the same
  // routing. Both client modules call same-origin paths; this proxy
  // makes those paths land on the right local Node process.
  //
  // /game/stream is a Server-Sent Events endpoint — disable proxy
  // buffering on it (via the configure hook) so the connection stays
  // open through quiet ticks instead of being closed by vite after the
  // default response window.
  server: {
    proxy: {
      '/ai':    { target: 'http://localhost:3030', changeOrigin: false },
      '/lobby': { target: 'http://localhost:3040', changeOrigin: false },
      '/game':  {
        target: 'http://localhost:3050',
        changeOrigin: false,
        ws: false,
        // Long timeout so /game/stream survives between snapshots.
        configure: (proxy: { on: (ev: string, cb: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Connection', 'keep-alive');
          });
        },
        timeout: 60 * 60 * 1000,
        proxyTimeout: 60 * 60 * 1000,
      },
      '/world': { target: 'http://localhost:3050', changeOrigin: false },
    },
  },
});
