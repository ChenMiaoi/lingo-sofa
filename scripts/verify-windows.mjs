import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { installWindowsBundle } from "./windows/install.ts";

const payload = resolve(process.argv[2]);
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows smoke test requires Windows x64");
// Upstream identifies running clients by branch name. Never let a fixture patch kill a real client.
const tasks = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
  encoding: "utf8",
  windowsHide: true,
});
if (/^"DiscordCanary\.exe"/im.test(tasks))
  throw new Error(
    "Close Discord Canary before running the isolated installer smoke test",
  );
const work = await mkdtemp(join(tmpdir(), "lingo-windows-smoke-"));
const home = join(work, "home");
const target = join(work, "DiscordCanary");
const settings = join(work, "settings/settings.json");
const resources = join(target, "app-1.0.0/resources");
try {
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(resources, "app.asar"),
    "fixture Discord, not a real client",
  );
  const options = {
    payload,
    home,
    target,
    settings,
    run: async (file, args, env) => {
      execFileSync(file, args, {
        env: { ...env, LOCALAPPDATA: work, APPDATA: work },
        windowsHide: true,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    },
  };
  if (process.argv[3]) {
    // Observe whether restart happens before or after patching, without launching a real client.
    const launcher = join(work, "restart.go");
    await writeFile(
      launcher,
      `package main
import("os";"path/filepath";"bytes")
func main(){root,_:=os.Executable();root=filepath.Dir(root);data,_:=os.ReadFile(filepath.Join(root,"app-1.0.0","resources","app.asar"));result:="unpatched";if bytes.Contains(data,[]byte("patcher.js")){result="patched"};os.WriteFile(filepath.Join(root,"restart-marker"),[]byte(result),0600)}
`,
    );
    execFileSync("go", ["build", "-o", join(target, "Update.exe"), launcher], {
      windowsHide: true,
    });
    execFileSync(
      resolve(process.argv[3]),
      [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/RESTARTDISCORD=1",
        `/DISCORDDIR=${target}`,
        `/LOG=${join(work, "setup.log")}`,
      ],
      {
        env: {
          ...process.env,
          LINGO_SOFA_HOME: home,
          APPDATA: work,
          LOCALAPPDATA: work,
        },
        windowsHide: true,
        timeout: 900_000,
      },
    );
    const marker = join(target, "restart-marker");
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        if ((await readFile(marker, "utf8")) !== "patched")
          throw new Error("Discord restarted before installation completed");
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
    const invalid = join(work, "InvalidDiscordCanary");
    await mkdir(invalid);
    await copyFile(join(target, "Update.exe"), join(invalid, "Update.exe"));
    let failureCode = 0;
    try {
      execFileSync(
        resolve(process.argv[3]),
        [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
          "/RESTARTDISCORD=1",
          `/DISCORDDIR=${invalid}`,
        ],
        {
          env: {
            ...process.env,
            LINGO_SOFA_HOME: join(work, "failure-home"),
            APPDATA: work,
            LOCALAPPDATA: work,
          },
          windowsHide: true,
          timeout: 900_000,
        },
      );
    } catch (error) {
      failureCode = error.status;
    }
    if (!failureCode) throw new Error("Failed installation returned success");
    try {
      await readFile(join(invalid, "restart-marker"));
      throw new Error("Failed installation restarted Discord");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } else {
    await installWindowsBundle(options);
  }
  const state = JSON.parse(
    await readFile(join(home, "windows-install.json"), "utf8"),
  );
  const runtime = JSON.parse(
    await readFile(join(home, "runtime-install.json"), "utf8"),
  );
  if (state.version !== runtime.version || !runtime.executable.startsWith(home))
    throw new Error(
      "Combined installation version or runtime location mismatch",
    );
  const patch = await readFile(join(resources, "app.asar"));
  if (!patch.includes(Buffer.from("patcher.js")))
    throw new Error("Missing actual Vencord patch");
  await writeFile(join(home, "accounts.json"), '{"fixture":"retained"}');
  // The direct helper run additionally covers repair/reinstallation of the already patched client.
  if (!process.argv[3]) await installWindowsBundle(options);
  if (
    (await readFile(join(home, "accounts.json"), "utf8")) !==
    '{"fixture":"retained"}'
  )
    throw new Error("Reinstallation changed existing accounts");
  console.log(
    "Windows combined installation and reinstallation passed against isolated Discord resources.",
  );
} finally {
  // work is the exact directory returned by mkdtemp, never a discovered Discord installation.
  await rm(work, { recursive: true, force: true });
}
