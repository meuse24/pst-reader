import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  worker: {
    format: 'iife',
  },
  resolve: {
    alias: {
      fs: path.resolve(__dirname, 'src/fs-shim.ts'),
      zlib: 'browserify-zlib',
      stream: 'stream-browserify',
      util: 'util',
      assert: 'assert',
      events: 'events',
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
})
