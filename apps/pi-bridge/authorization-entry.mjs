import { cp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export async function installBrowserAuthorization(home, runtime) {
  for (const file of ["authorize-browser.mjs", "native-registration.mjs"])
    await cp(join(import.meta.dirname, file), join(runtime, file));
  if (process.platform !== "win32") {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const launcher = join(home, "Authorize.command");
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quote(join(runtime, "node"))} ${quote(join(runtime, "authorize-browser.mjs"))} "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(launcher, 0o700);
  }
}
