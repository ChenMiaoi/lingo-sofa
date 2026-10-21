import { resolve } from "node:path";
import { createServer } from "vite";

// Vite runs under Node; the desktop runner waits for this owned server to listen.
const server = await createServer({
  configFile: resolve(import.meta.dirname, "../apps/desktop/vite.config.ts"),
});
await server.listen();
server.printUrls();
process.send?.("lingo-sofa:dev-ready");
