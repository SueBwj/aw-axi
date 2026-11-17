import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "aw-axi.js");
const evidenceRoot = process.env.AWAXI_TEST_DATA || path.join(process.env.TMPDIR || "/tmp", "aw-axi-tests");
const runsRoot = path.join(evidenceRoot, "official-runs");
const passingReceipts = path.join(evidenceRoot, "receipts/passing.jsonl");
const failedReceipts = path.join(evidenceRoot, "receipts/failed.jsonl");
const serverBin = process.env.AWAXI_TEST_SERVER_BIN;
const webpath = process.env.AWAXI_TEST_WEBPATH;

test("official 0.14.2 loopback accepts the CLI", { timeout: 180000, skip: !serverBin || !webpath }, async () => {
  await mkdir(runsRoot, { recursive: true });
  const task = await realpath(await mkdtemp(path.join(runsRoot, "run-")));
  await mkdir(path.join(task, "home"), { recursive: true });
  await mkdir(path.join(task, "tmp"), { recursive: true });
  const db = path.join(task, "fresh.db");
  const port = await freePort();
  assert.notEqual(port, 5600);
  const sb = path.join(task, "server.sb");
  await writeFile(sb, sandbox(port, task));
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      sb,
      serverBin,
      "--profile",
      "awaxie2e",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--dbpath",
      db,
      "--webpath",
      webpath,
      "--device-id",
      "a1e20000-0000-4000-8000-0000000000a1",
      "--no-legacy-import",
    ],
    {
      env: {
        HOME: path.join(task, "home"),
        TMPDIR: path.join(task, "tmp"),
        AW_PROFILE: "awaxie2e",
        PATH: "/usr/bin:/bin",
        LANG: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stateDir = path.join(task, "cli-state");
  await mkdir(stateDir, { recursive: true });
  try {
    const info = await ready(baseUrl);
    assert.match(String(info.version), /0\.14\.2/);
    assert.equal(info.testing, false);
    assert.equal(info.device_id, "a1e20000-0000-4000-8000-0000000000a1");
    const started = await cli([
      "timer",
      "start",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:00:00.000Z",
    ]);
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, /id: 1/);
    const again = await cli([
      "timer",
      "start",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:00:05.000Z",
    ]);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /no-op/);
    assert.match(again.stdout, /id: 1/);
    const stopped = await cli([
      "timer",
      "stop",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:01:00.000Z",
    ]);
    assert.equal(stopped.code, 0, stopped.stdout);
    assert.match(stopped.stdout, /id: 1/);
    const totals = await cli([
      "totals",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--start",
      "2026-11-15T00:00:00",
      "--end",
      "2026-11-15T01:00:00",
      "--timezone",
      "UTC",
      "--now",
      "2026-11-15T02:00:00.000Z",
    ]);
    assert.equal(totals.code, 0, totals.stdout);
    assert.match(totals.stdout, /completed_seconds: 60/);
    const taipei = await cli([
      "totals",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--start",
      "2026-11-15T08:00:00",
      "--end",
      "2026-11-15T09:00:00",
      "--timezone",
      "Asia/Taipei",
      "--now",
      "2026-11-15T02:00:00.000Z",
    ]);
    assert.equal(taipei.code, 0, taipei.stdout);
    assert.match(taipei.stdout, /completed_seconds: 60/);
    assert.match(taipei.stdout, /Asia\/Taipei/);
    const newYork = await cli([
      "totals",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--start",
      "2026-11-14T19:00:00",
      "--end",
      "2026-11-14T20:00:00",
      "--timezone",
      "America/New_York",
      "--now",
      "2026-11-15T02:00:00.000Z",
    ]);
    assert.equal(newYork.code, 0, newYork.stdout);
    assert.match(newYork.stdout, /completed_seconds: 60/);
    const overlap = await cli([
      "totals",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--start",
      "2026-11-01T01:30:00",
      "--end",
      "2026-11-01T12:00:00",
      "--timezone",
      "America/New_York",
    ]);
    assert.equal(overlap.code, 2, overlap.stdout);
    assert.match(overlap.stdout, /does not occur exactly once/);
    assert.doesNotMatch(overlap.stdout, /time runtime/);
    const gap = await cli([
      "totals",
      "--label",
      "synthetic-official",
      "--base-url",
      baseUrl,
      "--start",
      "2026-03-08T02:30:00",
      "--end",
      "2026-03-08T12:00:00",
      "--timezone",
      "America/New_York",
    ]);
    assert.equal(gap.code, 2, gap.stdout);
    assert.match(gap.stdout, /does not occur exactly once/);
    const views = await cli(["views", "show", "--base-url", baseUrl]);
    assert.equal(views.code, 0, views.stdout);
    assert.match(views.stdout, /views: null/);
    const rules = await cli(["rules", "show", "--base-url", baseUrl]);
    assert.equal(rules.code, 0, rules.stdout);
    assert.match(rules.stdout, /unsupported/);
    const buckets = await (await fetch(`${baseUrl}/api/0/buckets/`)).json();
    await fetch(`${baseUrl}/api/0/buckets/aw-watcher-window_synthetic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "synthetic", type: "currentwindow", hostname: "synthetic" }),
    });
    await fetch(`${baseUrl}/api/0/buckets/aw-watcher-window_synthetic/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          timestamp: "2026-11-15T00:00:00.000Z",
          duration: 30,
          data: { app: "Mystery", title: "CANARY_TITLE_SECRET" },
        },
      ]),
    });
    const rulesFile = path.join(task, "rules.json");
    await writeFile(
      rulesFile,
      JSON.stringify({
        format: "activitywatch-axi.rules.v1",
        coverage: "complete",
        category_sets: [
          { id: "default", categories: [{ name: ["Work"], rule: { type: "regex", regex: "^Notes$" } }] },
        ],
        active_set_ids: ["default"],
        classes: [],
      }),
    );
    const uncategorized = await cli([
      "uncategorized",
      "--rules",
      rulesFile,
      "--base-url",
      baseUrl,
      "--host",
      "synthetic",
      "--start",
      "2026-11-15T00:00:00",
      "--end",
      "2026-11-15T01:00:00",
      "--timezone",
      "UTC",
    ]);
    assert.equal(uncategorized.code, 0, uncategorized.stdout);
    assert.match(uncategorized.stdout, /Mystery,30/);
    assert.doesNotMatch(uncategorized.stdout, /CANARY/);
    const from = await cli([
      "timer",
      "start",
      "--label",
      "switch-from",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T03:00:00.000Z",
    ]);
    assert.equal(from.code, 0, from.stdout);
    const switched = await cli([
      "timer",
      "switch",
      "--from",
      "switch-from",
      "--to",
      "switch-to",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T03:10:00.000Z",
    ]);
    assert.equal(switched.code, 0, switched.stdout);
    assert.match(switched.stdout, /server_transaction: unsupported/);
    const switchedStop = await cli([
      "timer",
      "stop",
      "--label",
      "switch-to",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T03:20:00.000Z",
    ]);
    assert.equal(switchedStop.code, 0, switchedStop.stdout);
    await cli([
      "timer",
      "start",
      "--label",
      "amb-one",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T04:00:00.000Z",
    ]);
    await cli([
      "timer",
      "start",
      "--label",
      "amb-two",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T04:00:00.000Z",
    ]);
    const ambiguous = await cli([
      "timer",
      "switch",
      "--to",
      "amb-three",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T04:05:00.000Z",
    ]);
    assert.equal(ambiguous.code, 1, ambiguous.stdout);
    assert.match(ambiguous.stdout, /AMBIGUOUS/);
    const still = await (await fetch(`${baseUrl}/api/0/buckets/aw-stopwatch/events?limit=100`)).json();
    const stillRunning = still.filter((event) => event.data?.running === true);
    assert.equal(stillRunning.length, 2);
    for (const label of ["amb-one", "amb-two"]) {
      const stoppedOne = await cli([
        "timer",
        "stop",
        "--label",
        label,
        "--base-url",
        baseUrl,
        "--state",
        stateDir,
        "--now",
        "2026-11-15T04:06:00.000Z",
      ]);
      assert.equal(stoppedOne.code, 0, stoppedOne.stdout);
    }
    const concurrentArgs = [
      "timer",
      "start",
      "--label",
      "concurrent",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T05:00:00.000Z",
    ];
    const [firstStart, secondStart] = await Promise.all([cli(concurrentArgs), cli(concurrentArgs)]);
    assert.equal(firstStart.code, 0, firstStart.stdout + secondStart.stdout);
    assert.equal(secondStart.code, 0, secondStart.stdout);
    const concurrentTexts = `${firstStart.stdout}\n${secondStart.stdout}`;
    assert.match(concurrentTexts, /started/);
    assert.match(concurrentTexts, /no-op/);
    const concurrentEvents = await (await fetch(`${baseUrl}/api/0/buckets/aw-stopwatch/events?limit=100`)).json();
    assert.equal(concurrentEvents.filter((event) => event.data?.label === "concurrent").length, 1);
    await cli([
      "timer",
      "stop",
      "--label",
      "concurrent",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T05:10:00.000Z",
    ]);
    const wallBefore = Date.now();
    const wallStarted = await cli([
      "timer",
      "start",
      "--label",
      "wall-clock",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(wallStarted.code, 0, wallStarted.stdout);
    const wallId = wallStarted.stdout.match(/id: (\d+)/)[1];
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const wallAgain = await cli([
      "timer",
      "start",
      "--label",
      "wall-clock",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(wallAgain.code, 0, wallAgain.stdout);
    assert.match(wallAgain.stdout, /no-op/);
    assert.match(wallAgain.stdout, new RegExp(`id: ${wallId}`));
    const wallStopped = await cli([
      "timer",
      "stop",
      "--label",
      "wall-clock",
      "--base-url",
      baseUrl,
      "--state",
      stateDir,
    ]);
    const wallAfter = Date.now();
    assert.equal(wallStopped.code, 0, wallStopped.stdout);
    assert.match(wallStopped.stdout, new RegExp(`id: ${wallId}`));
    assert.match(wallStopped.stdout, /running: false/);
    const wallDuration = Number(wallStopped.stdout.match(/duration_seconds: ([0-9.]+)/)[1]);
    assert.ok(wallDuration >= 1 && wallDuration < 15, `wall duration ${wallDuration}`);
    assert.ok(wallAfter - wallBefore >= 1500);
    const wallTotals = await cli([
      "totals",
      "--label",
      "wall-clock",
      "--base-url",
      baseUrl,
      "--timezone",
      "UTC",
    ]);
    assert.equal(wallTotals.code, 0, wallTotals.stdout);
    const completed = Number(wallTotals.stdout.match(/completed_seconds: ([0-9.]+)/)[1]);
    assert.ok(Math.abs(completed - wallDuration) < 0.01, wallTotals.stdout);
    assert.match(wallTotals.stdout, /running_elapsed_seconds: 0/);
    const stored = await (await fetch(`${baseUrl}/api/0/buckets/aw-stopwatch/events?limit=100`)).json();
    const wallEvent = stored.find((event) => event.data?.label === "wall-clock");
    assert.equal(wallEvent.id, Number(wallId));
    assert.equal(wallEvent.data.running, false);
    const receipt = {
      ok: true,
      version: info.version,
      testing: info.testing,
      device_id: info.device_id,
      database: db,
      injected_span_seconds: 60,
      injected_span_is_real_elapsed: false,
      wall_clock_duration_seconds: wallDuration,
      wall_clock_uses_now_override: false,
      wall_clock_id: Number(wallId),
      hostname_present: Object.hasOwn(info, "hostname"),
      buckets_before_window: Object.keys(buckets),
      uncategorized: uncategorized.stdout,
      afk_filter: uncategorized.stdout.includes("unavailable") ? "unavailable" : "present",
    };
    await writeFile(path.join(task, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await mkdir(path.dirname(passingReceipts), { recursive: true });
    await appendFile(passingReceipts, `${JSON.stringify({ name: "official", at: new Date().toISOString(), ...receipt })}\n`);
  } catch (error) {
    await writeFile(path.join(task, "server.log"), log);
    await mkdir(path.dirname(failedReceipts), { recursive: true });
    await appendFile(
      failedReceipts,
      `${JSON.stringify({ name: "official", at: new Date().toISOString(), ok: false, task, error: String(error.stack || error) })}\n`,
    );
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
});

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, AWAXI_BASE_URL: "", AWAXI_STATE: "", AWAXI_NOW: "", AWAXI_REFUSE_5600: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ready(baseUrl) {
  const deadline = Date.now() + 15000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const infoResponse = await fetch(`${baseUrl}/api/0/info`);
      const plainResponse = await fetch(`${baseUrl}/api/0/buckets`);
      const slashResponse = await fetch(`${baseUrl}/api/0/buckets/`);
      if (infoResponse.ok && plainResponse.ok && slashResponse.ok) {
        const buckets = await slashResponse.json();
        if (buckets && typeof buckets === "object") return infoResponse.json();
      }
      last = `${infoResponse.status}/${plainResponse.status}/${slashResponse.status}`;
    } catch (error) {
      last = error.code || error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`official server was not ready: ${last}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sandbox(port, dataDir) {
  const parents = [];
  for (let dir = path.dirname(dataDir); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    parents.push(`  (literal ${JSON.stringify(dir)})`);
  }
  return `(version 1)
(allow default)
(deny file-read* (require-all
  (require-not (literal "/"))
  (require-not (subpath "/System"))
  (require-not (subpath "/usr/lib"))
  (require-not (subpath "/usr/share"))
  (require-not (subpath "/usr/bin"))
  (require-not (subpath "/bin"))
  (require-not (subpath "/Library/Apple/System"))
  (require-not (literal "${serverBin}"))
  (require-not (subpath "${webpath}"))
  (require-not (subpath "${dataDir}"))
  (require-not (subpath "/private/var/db/timezone"))
  (require-not (subpath "/private/var/db/dyld"))
  (require-not (subpath "/private/etc/ssl"))
  (require-not (literal "/dev/null"))
  (require-not (literal "/dev/random"))
  (require-not (literal "/dev/urandom"))
  (require-not (literal "/private/etc/localtime"))
  (require-not (literal "/private/etc/hosts"))
  (require-not (literal "/private/etc/resolv.conf"))
))
(deny file-write* (require-all
  (require-not (subpath "${dataDir}"))
  (require-not (literal "/dev/null"))
))
(deny network*)
(allow network-bind (local ip "localhost:${port}"))
(allow network-inbound (local ip "localhost:${port}"))
(allow network-outbound (remote ip "localhost:${port}"))
(allow file-read-metadata
  (literal "/private")
  (literal "/private/tmp")
${parents.join("\n")})
`;
}
