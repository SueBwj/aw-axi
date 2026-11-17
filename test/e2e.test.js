import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./synthetic-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "aw-axi.js");
const scratch = (process.env.AWAXI_TEST_DATA || path.join(process.env.TMPDIR || "/tmp", "aw-axi-tests"));
const passingReceipts = path.join(scratch, "receipts", "passing.jsonl");
const failedReceipts = path.join(scratch, "receipts", "failed.jsonl");

function redact(text) {
  return String(text)
    .replaceAll("CANARY_TITLE_SECRET", "[redacted-title]")
    .replaceAll("CANARY_QUERY", "[redacted-query]")
    .replaceAll("secret-path", "[redacted-path]")
    .replaceAll("user:pass", "[redacted-user]");
}

async function receipt(name, payload) {
  const file = payload.ok === false ? failedReceipts : passingReceipts;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ name, at: new Date().toISOString(), ...payload })}\n`);
}

function run(args, env = {}, execArgv = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...execArgv, bin, ...args], {
      cwd: root,
      env: {
        ...process.env,
        AWAXI_BASE_URL: "",
        AWAXI_STATE: "",
        AWAXI_NOW: "",
        AWAXI_REFUSE_5600: "1",
        ...env,
      },
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

async function check(name, fn) {
  await test(name, async () => {
    try {
      await fn();
    } catch (error) {
      await receipt(name, { ok: false, error: redact(error.stack || error.message) });
      throw error;
    }
  });
}

function posted(state, suffix) {
  return state.requests.filter((request) => request.method === "POST" && request.path.endsWith(suffix));
}

await mkdir(path.dirname(passingReceipts), { recursive: true });

await check("version is the fast path", async () => {
  const floor = await timed([process.execPath, "-e", "console.log(1)"]);
  const version = await timed([process.execPath, bin, "--version"]);
  assert.equal(version.stdout.trim(), "0.1.0");
  assert.equal(version.code, 0);
  assert.ok(version.ms < Math.max(floor.ms * 8, floor.ms + 200), `version ${version.ms}ms floor ${floor.ms}ms`);
  for (const flag of ["-v", "-V"]) {
    const result = await run([flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "0.1.0");
  }
  await receipt("version", { ok: true, version_ms: version.ms, floor_ms: floor.ms });
});

await check("home hides labels and does not default to a server", async () => {
  const bare = await run([]);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /not-configured/);
  assert.doesNotMatch(bare.stdout, /5600/);
  const server = await startServer();
  try {
    server.state.buckets["aw-stopwatch"] = {
      id: "aw-stopwatch",
      type: "general.stopwatch",
      hostname: "unknown",
    };
    server.state.events["aw-stopwatch"] = [
      {
        id: 1,
        timestamp: "2026-11-15T00:00:00.000Z",
        duration: 0,
        data: { label: "SECRET_LABEL", running: true },
      },
    ];
    const home = await run([], { AWAXI_BASE_URL: server.baseUrl });
    assert.equal(home.code, 0);
    assert.match(home.stdout, /running_count: 1/);
    assert.doesNotMatch(home.stdout, /SECRET_LABEL/);
    assert.equal(posted(server.state, "/events").length, 0);
    await receipt("home", { ok: true, stdout: home.stdout });
  } finally {
    await server.close();
  }
});

await check("unknown flags and missing arguments do not write", async () => {
  const server = await startServer();
  try {
    const unknown = await run([
      "timer",
      "start",
      "--label",
      "task",
      "--bogus",
      "--base-url",
      server.baseUrl,
      "--state",
      scratch,
    ]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stdout, /Unknown flag --bogus/);
    assert.match(unknown.stdout, /--label/);
    const missing = await run(["timer", "start", "--base-url", server.baseUrl, "--state", scratch]);
    assert.equal(missing.code, 2);
    const disconnected = await run([
      "timer",
      "start",
      "--label",
      "task",
      "--base-url",
      "http://127.0.0.1:9",
      "--state",
      scratch,
    ]);
    assert.equal(disconnected.code, 1);
    assert.match(disconnected.stdout, /DISCONNECTED/);
    assert.equal(server.state.requests.length, 0);
    const refused = await run([
      "timer",
      "status",
      "--base-url",
      "http://127.0.0.1:5600",
    ]);
    assert.equal(refused.code, 2);
    assert.match(refused.stdout, /5600/);
    assert.match(disconnected.stdout, /not accepting connections/);
    assert.doesNotMatch(disconnected.stdout, /redirect/i);
    await receipt("validation", { ok: true, unknown: unknown.stdout, disconnected: disconnected.stdout });
  } finally {
    await server.close();
  }
});

await check("start stop no-op switch and same-label totals", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  const base = ["--base-url", server.baseUrl, "--state", stateDir];
  try {
    const started = await run(["timer", "start", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:00:00.000Z"]);
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, /result: started/);
    const again = await run(["timer", "start", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:00:10.000Z"]);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /result: no-op/);
    assert.equal(server.state.events["aw-stopwatch"].length, 1);
    assert.equal(server.state.eventPosts, 1);
    const stopped = await run(["timer", "stop", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:20:00.000Z"]);
    assert.equal(stopped.code, 0, stopped.stdout);
    assert.match(stopped.stdout, /result: stopped/);
    assert.match(stopped.stdout, /id: 1/);
    assert.equal(server.state.events["aw-stopwatch"][0].data.running, false);
    assert.equal(server.state.events["aw-stopwatch"][0].duration, 1200);
    const stoppedAgain = await run(["timer", "stop", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:25:00.000Z"]);
    assert.equal(stoppedAgain.code, 0, stoppedAgain.stdout);
    assert.match(stoppedAgain.stdout, /no-op/);
    assert.equal(server.state.events["aw-stopwatch"].length, 1);
    const second = await run(["timer", "start", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:25:00.000Z"]);
    assert.equal(second.code, 0, second.stdout);
    const secondStop = await run(["timer", "stop", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T01:33:00.000Z"]);
    assert.equal(secondStop.code, 0, secondStop.stdout);
    assert.equal(server.state.events["aw-stopwatch"].length, 2);
    const totals = await run([
      "totals",
      "--label",
      "整理阅读笔记",
      "--base-url",
      server.baseUrl,
      "--start",
      "2026-11-15T09:00:00",
      "--end",
      "2026-11-15T10:00:00",
      "--timezone",
      "Asia/Taipei",
      "--now",
      "2026-11-15T02:00:00.000Z",
    ]);
    assert.equal(totals.code, 0, totals.stdout);
    assert.match(totals.stdout, /completed_seconds: 1680/);
    assert.match(totals.stdout, /overlap_seconds: 0/);
    assert.match(totals.stdout, /running_elapsed_seconds: 0/);
    assert.match(totals.stdout, /Asia\/Taipei/);
    const resumed = await run(["timer", "start", "--label", "整理阅读笔记", ...base, "--now", "2026-11-15T02:00:00.000Z"]);
    assert.equal(resumed.code, 0, resumed.stdout);
    const switched = await run(["timer", "switch", "--from", "整理阅读笔记", "--to", "写信", ...base, "--now", "2026-11-15T02:10:00.000Z"]);
    assert.equal(switched.code, 0, switched.stdout);
    assert.match(switched.stdout, /server_transaction: unsupported/);
    const running = server.state.events["aw-stopwatch"].filter((event) => event.data.running);
    assert.equal(running.length, 1);
    assert.equal(running[0].data.label, "写信");
    assert.ok(server.state.requests.some((request) => request.method === "GET" && request.path === "/api/0/buckets/"));
    assert.equal(server.state.requests.some((request) => request.path === "/api/0/buckets"), false);
    assert.ok(
      server.state.requests.some(
        (request) => request.method === "GET" && request.path.endsWith("/events") && request.search === "?limit=10000",
      ),
    );
    await receipt("timer-flow", { ok: true, started: started.stdout, stopped: stopped.stdout, totals: totals.stdout, switched: switched.stdout });
  } finally {
    await server.close();
  }
});

await check("overlapping totals stay a union and ignore window time", async () => {
  const server = await startServer();
  server.state.buckets["aw-stopwatch"] = { id: "aw-stopwatch", type: "general.stopwatch", hostname: "unknown" };
  server.state.events["aw-stopwatch"] = [
    event(1, "2026-11-15T00:00:00.000Z", 100, { label: "overlap", running: false }),
    event(2, "2026-11-15T00:00:50.000Z", 100, { label: "overlap", running: false }),
    event(3, "2026-11-15T00:00:00.000Z", 30, { label: "overlap", running: true }),
  ];
  server.state.buckets["aw-watcher-window_synthetic"] = {
    id: "aw-watcher-window_synthetic",
    type: "currentwindow",
    hostname: "synthetic",
  };
  server.state.events["aw-watcher-window_synthetic"] = [
    event(4, "2026-11-15T00:00:00.000Z", 10000, { app: "Synthetic Editor", title: "CANARY_TITLE_SECRET" }),
  ];
  try {
    const totals = await run([
      "totals",
      "--label",
      "overlap",
      "--base-url",
      server.baseUrl,
      "--start",
      "2026-11-15T00:00:00",
      "--end",
      "2026-11-15T01:00:00",
      "--timezone",
      "UTC",
      "--now",
      "2026-11-15T00:00:30.000Z",
    ]);
    assert.equal(totals.code, 0, totals.stdout);
    assert.match(totals.stdout, /completed_seconds: 150/);
    assert.match(totals.stdout, /stored_sum_seconds: 200/);
    assert.match(totals.stdout, /overlap_seconds: 50/);
    assert.match(totals.stdout, /running_elapsed_seconds: 30/);
    assert.doesNotMatch(totals.stdout, /CANARY_TITLE_SECRET/);
    assert.doesNotMatch(totals.stdout, /10000/);
    assert.equal(server.state.requests.some((request) => request.path.includes("aw-watcher-window")), false);
    await receipt("overlap", { ok: true, stdout: totals.stdout });
  } finally {
    await server.close();
  }
});

await check("DST ranges do not double count", async () => {
  const server = await startServer();
  server.state.buckets["aw-stopwatch"] = { id: "aw-stopwatch", type: "general.stopwatch", hostname: "unknown" };
  server.state.events["aw-stopwatch"] = [
    event(1, "2026-03-08T05:00:00.000Z", 82800, { label: "dst", running: false }),
    event(2, "2026-11-01T04:00:00.000Z", 90000, { label: "dst", running: false }),
  ];
  try {
    const spring = await totals(server, "2026-03-08T00:00:00", "2026-03-09T00:00:00");
    const springMorning = await totals(server, "2026-03-08T00:00:00", "2026-03-08T12:00:00");
    const springAfternoon = await totals(server, "2026-03-08T12:00:00", "2026-03-09T00:00:00");
    assert.match(spring.stdout, /completed_seconds: 82800/);
    assert.match(springMorning.stdout, /completed_seconds: 39600/);
    assert.match(springAfternoon.stdout, /completed_seconds: 43200/);
    const fall = await totals(server, "2026-11-01T00:00:00", "2026-11-02T00:00:00");
    const fallMorning = await totals(server, "2026-11-01T00:00:00", "2026-11-01T12:00:00");
    const fallAfternoon = await totals(server, "2026-11-01T12:00:00", "2026-11-02T00:00:00");
    assert.match(fall.stdout, /completed_seconds: 90000/);
    assert.match(fallMorning.stdout, /completed_seconds: 46800/);
    assert.match(fallAfternoon.stdout, /completed_seconds: 43200/);
    const ambiguous = await run([
      "totals",
      "--label",
      "dst",
      "--base-url",
      server.baseUrl,
      "--start",
      "2026-11-01T01:30:00",
      "--end",
      "2026-11-01T12:00:00",
      "--timezone",
      "America/New_York",
    ]);
    assert.equal(ambiguous.code, 2, ambiguous.stdout);
    assert.equal(server.state.eventPosts, 0);
    await receipt("dst", { ok: true, spring: spring.stdout, fall: fall.stdout, ambiguous: ambiguous.stdout });
  } finally {
    await server.close();
  }
});

await check("default range is seven local days", async () => {
  const server = await startServer();
  server.state.buckets["aw-stopwatch"] = { id: "aw-stopwatch", type: "general.stopwatch", hostname: "unknown" };
  server.state.events["aw-stopwatch"] = [];
  try {
    const result = await run([
      "totals",
      "--label",
      "empty",
      "--base-url",
      server.baseUrl,
      "--timezone",
      "Asia/Taipei",
      "--now",
      "2026-06-15T04:00:00.000Z",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /start: "2026-06-08T12:00:00\+08:00"/);
    assert.match(result.stdout, /end: "2026-06-15T12:00:00\+08:00"/);
    assert.match(result.stdout, /completed_seconds: 0/);
    assert.match(result.stdout, /0|stopped_count: 0/);
    await receipt("empty-range", { ok: true, stdout: result.stdout });
  } finally {
    await server.close();
  }
});

await check("multiple running timers and partial switch", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  server.state.buckets["aw-stopwatch"] = { id: "aw-stopwatch", type: "general.stopwatch", hostname: "unknown" };
  server.state.events["aw-stopwatch"] = [
    event(1, "2026-11-15T00:00:00.000Z", 0, { label: "one", running: true }),
    event(2, "2026-11-15T00:00:00.000Z", 0, { label: "two", running: true }),
  ];
  server.state.nextId = 3;
  try {
    const stop = await run([
      "timer",
      "stop",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:01:00.000Z",
    ]);
    assert.equal(stop.code, 2, stop.stdout);
    const ambiguous = await run([
      "timer",
      "switch",
      "--to",
      "three",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:01:00.000Z",
    ]);
    assert.equal(ambiguous.code, 1, ambiguous.stdout);
    assert.match(ambiguous.stdout, /AMBIGUOUS/);
    assert.equal(server.state.events["aw-stopwatch"].filter((item) => item.data.running).length, 2);
    server.state.faults.failWhenPostsAt = 1;
    const partial = await run([
      "timer",
      "switch",
      "--from",
      "one",
      "--to",
      "three",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:02:00.000Z",
    ]);
    assert.equal(partial.code, 1, partial.stdout);
    assert.match(partial.stdout, /PARTIAL/);
    const one = server.state.events["aw-stopwatch"].find((item) => item.id === 1);
    assert.equal(one.data.running, false);
    assert.equal(server.state.events["aw-stopwatch"].some((item) => item.data.label === "three"), false);
    await receipt("conflicts", { ok: true, ambiguous: ambiguous.stdout, partial: partial.stdout });
  } finally {
    await server.close();
  }
});

await check("uncertain write is not retried as a new event", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  server.state.faults.dropEventWrite = true;
  try {
    const lost = await run([
      "timer",
      "start",
      "--label",
      "retry",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:00:00.000Z",
    ]);
    assert.equal(lost.code, 1, lost.stdout);
    assert.match(lost.stdout, /UNCERTAIN_WRITE/);
    assert.equal(server.state.eventPosts, 1);
    assert.equal(server.state.events["aw-stopwatch"].length, 1);
    const retry = await run([
      "timer",
      "start",
      "--label",
      "retry",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:05:00.000Z",
    ]);
    assert.equal(retry.code, 0, retry.stdout);
    assert.match(retry.stdout, /no-op/);
    assert.equal(server.state.eventPosts, 1);
    assert.equal(server.state.events["aw-stopwatch"].length, 1);
    await receipt("uncertain", { ok: true, lost: lost.stdout, retry: retry.stdout });
  } finally {
    await server.close();
  }
});

await check("concurrent starts create one interval", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  try {
    const args = [
      "timer",
      "start",
      "--label",
      "same",
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
      "--now",
      "2026-11-15T00:00:00.000Z",
    ];
    const [first, second] = await Promise.all([run(args), run(args)]);
    assert.equal(first.code, 0, first.stdout + second.stdout);
    assert.equal(second.code, 0, second.stdout);
    assert.equal(server.state.events["aw-stopwatch"].length, 1);
    const texts = `${first.stdout}\n${second.stdout}`;
    assert.match(texts, /started/);
    assert.match(texts, /no-op/);
    await receipt("concurrent", { ok: true, first: first.stdout, second: second.stdout });
  } finally {
    await server.close();
  }
});

await check("uncategorized output keeps canaries out", async () => {
  const server = await startServer();
  const dir = await mkdtemp(path.join(scratch, "rules-"));
  const rules = path.join(dir, "rules.json");
  await writeFile(rules, JSON.stringify(completeRules(), null, 2));
  seedActivity(server.state);
  try {
    const result = await run([
      "uncategorized",
      "--rules",
      rules,
      "--base-url",
      server.baseUrl,
      "--start",
      "2026-11-15T00:00:00",
      "--end",
      "2026-11-15T01:00:00",
      "--timezone",
      "UTC",
      "--host",
      "synthetic",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Mystery,60/);
    assert.match(result.stdout, /hidden\.example,30/);
    assert.doesNotMatch(result.stdout, /CANARY/);
    assert.doesNotMatch(result.stdout, /secret-path/);
    assert.doesNotMatch(result.stdout, /user:pass/);
    assert.doesNotMatch(result.stdout, /Notes/);
    assert.doesNotMatch(result.stdout, /example\.com/);
    assert.doesNotMatch(result.stdout, /Google Chrome/);
    assert.ok(server.state.requests.some((request) => request.method === "POST" && request.path === "/api/0/query/"));
    assert.equal(server.state.requests.some((request) => request.path === "/api/0/query"), false);
    const missing = await run([
      "uncategorized",
      "--base-url",
      server.baseUrl,
      "--timezone",
      "UTC",
    ]);
    assert.equal(missing.code, 2, missing.stdout);
    const partial = path.join(dir, "partial.json");
    await writeFile(partial, JSON.stringify([{ name: ["Work"], rule: { type: "regex", regex: "Notes" } }]));
    const refused = await run([
      "uncategorized",
      "--rules",
      partial,
      "--base-url",
      server.baseUrl,
      "--timezone",
      "UTC",
      "--host",
      "synthetic",
    ]);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /UNSUPPORTED/);
    assert.doesNotMatch(refused.stdout, /Mystery/);
    await receipt("privacy", {
      ok: true,
      leaked: /CANARY|secret-path|user:pass/.test(result.stdout),
      stdout: redact(result.stdout),
      refused: refused.stdout,
    });
  } finally {
    await server.close();
  }
});

await check("rules preserve overlays and roll back", async () => {
  const dir = await mkdtemp(path.join(scratch, "rules-"));
  const file = path.join(dir, "rules.json");
  const document = {
    format: "activitywatch-axi.rules.v1",
    coverage: "complete",
    editor_note: "keep-me",
    category_sets: [
      {
        id: "default",
        extra: true,
        categories: [{ name: ["Work"], rule: { type: "regex", regex: "^Notes$" }, note: "first" }],
      },
      {
        id: "overlay",
        categories: [{ name: ["Media"], rule: { type: "regex", regex: "youtube\\.com" }, keep: 1 }],
      },
    ],
    active_set_ids: ["default", "overlay"],
    classes: [],
  };
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  const preview = await run(["rules", "preview", "--file", file]);
  assert.equal(preview.code, 0, preview.stdout);
  const revision = preview.stdout.match(/revision: ([a-f0-9]{64})/)[1];
  const backup = path.join(dir, "backup.json");
  const added = await run([
    "rules",
    "add",
    "--file",
    file,
    "--set",
    "default",
    "--name",
    "Work>Mail",
    "--pattern",
    "Thunderbird",
    "--expect",
    revision,
    "--backup",
    backup,
  ]);
  assert.equal(added.code, 0, added.stdout);
  const updated = JSON.parse(await readFile(file, "utf8"));
  assert.equal(updated.editor_note, "keep-me");
  assert.equal(updated.category_sets[0].extra, true);
  assert.equal(updated.category_sets[0].categories[0].note, "first");
  assert.equal(updated.category_sets[1].categories[0].keep, 1);
  assert.equal(updated.category_sets[1].categories[0].rule.regex, "youtube\\.com");
  assert.deepEqual(updated.active_set_ids, ["default", "overlay"]);
  assert.equal(updated.category_sets[0].categories[1].name.join(">"), "Work>Mail");
  const original = JSON.parse(await readFile(backup, "utf8"));
  assert.equal(original.category_sets[0].categories.length, 1);
  const bad = await run([
    "rules",
    "add",
    "--file",
    file,
    "--set",
    "default",
    "--name",
    "Work",
    "--pattern",
    "Vim",
    "--expect",
    "a".repeat(64),
    "--backup",
    path.join(dir, "unused-backup.json"),
  ]);
  assert.equal(bad.code, 1, bad.stdout);
  assert.match(bad.stdout, /CONFLICT/);
  const unchanged = JSON.parse(await readFile(file, "utf8"));
  assert.equal(unchanged.category_sets[0].categories.length, 2);
  const current = await run(["rules", "preview", "--file", file]);
  const currentRevision = current.stdout.match(/revision: ([a-f0-9]{64})/)[1];
  const restored = await run([
    "rules",
    "revert",
    "--file",
    file,
    "--backup",
    backup,
    "--expect",
    currentRevision,
  ]);
  assert.equal(restored.code, 0, restored.stdout);
  const rolled = JSON.parse(await readFile(file, "utf8"));
  assert.equal(rolled.category_sets[0].categories.length, 1);
  assert.equal(rolled.editor_note, "keep-me");
  await writeFile(path.join(dir, "array.json"), JSON.stringify(document.category_sets[0].categories));
  const arrayShown = await run(["rules", "preview", "--file", path.join(dir, "array.json")]);
  assert.equal(arrayShown.code, 0, arrayShown.stdout);
  assert.match(arrayShown.stdout, /first-set-only/);
  const broken = path.join(dir, "broken.json");
  await writeFile(broken, "{");
  const before = await readFile(broken);
  const malformed = await run(["rules", "preview", "--file", broken]);
  assert.equal(malformed.code, 2, malformed.stdout);
  assert.deepEqual(await readFile(broken), before);
  await receipt("rules", { ok: true, added: added.stdout, bad: bad.stdout, restored: restored.stdout, array: arrayShown.stdout });
});

await check("views null ambiguous and concurrent edits", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  const dir = await mkdtemp(path.join(scratch, "views-"));
  try {
    const missing = await run(["views", "show", "--base-url", server.baseUrl]);
    assert.equal(missing.code, 0, missing.stdout);
    assert.match(missing.stdout, /views: null/);
    const addMissing = await run([
      "views",
      "add-stopwatch",
      "--id",
      "summary",
      "--expect",
      "a".repeat(64),
      "--backup",
      path.join(dir, "nope.json"),
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(addMissing.code, 1, addMissing.stdout);
    assert.match(addMissing.stdout, /UNSUPPORTED/);
    assert.equal(server.state.settingsPosts, 0);
    server.state.settings.views = [
      { id: "summary", name: "Summary", elements: [{ type: "top_apps", size: 3 }], custom: "keep" },
      { id: "summary", name: "Other", elements: [{ type: "top_apps" }] },
    ];
    const ambiguous = await run(["views", "add-stopwatch", "--id", "summary", "--expect", "b".repeat(64), "--backup", path.join(dir, "amb.json"), "--base-url", server.baseUrl, "--state", stateDir]);
    assert.equal(ambiguous.code, 1, ambiguous.stdout);
    assert.match(ambiguous.stdout, /AMBIGUOUS/);
    assert.equal(server.state.settingsPosts, 0);
    server.state.settings.views = [
      { id: "summary", name: "Summary", elements: [{ type: "top_apps", size: 3, kept: true }], custom: "keep" },
      { id: "window", name: "Window", elements: [{ type: "top_titles" }], other: 1 },
    ];
    const shown = await run(["views", "show", "--base-url", server.baseUrl]);
    const revision = shown.stdout.match(/revision: ([a-f0-9]{64})/)[1];
    server.state.faults.secondRead = {
      key: "views",
      reads: 0,
      replace: [{ id: "summary", name: "Summary", elements: [{ type: "changed" }] }],
    };
    const raced = await run([
      "views",
      "add-stopwatch",
      "--id",
      "summary",
      "--expect",
      revision,
      "--backup",
      path.join(dir, "race.json"),
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(raced.code, 1, raced.stdout);
    assert.match(raced.stdout, /CONFLICT/);
    assert.equal(server.state.settingsPosts, 0);
    delete server.state.faults.secondRead;
    server.state.settings.views = [
      { id: "summary", name: "Summary", elements: [{ type: "top_apps", size: 3, kept: true }], custom: "keep" },
      { id: "window", name: "Window", elements: [{ type: "top_titles" }], other: 1 },
    ];
    const fresh = await run(["views", "show", "--base-url", server.baseUrl]);
    const freshRevision = fresh.stdout.match(/revision: ([a-f0-9]{64})/)[1];
    const backup = path.join(dir, "views-backup.json");
    const added = await run([
      "views",
      "add-stopwatch",
      "--id",
      "summary",
      "--expect",
      freshRevision,
      "--backup",
      backup,
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(added.code, 0, added.stdout);
    assert.match(added.stdout, /server_transaction: unsupported/);
    const views = server.state.settings.views;
    assert.equal(views[0].custom, "keep");
    assert.equal(views[0].elements[0].kept, true);
    assert.equal(views[0].elements[1].type, "top_stopwatches");
    assert.equal(views[1].other, 1);
    assert.equal(views[1].elements.length, 1);
    const repeat = await run(["views", "show", "--base-url", server.baseUrl]);
    const repeatRevision = repeat.stdout.match(/revision: ([a-f0-9]{64})/)[1];
    const noop = await run([
      "views",
      "add-stopwatch",
      "--id",
      "summary",
      "--expect",
      repeatRevision,
      "--backup",
      path.join(dir, "second-backup.json"),
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(noop.code, 0, noop.stdout);
    assert.match(noop.stdout, /no-op/);
    assert.equal(server.state.settingsPosts, 1);
    server.state.faults.replaceAfterWrite = { key: "views", replace: { hijacked: true } };
    server.state.settings.views = [
      { id: "browser", name: "Browser", elements: [{ type: "top_domains" }] },
    ];
    const beforeHijack = await run(["views", "show", "--base-url", server.baseUrl]);
    const hijackRevision = beforeHijack.stdout.match(/revision: ([a-f0-9]{64})/)[1];
    const uncertain = await run([
      "views",
      "add-stopwatch",
      "--id",
      "browser",
      "--expect",
      hijackRevision,
      "--backup",
      path.join(dir, "hijack-backup.json"),
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(uncertain.code, 1, uncertain.stdout);
    assert.match(uncertain.stdout, /UNCERTAIN_WRITE/);
    assert.equal(server.state.settingsPosts, 2);
    await receipt("views", { ok: true, missing: missing.stdout, raced: raced.stdout, added: added.stdout, uncertain: uncertain.stdout });
  } finally {
    await server.close();
  }
});

await check("legacy server writes refuse unverified native schemas", async () => {
  const server = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  const dir = await mkdtemp(path.join(scratch, "server-rules-"));
  server.state.settings.category_sets = completeRules().category_sets;
  server.state.settings.active_set_ids = ["default", "overlay"];
  server.state.settings.classes = [];
  try {
    const shown = await run(["rules", "show", "--base-url", server.baseUrl]);
    assert.equal(shown.code, 0, shown.stdout);
    assert.match(shown.stdout, /browser_extension: not-readable/);
    const revision = shown.stdout.match(/revision: ([a-f0-9]{64})/)[1];
    const backup = path.join(dir, "backup.json");
    const added = await run([
      "rules",
      "add",
      "--server",
      "--set",
      "overlay",
      "--name",
      "Media",
      "--pattern",
      "netflix\\.com",
      "--expect",
      revision,
      "--backup",
      backup,
      "--base-url",
      server.baseUrl,
      "--state",
      stateDir,
    ]);
    assert.equal(added.code, 1, added.stdout);
    assert.match(added.stdout, /complete native document/);
    assert.equal(server.state.settingsPosts, 0);
    const sets = server.state.settings.category_sets;
    assert.equal(sets[0].categories[0].rule.regex, "^Notes$");
    assert.equal(sets[0].note, "keep");
    assert.doesNotMatch(sets[1].categories[0].rule.regex, /netflix/);
    assert.deepEqual(server.state.settings.active_set_ids, ["default", "overlay"]);
    const unsupported = await run(["rules", "show", "--base-url", "http://127.0.0.1:9"]);
    assert.equal(unsupported.code, 1);
    const empty = await startServer();
    try {
      const absent = await run(["rules", "export", "--file", path.join(dir, "out.json"), "--base-url", empty.baseUrl]);
      assert.equal(absent.code, 1, absent.stdout);
      assert.match(absent.stdout, /UNSUPPORTED/);
      await receipt("server-rules", { ok: true, added: added.stdout, absent: absent.stdout });
    } finally {
      await empty.close();
    }
  } finally {
    await server.close();
  }
});

await check("canonical routes are requested and redirects are not followed", async () => {
  const server = await startServer();
  const elsewhere = await startServer();
  const stateDir = await mkdtemp(path.join(scratch, "state-"));
  const base = ["--base-url", server.baseUrl, "--state", stateDir, "--bucket", "bucket id"];
  try {
    const home = await run([], { AWAXI_BASE_URL: server.baseUrl });
    assert.equal(home.code, 0, home.stdout);
    assert.match(home.stdout, /reachable/);
    assert.doesNotMatch(home.stdout, /unreachable/);
    const started = await run([
      "timer",
      "start",
      "--label",
      "slash",
      ...base,
      "--now",
      "2026-11-15T00:00:00.000Z",
    ]);
    assert.equal(started.code, 0, started.stdout);
    const events = server.state.requests.filter((request) => request.method === "GET" && request.path.endsWith("/events"));
    assert.ok(events.some((request) => request.search === "?limit=10000"));
    assert.ok(
      server.state.requests.some(
        (request) =>
          request.method === "POST" &&
          (request.path === "/api/0/buckets/bucket%20id" || request.path === "/api/0/buckets/bucket id"),
      ),
    );
    assert.equal(server.state.events["bucket id"].length, 1);
    const shown = await run(["views", "show", "--base-url", server.baseUrl]);
    assert.equal(shown.code, 0, shown.stdout);
    assert.ok(server.state.requests.some((request) => request.method === "GET" && request.path === "/api/0/settings/views"));
    server.state.faults.redirectReads = `${elsewhere.baseUrl}/taken`;
    const redirected = await run(["timer", "status", "--base-url", server.baseUrl]);
    assert.equal(redirected.code, 1, redirected.stdout);
    assert.match(redirected.stdout, /REDIRECT/);
    assert.match(redirected.stdout, /redirected a read/);
    assert.doesNotMatch(redirected.stdout, /not accepting connections/);
    assert.doesNotMatch(redirected.stdout, /DISCONNECTED/);
    assert.equal(elsewhere.state.requests.length, 0);
    const homeRedirect = await run([], { AWAXI_BASE_URL: server.baseUrl });
    assert.notEqual(homeRedirect.code, 0);
    assert.match(homeRedirect.stdout, /REDIRECT/);
    assert.doesNotMatch(homeRedirect.stdout, /unreachable/);
    assert.equal(elsewhere.state.requests.length, 0);
    delete server.state.faults.redirectReads;
    server.state.faults.redirectEventWrite = true;
    const lost = await run([
      "timer",
      "start",
      "--label",
      "again",
      ...base,
      "--now",
      "2026-11-15T00:10:00.000Z",
    ]);
    assert.equal(lost.code, 1, lost.stdout);
    assert.match(lost.stdout, /UNCERTAIN_WRITE/);
    assert.match(lost.stdout, /did not follow the redirect or send the write again/);
    assert.equal(server.state.events["bucket id"].length, 1);
    assert.equal(
      server.state.requests.filter((request) => request.method === "POST" && request.path.endsWith("/events")).length,
      2,
    );
    await receipt("canonical", { ok: true, home: home.stdout, redirected: redirected.stdout, lost: lost.stdout });
  } finally {
    await server.close();
    await elsewhere.close();
  }
});

const absentTemporal = ["--no-harmony-temporal"];

function absentTemporalProbe() {
  const timeModule = pathToFileURL(path.join(root, "src/time.js")).href;
  const script = `
import assert from "node:assert/strict";
import { timeZoneFrom } from ${JSON.stringify(timeModule)};
assert.equal(typeof globalThis.Temporal, "undefined");
assert.throws(
  () => timeZoneFrom({ timezone: 15 }),
  (error) => {
    assert.equal(error.code, "SERVER");
    assert.match(error.message, /time runtime failed \\(TypeError\\)/);
    assert.match(error.message, /not an invalid timezone/);
    assert.doesNotMatch(error.message, /Unknown timezone/);
    return true;
  },
);
process.stdout.write("temporal=" + typeof globalThis.Temporal);
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-harmony-temporal", "--input-type=module", "-e", script], {
      cwd: root,
      env: {
        ...process.env,
        AWAXI_BASE_URL: "",
        AWAXI_STATE: "",
        AWAXI_NOW: "",
        AWAXI_REFUSE_5600: "1",
      },
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

await check("valid zones work when global Temporal is absent", async () => {
  const probe = await absentTemporalProbe();
  assert.equal(probe.code, 0, `${probe.stderr}\n${probe.stdout}`);
  assert.equal(probe.stdout, "temporal=undefined");
  const server = await startServer();
  server.state.buckets["aw-stopwatch"] = { id: "aw-stopwatch", type: "general.stopwatch", hostname: "unknown" };
  server.state.events["aw-stopwatch"] = [];
  try {
    for (const zone of ["UTC", "Asia/Taipei", "America/New_York"]) {
      const result = await run([
        "totals",
        "--label",
        "empty",
        "--base-url",
        server.baseUrl,
        "--timezone",
        zone,
        "--start",
        "2026-11-15T00:00:00",
        "--end",
        "2026-11-15T01:00:00",
      ], {}, absentTemporal);
      assert.equal(result.code, 0, `${zone}\n${result.stdout}`);
      assert.match(result.stdout, new RegExp(zone.replaceAll("/", "\\/")));
      assert.doesNotMatch(result.stdout, /Unknown timezone/);
      assert.doesNotMatch(result.stdout, /time runtime/);
    }
    const bad = await run([
      "totals",
      "--label",
      "empty",
      "--base-url",
      server.baseUrl,
      "--timezone",
      "Not/AZone",
      "--start",
      "2026-11-15T00:00:00",
      "--end",
      "2026-11-15T01:00:00",
    ], {}, absentTemporal);
    assert.equal(bad.code, 2, bad.stdout);
    assert.match(bad.stdout, /Unknown timezone `Not\/AZone`/);
    assert.match(bad.stdout, /VALIDATION_ERROR/);
    assert.doesNotMatch(bad.stdout, /time runtime/);
    await receipt("time-runtime", { ok: true, temporal: "undefined", bad: bad.stdout });
  } finally {
    await server.close();
  }
});

function event(id, timestamp, duration, data) {
  return { id, timestamp, duration, data };
}

function totals(server, start, end) {
  return run([
    "totals",
    "--label",
    "dst",
    "--base-url",
    server.baseUrl,
    "--start",
    start,
    "--end",
    end,
    "--timezone",
    "America/New_York",
    "--now",
    "2026-12-01T00:00:00.000Z",
  ]);
}

function completeRules() {
  return {
    format: "activitywatch-axi.rules.v1",
    coverage: "complete",
    category_sets: [
      {
        id: "default",
        note: "keep",
        categories: [{ name: ["Work"], rule: { type: "regex", regex: "^Notes$" } }],
      },
      {
        id: "overlay",
        categories: [{ name: ["Media"], rule: { type: "regex", regex: "example\\.com" } }],
      },
    ],
    active_set_ids: ["default", "overlay"],
    classes: [],
  };
}

function seedActivity(state) {
  const start = "2026-11-15T00:00:00.000Z";
  state.buckets["aw-watcher-window_synthetic"] = {
    id: "aw-watcher-window_synthetic",
    type: "currentwindow",
    hostname: "synthetic",
  };
  state.buckets["aw-watcher-web_synthetic"] = {
    id: "aw-watcher-web_synthetic",
    type: "web.tab.current",
    hostname: "synthetic",
  };
  state.buckets["aw-watcher-afk_synthetic"] = {
    id: "aw-watcher-afk_synthetic",
    type: "afkstatus",
    hostname: "synthetic",
  };
  state.events["aw-watcher-window_synthetic"] = [
    event(1, start, 20, { app: "Notes", title: "CANARY_TITLE_SECRET" }),
    event(2, start, 100, { app: "Mystery", title: "CANARY_TITLE_SECRET" }),
    event(3, "2026-11-15T00:03:20.000Z", 30, { app: "Google Chrome", title: "CANARY_TITLE_SECRET" }),
    event(4, "2026-11-15T00:05:00.000Z", 30, { app: "Google Chrome", title: "CANARY_TITLE_SECRET" }),
  ];
  state.events["aw-watcher-web_synthetic"] = [
    event(5, "2026-11-15T00:03:20.000Z", 30, {
      title: "CANARY_TITLE_SECRET",
      url: "https://user:pass@www.hidden.example/secret-path?token=CANARY_QUERY#frag",
    }),
    event(6, "2026-11-15T00:05:00.000Z", 30, {
      title: "CANARY_TITLE_SECRET",
      url: "https://www.example.com/secret-path?token=CANARY_QUERY",
    }),
  ];
  state.events["aw-watcher-afk_synthetic"] = [
    event(7, start, 10, { status: "not-afk" }),
    event(8, "2026-11-15T00:00:10.000Z", 40, { status: "afk" }),
    event(9, "2026-11-15T00:00:50.000Z", 3550, { status: "not-afk" }),
  ];
}

function timed(command) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: root });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, stdout, ms });
    });
  });
}
