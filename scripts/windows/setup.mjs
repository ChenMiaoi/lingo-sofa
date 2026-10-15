import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
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
async function reportReady(status) {
  const path = process.env.LINGO_SOFA_UPDATE_READY;
  if (!path) return;
  await writeFile(`${path}.tmp`, JSON.stringify(status), "utf8");
  await rename(`${path}.tmp`, path);
}
async function waitForClients() {
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
          if (
            Number.isInteger(connection.port) &&
            connection.port >= 1024 &&
            connection.port <= 65535 &&
            /^[a-f0-9]{64}$/.test(connection.token ?? "")
          ) {
            await globalThis
              .fetch(
                `http://127.0.0.1:${connection.port}/v1/runtime/prepare-update`,
                {
                  method: "POST",
                  headers: {
                    Origin: "https://discord.com",
                    Authorization: `Bearer ${connection.token}`,
                    "Content-Type": "application/json",
                  },
                  body: "{}",
                  signal: globalThis.AbortSignal.timeout(1000),
                },
              )
              .catch(() => undefined);
          }
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
}
try {
  await installWindowsBundle({
    payload: import.meta.dirname,
    home,
    beforeInstall: async () => {
      await reportReady({ ready: true });
      await waitForClients();
    },
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
  await reportReady({
    error: error instanceof Error ? error.message : "安装准备失败",
  });
  await writeFile(
    resultFile,
    error instanceof Error ? error.message : "安装失败",
    "utf8",
  );
  process.exitCode = 1;
}
