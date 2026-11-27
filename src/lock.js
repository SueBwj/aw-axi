import { open, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "axi-sdk-js";

export async function withLock(stateDir, name, fn) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(await realpath(stateDir), `${name}.lock`);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new AxiError(
          "An activitywatch-axi lock already exists.",
          "LOCK_HELD",
          ["Wait for that command to finish, then retry. After a crash, confirm no command is running before manually removing the lock. The server itself was not locked."],
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
