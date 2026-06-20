/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PKG: string;
  readonly VITE_LEAGUE: string;
  readonly VITE_SUB_REGISTRY: string;
  readonly VITE_ENOKI_API_KEY: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
