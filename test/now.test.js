import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "./synthetic-server.js";

const bin = fileURLToPath(new URL("../bin/aw-axi.js", import.meta.url));
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, AWAXI_REFUSE_5600: "1", AWAXI_BASE_URL: "", AWAXI_STATE: "", AWAXI_NOW: "", TZ: "UTC", ...env },
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

test("now rejects non-ISO, invalid dates, and local gaps before server requests", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "aw-axi-now-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = [
    ["timer", "status"], ["timer", "start", "--label", "test", "--state", dir],
    ["timer", "stop", "--label", "test", "--state", dir],
    ["timer", "switch", "--from", "a", "--to", "b", "--state", dir],
    ["totals", "--label", "test"], ["uncategorized", "--server-rules"], ["--tui", "--once"],
  ];
  for (const input of ["November 15, 2026 01:00:00 GMT", "2026-02-29T01:00:00Z", "2026-11-15",
    "2026-13-01T00:00:00Z", "2026-03-08T02:30:00"]) {
    for (const command of commands) {
      for (const source of ["flag", "env"]) {
        const result = await run([...command, "--base-url", server.baseUrl, ...(source === "flag" ? ["--now", input] : [])], {
          TZ: "America/New_York", ...(source === "env" ? { AWAXI_NOW: input } : {}),
        });
        assert.notEqual(result.code, 0, `${command} ${source} ${input}: ${result.output}`);
        assert.match(result.output, /ISO 8601/);
        assert.equal(server.state.requests.length, 0, `${command} ${source} ${input} made a request`);
      }
    }
  }
});

test("commands without a clock override ignore stale AWAXI_NOW", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const env = { AWAXI_NOW: "November 15, 2026", AWAXI_BASE_URL: server.baseUrl };
  for (const [command, expected] of [
    [[], /server: reachable/], [["views", "show"], /browser_fallback: unreadable/],
    [["rules", "show"], /coverage: unsupported/],
  ]) {
    const result = await run(command, env);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, expected);
  }
  const native = await run(["rules", "show", "--native"], env);
  assert.match(native.output, /code: UNSUPPORTED/);
  assert.ok(server.state.requests.some(request => request.path === "/api/0/info"));
});

test("now preserves ISO instants, offsets, and local time for both inputs", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "aw-axi-now-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    ["2024-02-29T01:00:00Z", "2024-02-29T01:00:00.000Z"],
    ["2026-11-15T09:30:00+08:30", "2026-11-15T01:00:00.000Z"],
    ["2026-11-15T09:00:00+0800", "2026-11-15T01:00:00.000Z"],
    ["2026-11-15T09:00", "2026-11-15T01:00:00.000Z"],
    ["2026-03-08T02:30:00-05:00", "2026-03-08T07:30:00.000Z", "America/New_York"],
    ["2026-11-01T01:30:00", "2026-11-01T05:30:00.000Z", "America/New_York"],
    ["2026-12-31T24:00", "2027-01-01T05:00:00.000Z", "America/New_York"],
  ];
  let index = 0;
  for (const [input, expected, TZ = "Asia/Taipei"] of cases) for (const source of ["flag", "env"]) {
    const label = `test-${index++}`;
    const result = await run(["timer", "start", "--label", label, "--state", dir, "--base-url", server.baseUrl, ...(source === "flag" ? ["--now", input] : [])], { TZ, AWAXI_NOW: source === "env" ? input : "stale" });
    assert.equal(result.code, 0, result.output);
    const events = Object.values(server.state.events).flat();
    assert.equal(events.find(event => event.data.label === label)?.timestamp, expected);
  }
});
