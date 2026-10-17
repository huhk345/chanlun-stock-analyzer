import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/** 分析后端地址 (server/index.ts 默认 :8899); 端口被占用时可用环境变量改道 */
const ANALYSIS_API_TARGET = process.env.ANALYSIS_API_TARGET || 'http://localhost:8899';

const proxy = {
  '/api': {
    target: ANALYSIS_API_TARGET,
    changeOrigin: true,
  },
  // 缠论买卖点扫描: 扫描请求与结果都走同源 /ws, 避免浏览器直连分析后端
  '/ws': {
    target: ANALYSIS_API_TARGET,
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 8888,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'recharts', 'lightweight-charts'],
        },
      },
    },
  },
});
