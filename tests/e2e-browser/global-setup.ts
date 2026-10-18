import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default async function globalSetup() {
  const directory = await mkdtemp(join(tmpdir(), "lingo-browser-runtime-"));
  const previous = process.env.LINGO_SOFA_HOME;
  // Stable IDs can match a real native registration. Test browsers must never use the user's runtime.
  process.env.LINGO_SOFA_HOME = directory;
  return async () => {
    if (previous === undefined) delete process.env.LINGO_SOFA_HOME;
    else process.env.LINGO_SOFA_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  };
}
