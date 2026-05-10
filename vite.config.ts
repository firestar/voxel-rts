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
  build: { target: 'es2022' },
  optimizeDeps: { include: ['three', 'three-mesh-bvh'] },
  // Forward /ai → ai-server (3030) and /lobby → session-server (3040)
  // so the dev experience matches the Docker build, where nginx does
  // the same routing. Both client modules call same-origin paths; this
  // proxy makes those paths land on the right local Node process.
  server: {
    proxy: {
      '/ai':    { target: 'http://localhost:3030', changeOrigin: false },
      '/lobby': { target: 'http://localhost:3040', changeOrigin: false },
    },
  },
});
