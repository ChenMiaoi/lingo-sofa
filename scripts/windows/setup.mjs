import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { installWindowsBundle } from "./install.js";

const execute = promisify(execFile);
const [target, resultFile] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  !target ||
  !resultFile
)
  throw new Error(
    "Windows x64 setup requires a Discord directory and result file",
  );
const home = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
const branch = /(?:ptb|canary|development)$/i.exec(target)?.[0] ?? "";
const selectedDiscord = new RegExp(`^"Discord${branch}\\.exe"`, "im");
try {
  // No process is killed. Let Discord and any browser leases finish before replacing files.
  const deadline = Date.now() + 180_000;
  while (true) {
    const { stdout } = await execute("tasklist", ["/FO", "CSV", "/NH"], {
      windowsHide: true,
    });
    const discordRunning = selectedDiscord.test(stdout);
    let assistantRunning = false;
    try {
      const connection = JSON.parse(
        await readFile(join(home, "runtime-connection.json"), "utf8"),
      );
      if (Number.isInteger(connection.pid) && connection.pid > 0) {
        try {
          process.kill(connection.pid, 0);
          assistantRunning = true;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!discordRunning && !assistantRunning) break;
    if (Date.now() >= deadline)
      throw new Error(
        "请从托盘退出 Discord，并关闭使用本地助手的浏览器，等待助手退出后重试。",
      );
    await setTimeout(1000);
  }
  await installWindowsBundle({
    payload: import.meta.dirname,
    home,
    target: resolve(target),
    settings: join(
      process.env.VENCORD_USER_DATA_DIR ??
        (process.env.DISCORD_USER_DATA_DIR
          ? join(process.env.DISCORD_USER_DATA_DIR, "..", "VencordData")
          : join(process.env.APPDATA, "Vencord")),
      "settings/settings.json",
    ),
    run: async (file, args, env) => {
      await execute(file, args, {
        env,
        windowsHide: true,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    },
  });
  await writeFile(resultFile, "OK", "utf8");
} catch (error) {
  await writeFile(
    resultFile,
    error instanceof Error ? error.message : "安装失败",
    "utf8",
  );
  process.exitCode = 1;
}
