import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Read only LingoSofa's connection descriptor, never Discord credentials or provider keys.
export async function connection(event: unknown) {
  void event;
  const directory =
    process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`;
  try {
    const value = JSON.parse(
      await readFile(resolve(directory, "discord-connection.json"), "utf8"),
    ) as {
      port?: unknown;
      token?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port < 1024 ||
      value.port > 65535 ||
      typeof value.token !== "string" ||
      value.token.length < 32 ||
      value.token.length > 256 ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now()
    )
      return null;
    return { port: value.port, token: value.token };
  } catch {
    return null;
  }
}
