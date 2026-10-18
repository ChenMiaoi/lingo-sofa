import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Use a unique host name so tests cannot replace the installed LingoSofa host. */
export async function registerNativeFixture(
  profile: string,
  manifest: {
    name: string;
    description: string;
    path: string;
    type: "stdio";
    allowed_origins: string[];
  },
) {
  if (!/^com\.lingosofa\.test_[a-f0-9]{32}$/.test(manifest.name))
    throw Error("Native fixtures require a unique test host name");
  const directory = join(profile, "NativeMessagingHosts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${manifest.name}.json`);
  await writeFile(path, JSON.stringify(manifest), { flag: "wx" });
  if (process.platform !== "win32")
    return async () => rm(path, { force: true });
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${manifest.name}`;
  let exists = true;
  try {
    await execute("reg", ["QUERY", key, "/ve"], { windowsHide: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    exists = false;
  }
  if (exists) throw Error("Native fixture registration already exists");
  await execute("reg", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", path], {
    windowsHide: true,
  });
  return async () => {
    const current = await execute("reg", ["QUERY", key, "/ve"], {
      windowsHide: true,
      encoding: "utf8",
    });
    const registered = /\sREG_SZ\s+([^\r\n]+)/
      .exec(current.stdout)?.[1]
      ?.trim();
    if (registered !== path)
      throw Error("Native fixture registration changed unexpectedly");
    await execute("reg", ["DELETE", key, "/f"], { windowsHide: true });
  };
}
