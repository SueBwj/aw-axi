import { open, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "axi-sdk-js";

export async function withLock(stateDir, name, fn) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, `${name}.lock`);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await dropStaleLock(lockPath);
      if (Date.now() > deadline) {
        throw new AxiError(
          "Another activitywatch-axi process holds the local lock.",
          "LOCK_HELD",
          ["Wait for that command to finish, then retry. The server itself was not locked."],
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await handle.writeFile(token);
    return await fn();
  } finally {
    await handle.close();
    try {
      const current = await readFile(lockPath, "utf8");
      if (current === token) await rm(lockPath, { force: true });
    } catch {
      // The lock file is already gone.
    }
  }
}

async function dropStaleLock(lockPath) {
  let text;
  try {
    text = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  const pid = Number(String(text).split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (pidAlive(pid)) return;
  await rm(lockPath, { force: true }).catch(() => {});
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
