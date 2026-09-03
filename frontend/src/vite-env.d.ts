/// <reference types="vite/client" />

/**
 * Environment typings.
 *
 * `VITE_API_BASE` exists so the built frontend can be pointed at a backend on
 * another host. Left unset, the app calls `/api` on its own origin, which is
 * what the Vite dev proxy and the nginx container both serve - so the default
 * path needs no configuration at all.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
