import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bridgeConfigSchema } from "./config.js";
import { browserRegistration, save } from "./native-registration.mjs";

const extensions = process.argv.slice(2);
if (!extensions.length || extensions.some((id) => !/^[a-p]{32}$/.test(id)))
  throw new Error("Invalid extension ID");
const home = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
// Authorization requires a complete installation and never downloads or replaces it.
await access(join(home, "runtime-install.json"));
await access(
  join(
    home,
    `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
  ),
);
const lock = join(home, ".installer-lock");
await mkdir(lock);
try {
  const config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(join(home, "config.json"), "utf8")),
  );
  config.allowedExtensions = [
    ...new Set([...config.allowedExtensions, ...extensions]),
  ];
  const register = await browserRegistration(home, config);
  try {
    const active = JSON.parse(
      await readFile(join(home, "runtime-connection.json"), "utf8"),
    );
    if (Number.isInteger(active.pid)) {
      try {
        process.kill(active.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        active.pid = null;
      }
      if (active.pid)
        throw new Error("请关闭浏览器与 Discord，等待本地助手退出后重新授权。");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await register();
  await save(join(home, "config.json"), config);
  console.log(
    "浏览器授权完成。重新打开浏览器并检测连接；已有账户和用量已保留。",
  );
} finally {
  await rm(lock, { recursive: true, force: true });
}
