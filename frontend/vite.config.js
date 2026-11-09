import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    // Phone / tunnel clients need long-lived multipart POSTs for voice.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: false,
        timeout: 120_000,
        proxyTimeout: 120_000,
      },
    },
  },
  preview: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: false,
        timeout: 120_000,
        proxyTimeout: 120_000,
      },
    },
  },
});
