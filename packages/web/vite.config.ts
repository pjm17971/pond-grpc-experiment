import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// `base` matches the GitHub Pages subpath
// (https://pjm17971.github.io/pond-ts-dashboard/) so built asset URLs
// resolve correctly. Dev server stays at root.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/pond-ts-dashboard/' : '/',
}))
