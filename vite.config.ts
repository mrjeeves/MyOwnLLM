import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pull the package version once at config-eval time. Surfaced in the
// browser as `__APP_VERSION__` so the Cloud Mesh's Capabilities
// blob can advertise which build this peer is running — peers on
// older / newer versions see a tag on each Connections-card row
// alongside the feature matrix. Reading package.json directly
// avoids needing a separate constants module to keep in sync.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { version?: string };
const APP_VERSION = pkg.version ?? "dev";

// Trystero ships one signaling strategy per import path (nostr,
// torrent, mqtt, firebase, ipfs, supabase). Runtime switching means
// loading multiple builds, which roughly doubles the bundle for a
// rarely-toggled setting — so we pick at build time instead. The
// default stays Nostr (Phase 1 + Phase 2 default; works without
// extra credentials, no AWS/Firebase project to register, public
// relay pool). Override with `VITE_TRYSTERO_STRATEGY=torrent pnpm
// build` to bundle the WebTorrent tracker path for environments
// where Nostr relays are blocked.
const TRYSTERO_STRATEGY =
  (process.env.VITE_TRYSTERO_STRATEGY || "nostr").trim().toLowerCase();
const KNOWN_STRATEGIES = ["nostr", "torrent", "mqtt", "firebase", "ipfs", "supabase"];
if (!KNOWN_STRATEGIES.includes(TRYSTERO_STRATEGY)) {
  throw new Error(
    `VITE_TRYSTERO_STRATEGY=${TRYSTERO_STRATEGY} is not one of ${KNOWN_STRATEGIES.join(", ")}`,
  );
}

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  // Force the browser export of `svelte` so production builds get the
  // client-side `mount()` rather than the SSR stub (which throws
  // `lifecycle_function_unavailable` and leaves the WebView blank).
  resolve: {
    conditions: ["browser", "module", "import", "default"],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __TRYSTERO_STRATEGY__: JSON.stringify(TRYSTERO_STRATEGY),
  },
  build: {
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
