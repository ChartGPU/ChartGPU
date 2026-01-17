/// <reference types="vite/client" />

// Minimal typing for Vite's `?raw` imports, scoped to examples.
declare module '*?raw' {
  const content: string;
  export default content;
}

