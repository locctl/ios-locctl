/// <reference types="vite/client" />

// Allow importing any file as raw text via Vite's ?raw query.
declare module '*?raw' {
  const content: string
  export default content
}
