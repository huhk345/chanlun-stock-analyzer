import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/** 分析后端地址 (默认 :8899); 端口被占用时可用环境变量改道。后端已从本仓库移除, 需另行启动 */
const ANALYSIS_API_TARGET = process.env.ANALYSIS_API_TARGET || 'http://localhost:8899';

const proxy = {
  // Rust 模拟引擎 (barter-rs): 独立服务, 必须排在 /api 之前 (Vite 按声明顺序匹配)
  '/api/rust': {
    target: process.env.RUST_ENGINE_TARGET || 'http://127.0.0.1:8901',
    changeOrigin: true,
  },
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
    // 端口被占时直接报错，而不是静默换到 8889/8890。
    // 否则旧进程（它的代理目标还是启动那一刻的配置）会一直占着 8888，
    // 新起的进程跑到 8889，浏览器停在 8888 上，看起来就像「后端起了但功能不见了」。
    strictPort: true,
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
