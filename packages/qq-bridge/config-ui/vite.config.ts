import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    // 3000/3001 是 SnowLuma 的端口，避开；CLI 传入的 --port 会覆盖这里
    port: 3411,
    proxy: {
      // 桥接的本地配置接口（只监听 127.0.0.1，见 CONFIG-UI.md 第 5 节）。
      // 走 dev server 代理，避免浏览器跨域问题。
      '/api': {
        target: 'http://127.0.0.1:3410',
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
