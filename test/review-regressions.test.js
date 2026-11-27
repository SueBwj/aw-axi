import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionOf } from "../src/revision.js";
import { startServer } from "./synthetic-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const range = ["--start", "2026-11-15T00:00:00", "--end", "2026-11-15T01:00:00", "--timezone", "UTC"];
const event = (seconds, data, offset = 0) => ({ timestamp: new Date(Date.parse("2026-11-15T00:00:00Z") + offset * 1000).toISOString(), duration: seconds, data });
const document = () => ({ format: "activitywatch-axi.rules.v1", coverage: "complete", category_sets: [{ id: "default", categories: [{ name: ["Work"], rule: { type: "regex", regex: "^Notes$" } }] }], active_set_ids: ["default"], classes: [] });

function run(args, { env = {}, nodeArgs = [], onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, "bin/aw-axi.js", ...args], {
      cwd: root,
      stdio: onMessage ? ["ignore", "pipe", "pipe", "ipc"] : undefined,
      env: { ...process.env, AWAXI_REFUSE_5600: "1", AWAXI_BASE_URL: "", AWAXI_STATE: "", AWAXI_NOW: "", NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    if (onMessage) child.on("message", message => onMessage(message, child));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function setup(t) {
  const dir = await mkdtemp(path.join(root, ".review-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await startServer();
  t.after(() => server.close());
  const file = path.join(dir, "rules.json");
  await writeFile(file, JSON.stringify(document()));
  const state = server.state;
  for (const [id, type] of [["window", "currentwindow"], ["web", "web.tab.current"], ["afk", "afkstatus"]]) {
    state.buckets[id] = { id, type, hostname: "A" };
    state.events[id] = [];
  }
  state.events.window = [event(3600, { app: "Editor" })];
  state.events.afk = [event(3600, { status: "not-afk" })];
  const activity = (...extra) => run(["uncategorized", "--rules", file, "--base-url", server.baseUrl, ...range, ...extra]);
  return { dir, file, server, state, activity };
}

async function fileRevision(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function add(file, dir, pattern, extra = [], backup = "backup.json", options) {
  const expect = await fileRevision(file);
  return run(["rules", "add", "--file", file, "--set", "default", "--name", "Work", "--pattern", pattern, "--expect", expect, "--backup", path.join(dir, backup), ...extra], options);
}

async function revert(file, backup, options) {
  return run(["rules", "revert", "--file", file, "--backup", backup, "--expect", await fileRevision(file)], options);
}

function preloadArgs(script) {
  return ["--import", "data:text/javascript;base64," + Buffer.from(script).toString("base64")];
}

test("legacy restore refuses incompatible backups without changing the current file", async t => {
  const { file, dir } = await setup(t);
  const current = await readFile(file);
  const backup = path.join(dir, "backup.json");
  const invalid = [
    "{",
    JSON.stringify({ ...document(), format: "activitywatch-axi.native-rules.v1" }),
    JSON.stringify({ ...document(), coverage: "legacy-classes-only" }),
    JSON.stringify({ ...document(), active_set_ids: ["missing"] }),
    JSON.stringify({ ...document(), classes: {} }),
    JSON.stringify({ ...document(), classes: [{ name: ["Work"], rule: { type: "regex", regex: "[" } }] }),
    JSON.stringify({ ...document(), classes: [{ name: ["Work"], rule: { type: "none", weight: JSON.rawJSON("1.0000000000000001") } }] }),
  ];
  for (const bytes of invalid) {
    await writeFile(backup, bytes);
    const result = await revert(file, backup);
    assert.notEqual(result.code, 0, bytes + result.stdout);
    assert.deepEqual(await readFile(file), current);
    assert.equal(await readFile(backup, "utf8"), bytes);
  }
});

test("legacy restore rejects the native save-backup option before replacing files", async t => {
  const { file, dir } = await setup(t);
  const current = await readFile(file);
  const backup = path.join(dir, "backup.json");
  const safetyCopy = path.join(dir, "current.json");
  const restored = Buffer.concat([current, Buffer.from("\n")]);
  await writeFile(backup, restored);
  const args = ["rules", "revert", "--file", file, "--backup", backup, "--expect", await fileRevision(file)];
  for (const option of [["--save-backup", safetyCopy], ["--save-backup=" + safetyCopy]]) {
    const result = await run([...args, ...option]);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /Unknown flag --save-backup/);
    assert.deepEqual(await readFile(file), current);
    assert.deepEqual(await readFile(backup), restored);
    await assert.rejects(readFile(safetyCopy), { code: "ENOENT" });
  }
  assert.equal((await revert(file, backup)).code, 0);
  assert.deepEqual(await readFile(file), restored);
});

test("explicit missing stopwatch buckets fail for status, totals, and stop", async t => {
  const { dir, server, state } = await setup(t);
  const runTimer = (args, now = "2026-11-15T00:01:00Z") =>
    run([...args, "--base-url", server.baseUrl, "--now", now]);
  const lock = ["--state", dir];
  const status = ["timer", "status"];
  const totals = ["totals", "--label", "Work", ...range];
  const stop = ["timer", "stop", "--label", "Work", ...lock];
  for (const command of [status, totals, stop]) {
    const empty = await runTimer(command);
    assert.equal(empty.code, 0, empty.stdout);
    assert.match(empty.stdout, /bucket: null/);
  }
  const selected = ["--bucket", "work-timers"];
  const started = await runTimer(["timer", "start", "--label", "Work", ...lock, ...selected], "2026-11-15T00:00:00Z");
  assert.equal(started.code, 0, started.stdout);
  assert.equal(state.buckets["work-timers"].type, "general.stopwatch");
  for (const command of [status, totals, stop]) {
    state.requests.length = 0;
    const missing = await runTimer([...command, "--bucket", "typo"]);
    assert.notEqual(missing.code, 0, missing.stdout);
    assert.match(missing.stdout, /code: NOT_FOUND/);
    assert.match(missing.stdout, /typo/);
    assert.deepEqual(state.requests.map(({ method, path }) => [method, path]), [["GET", "/api/0/buckets/"]]);
  }
  assert.equal(state.eventPosts, 1);
  assert.equal(state.events["work-timers"][0].data.running, true);
  for (const selection of [[], selected]) {
    const listed = await runTimer([...status, ...selection]);
    assert.equal(listed.code, 0, listed.stdout);
    assert.match(listed.stdout, /bucket: work-timers/);
    assert.match(listed.stdout, /running_count: 1/);
  }
  const stopped = await runTimer([...stop, ...selected]);
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(state.events["work-timers"][0].data.running, false);
  for (const selection of [[], selected]) {
    const counted = await runTimer([...totals, ...selection]);
    assert.equal(counted.code, 0, counted.stdout);
    assert.match(counted.stdout, /bucket: work-timers/);
    assert.match(counted.stdout, /completed_seconds: 60/);
  }
  delete state.buckets["work-timers"];
  const switched = await runTimer(["timer", "switch", "--to", "Work", ...lock]);
  assert.equal(switched.code, 0, switched.stdout);
  assert.equal(state.buckets["aw-stopwatch"].type, "general.stopwatch");
});

test("stopwatch IDs must be exact before selection or mutation", async t => {
  const { dir, server, state } = await setup(t);
  const bucket = "aw-stopwatch";
  state.buckets[bucket] = { id: bucket, type: "general.stopwatch" };
  const first = { ...event(0, { label: "First", running: true }), id: 9007199254740992 };
  const second = { ...event(0, { label: "Second", running: true }), id: JSON.rawJSON("9007199254740993") };
  state.events[bucket] = [first, second];
  const timer = (...args) => run(["timer", ...args, "--base-url", server.baseUrl, "--now", "2026-11-15T00:01:00Z"]);
  for (const args of [["status"], ["stop", "--label", "Second", "--state", dir],
    ["switch", "--from", "Second", "--to", "Next", "--state", dir]]) {
    const refused = await timer(...args);
    assert.match(refused.stdout, /code: SERVER/);
    assert.match(refused.stdout, /inexact stopwatch event id/);
  }
  const unsafeSelector = await timer("stop", "--id", "9007199254740993", "--state", dir);
  assert.match(unsafeSelector.stdout, /code: VALIDATION_ERROR/);
  assert.equal(state.eventPosts, 0);
  assert.equal(first.data.running, true);
  assert.equal(second.data.running, true);

  state.events[bucket] = [{ ...first, id: Number.MAX_SAFE_INTEGER }];
  const stopped = await timer("stop", "--id", String(Number.MAX_SAFE_INTEGER), "--state", dir);
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(state.eventPosts, 1);
  assert.equal(state.events[bucket][0].data.running, false);
});

test("stopwatch acknowledgments with inexact IDs leave the write uncertain", async t => {
  const { dir, server, state } = await setup(t);
  const ids = [JSON.rawJSON("9007199254740993"), JSON.rawJSON("1.0000000000000001"), "1"];
  for (const [index, id] of ids.entries()) {
    state.faults.eventReply = [{ id }];
    const result = await run([
      "timer", "start", "--label", `Synthetic ${index}`, "--state", dir,
      "--base-url", server.baseUrl, "--now", "2026-11-15T00:00:00Z",
    ]);
    assert.match(result.stdout, /code: UNCERTAIN_WRITE/);
    assert.match(result.stdout, /timer status/);
    assert.equal(state.eventPosts, index + 1);
    assert.equal(state.events["aw-stopwatch"].length, index + 1);
  }
});

test("timer start requires an acknowledged timestamp without retrying the write", async t => {
  const { dir, server, state } = await setup(t);
  const timer = (...args) => run(["timer", ...args, "--state", dir,
    "--base-url", server.baseUrl, "--now", "2026-11-15T00:00:00Z"]);
  const malformed = [
    undefined, 1, "invalid", "2026-02-30T00:00:00Z", "2026-11-15T01:00:00Z",
    "2026-11-15T00:00:60Z", "2026-11-15T00:00:00.000001Z",
  ];
  for (const [index, timestamp] of malformed.entries()) {
    state.faults.eventReply = [{ id: index + 1, timestamp }];
    const result = await timer("start", "--label", `Synthetic ${index}`);
    assert.match(result.stdout, /code: UNCERTAIN_WRITE/);
    assert.match(result.stdout, /verifiable event timestamp/);
    assert.match(result.stdout, /timer status/);
    assert.doesNotMatch(result.stdout, /result: started/);
    assert.equal(state.eventPosts, index + 1);
    assert.equal(state.events["aw-stopwatch"].length, index + 1);
  }
  const timestamp = "2026-11-15T08:00:00.000000+08:00";
  const id = malformed.length + 1;
  state.faults.eventReply = [{ id, timestamp }];
  const started = await timer("start", "--label", "Valid acknowledgment");
  assert.equal(started.code, 0, started.stdout);
  assert.equal(/^started: "?([^"\n]+)"?$/m.exec(started.stdout)?.[1], timestamp, started.stdout);
  state.faults.eventReply = [{ id }];
  const stopped = await timer("stop", "--id", String(id));
  assert.equal(stopped.code, 0, stopped.stdout);
  state.faults.eventReply = [{ id: id + 1 }];
  const switched = await timer("switch", "--from", "Absent", "--to", "Next");
  assert.equal(switched.code, 0, switched.stdout);
  assert.equal(state.eventPosts, id + 2);
});

test("timer updates refuse inexact numbers in existing event data before writing", async t => {
  const { dir, server, state } = await setup(t);
  const bucket = "aw-stopwatch";
  state.buckets[bucket] = { id: bucket, type: "general.stopwatch" };
  state.nextId = 2;
  const ext = { values: [JSON.rawJSON("9007199254740993"), 0.125] };
  state.events[bucket] = [{ ...event(0, { label: "Reading", running: true, ext }), id: 1 }];
  const timer = (...args) => run(["timer", ...args, "--base-url", server.baseUrl, "--now", "2026-11-15T00:01:00Z"]);
  for (const args of [["stop", "--id", "1"], ["switch", "--from", "Reading", "--to", "Next"]]) {
    const refused = await timer(...args, "--state", dir);
    assert.match(refused.stdout, /code: SERVER/);
    assert.match(refused.stdout, /without rounding/);
    assert.equal(state.eventPosts, 0);
    assert.equal(state.events[bucket][0].data.running, true);
  }
  const noOp = await timer("switch", "--from", "Reading", "--to", "Reading", "--state", dir);
  assert.equal(noOp.code, 0, noOp.stdout);
  assert.match(noOp.stdout, /result: no-op/);
  assert.equal(state.eventPosts, 0);
  state.events[bucket][0].timestamp = JSON.rawJSON("1.0000000000000001");
  ext.values[0] = 0.25;
  const inexactTimestamp = await timer("stop", "--id", "1", "--state", dir);
  assert.match(inexactTimestamp.stdout, /without rounding/);
  assert.equal(state.eventPosts, 0);
  state.events[bucket][0].timestamp = event(0, {}).timestamp;
  state.events[bucket][0].duration = JSON.rawJSON("1.0000000000000001");
  state.events[bucket].push({ ...event(1, { label: "Other", ext: JSON.rawJSON("9007199254740993") }), id: 3 });
  state.nextId = 4;
  ext.values[0] = JSON.rawJSON("1.25e+18");
  const switched = await timer("switch", "--from", "Reading", "--to", "Next", "--state", dir);
  assert.equal(switched.code, 0, switched.stdout);
  assert.equal(state.eventPosts, 2);
  assert.equal(state.events[bucket][0].duration, 60);
  assert.deepEqual(state.events[bucket][0].data.ext, { values: [1250000000000000000, 0.125] });
  const stopped = await timer("stop", "--label", "Next", "--state", dir);
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(state.eventPosts, 3);
});

test("legacy rule export and edit refuse numbers they would round", async t => {
  const { dir, file, server, state } = await setup(t);
  const { category_sets, active_set_ids, classes } = document();
  const number = JSON.rawJSON("1.0000000000000001");
  category_sets[0].extra = { values: [number] };
  state.settings = { category_sets, active_set_ids, classes };
  const exported = path.join(dir, "export.json");
  const response = await run(["rules", "export", "--base-url", server.baseUrl, "--file", exported]);
  assert.match(response.stdout, /without rounding/);
  await assert.rejects(readFile(exported), { code: "ENOENT" });

  const current = await readFile(file);
  const originalRevision = await fileRevision(file);
  const backup = path.join(dir, "restore.json");
  const originalBackup = path.join(dir, "original.json");
  const lossy = JSON.stringify({ ...document(), category_sets });
  await writeFile(backup, lossy);
  const restore = await revert(file, backup);
  assert.equal(restore.code, 0, restore.stdout);
  assert.equal(await readFile(file, "utf8"), lossy);
  assert.equal(await readFile(backup, "utf8"), lossy);
  const restoredRevision = /^revision: ([a-f0-9]{64})$/m.exec(restore.stdout)?.[1];
  assert.equal(restoredRevision, await fileRevision(file));
  const preview = await run(["rules", "preview", "--file", file]);
  assert.match(preview.stdout, /without rounding/);
  const edited = await add(file, dir, "Another");
  assert.match(edited.stdout, /without rounding/);
  assert.equal(await readFile(file, "utf8"), lossy);
  await assert.rejects(readFile(path.join(dir, "backup.json")), { code: "ENOENT" });
  await writeFile(originalBackup, current);
  const restoreOriginal = expect => run(["rules", "revert", "--file", file, "--backup", originalBackup, "--expect", expect]);
  const stale = await restoreOriginal(originalRevision);
  assert.match(stale.stdout, /code: CONFLICT/);
  assert.equal(await readFile(file, "utf8"), lossy);
  const restoredOriginal = await restoreOriginal(restoredRevision);
  assert.equal(restoredOriginal.code, 0, restoredOriginal.stdout);
  assert.match(restoredOriginal.stdout, new RegExp(`^revision: ${originalRevision}$`, "m"));
  assert.deepEqual(await readFile(file), current);
  assert.equal(await readFile(backup, "utf8"), lossy);
});

test("legacy export, preview, and successful edits report the exact file revision", async t => {
  const { dir, server, state } = await setup(t);
  const { category_sets, active_set_ids, classes } = document();
  state.settings = { category_sets, active_set_ids, classes };
  const base = ["--base-url", server.baseUrl];
  const shown = await run(["rules", "show", ...base]);
  const settingsRevision = createHash("sha256").update('{"active_set_ids":["default"],"category_sets":[{"categories":[{"name":["Work"],"rule":{"regex":"^Notes$","type":"regex"}}],"id":"default"}],"classes":[]}').digest("hex");
  assert.match(shown.stdout, new RegExp(`^revision: ${settingsRevision}$`, "m"));
  const exported = path.join(dir, "export.json");
  const exportedResult = await run(["rules", "export", "--file", exported, ...base]);
  const before = await readFile(exported);
  const revision = await fileRevision(exported);
  assert.match(exportedResult.stdout, new RegExp(`^revision: ${revision}$`, "m"));
  const preview = await run(["rules", "preview", "--file", exported]);
  assert.match(preview.stdout, new RegExp(`^revision: ${revision}$`, "m"));
  const backup = path.join(dir, "backup.json");
  const edited = await run(["rules", "add", "--file", exported, "--set", "default", "--name", "Work", "--pattern", "^Editor$",
    "--expect", revision, "--backup", backup]);
  assert.equal(edited.code, 0, edited.stdout);
  const editedRevision = await fileRevision(exported);
  assert.match(edited.stdout, new RegExp(`^revision: ${editedRevision}$`, "m"));
  assert.deepEqual(await readFile(backup), before);
  const restored = await run(["rules", "revert", "--file", exported, "--backup", backup, "--expect", editedRevision]);
  assert.equal(restored.code, 0, restored.stdout);
  assert.match(restored.stdout, new RegExp(`^revision: ${revision}$`, "m"));
  assert.deepEqual(await readFile(exported), before);
});

test("legacy restores with one revision conflict after coverage or extension changes", async t => {
  const { file, dir } = await setup(t);
  const current = document();
  const first = path.join(dir, "first.json");
  const second = path.join(dir, "second.json");
  await writeFile(second, JSON.stringify(current));
  for (const changed of [{ coverage: "server-sets" }, { extension: "first restore" }]) {
    await writeFile(file, JSON.stringify(current));
    const preview = await run(["rules", "preview", "--file", file]);
    const revision = /^revision: ([a-f0-9]{64})$/m.exec(preview.stdout)?.[1];
    assert.ok(revision, preview.stdout);
    const restore = (backup, expect = revision) => run(["rules", "revert", "--file", file, "--backup", backup, "--expect", expect]);
    const inode = (await stat(file)).ino;
    const identical = await restore(second);
    assert.equal(identical.code, 0, identical.stdout);
    assert.match(identical.stdout, /result: no-op/);
    assert.match(identical.stdout, new RegExp(`^revision: ${revision}$`, "m"));
    assert.equal((await stat(file)).ino, inode);
    const firstBytes = JSON.stringify({ ...current, ...changed });
    await writeFile(first, firstBytes);
    const saved = await restore(first);
    assert.equal(saved.code, 0, saved.stdout);
    const stale = await restore(second);
    assert.match(stale.stdout, /code: CONFLICT/);
    const { category_sets, active_set_ids, classes } = current;
    const oldToken = revisionOf({ category_sets, active_set_ids, classes });
    assert.match((await restore(second, oldToken)).stdout, /code: CONFLICT/);
    assert.equal(await readFile(file, "utf8"), firstBytes);
  }
});

test("uncategorized ignores replay-only numbers but still validates rule schema", async t => {
  const { file, server, state, activity } = await setup(t);
  const doc = document();
  const inexact = JSON.rawJSON("9007199254740993");
  doc.extra = { weight: inexact };
  doc.category_sets[0].extra = { priority: inexact };
  doc.category_sets[0].categories[0].rule.extra = { weight: inexact };
  doc.classes = [{ ...doc.category_sets[0].categories[0], extra: inexact }];
  const configure = async () => {
    const { category_sets, active_set_ids, classes } = doc;
    state.settings = { category_sets, active_set_ids, classes };
    await writeFile(file, JSON.stringify(doc));
  };
  const runServer = () => run(["uncategorized", "--server-rules", "--base-url", server.baseUrl, ...range]);
  await configure();
  for (const result of [await activity(), await runServer()]) {
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Editor,3600/);
  }
  assert.ok(state.requests.every(request => request.path !== "/api/0/settings/classes"));
  doc.category_sets[0].categories[0].rule.priority = JSON.rawJSON("1.0000000000000001");
  state.requests.length = 0;
  await configure();
  for (const result of [await activity(), await runServer()]) {
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout, /code: (VALIDATION_ERROR|UNSUPPORTED)/);
  }
  assert.ok(state.requests.every(request => request.path.startsWith("/api/0/settings/")));
});

test("views refuse inexact numbers before backup and during confirmation", async t => {
  const { dir, server, state } = await setup(t);
  const number = JSON.rawJSON("9007199254740993");
  const selected = { id: "summary", elements: [] };
  const other = { id: "other", elements: [{ type: "graph", props: { number } }] };
  state.settings.views = [selected, other];
  const addView = (revision, backup) => run(["views", "add-stopwatch", "--id", "summary", "--base-url",
    server.baseUrl, "--state", dir, "--expect", revision, "--backup", backup]);
  const initial = await run(["views", "show", "--base-url", server.baseUrl]);
  assert.match(initial.stdout, /without rounding/);
  const rounded = JSON.parse(JSON.stringify(state.settings.views));
  const backup = path.join(dir, "views.json");
  const refused = await addView(revisionOf(rounded), backup);
  assert.match(refused.stdout, /without rounding/);
  await assert.rejects(readFile(backup), { code: "ENOENT" });
  assert.equal(state.settingsPosts, 0);

  state.settings.views = rounded;
  state.faults.replaceAfterWrite = {
    key: "views", replace: [{ ...selected, elements: [{ type: "top_stopwatches", props: {} }] }, other],
  };
  const uncertain = await addView(revisionOf(rounded), backup);
  assert.match(uncertain.stdout, /code: UNCERTAIN_WRITE/);
  assert.ok(uncertain.stdout.includes(backup));
  assert.equal(state.settingsPosts, 1);
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")).views, rounded);
});

test("timer start and uncategorized reject impossible dates before contacting the server", async t => {
  const { dir, server, state } = await setup(t);
  const start = (now, label = "Calendar") => run([
    "timer", "start", "--label", label, "--base-url", server.baseUrl, "--state", dir, "--now", now,
  ]);
  for (const now of ["2026-02-30T12:00:00Z", "2026-04-31T12:00:00+08:00", "2026-02-29T12:00:00Z",
    "30 Feb 2026 12:00:00 GMT", "Feb 30, 2026 12:00:00 GMT", "Thu, 29 Feb 2024 12:00:00 GMT+0800",
    "Thu Feb 29 2024 12:00:00 GMT+0800"]) {
    const refused = await start(now);
    assert.match(refused.stdout, /code: VALIDATION_ERROR/);
    assert.equal(state.requests.length, 0);
  }
  const { category_sets, active_set_ids, classes } = document();
  state.settings = { category_sets, active_set_ids, classes };
  const uncategorized = now => run(["uncategorized", "--server-rules", "--base-url", server.baseUrl, ...range, "--now", now]);
  const refused = await uncategorized("30 Feb 2026 12:00:00 GMT");
  assert.match(refused.stdout, /code: VALIDATION_ERROR/);
  assert.equal(state.requests.length, 0);

  const categorized = await uncategorized("2026-11-15T01:00:00Z");
  assert.equal(categorized.code, 0, categorized.stdout);
  assert.match(categorized.stdout, /rules_scope: server-sets-only/);
  assert.match(categorized.stdout, /Editor,3600/);

  for (const [index, now] of ["2024-02-29T12:00:00+08:00", "2024-02-29T12:00:00+0800"].entries()) {
    const started = await start(now, `Calendar ${index}`);
    assert.equal(started.code, 0, started.stdout);
    assert.equal(state.events["aw-stopwatch"][index].timestamp, "2024-02-29T04:00:00.000Z");
  }
});

test("local range endpoints reject hidden offsets before activity reads", async t => {
  const { file, server, state } = await setup(t);
  const commands = [["totals", "--label", "Reading"], ["uncategorized", "--rules", file], ["--tui", "--once"]];
  const pairs = [
    ["2026-11-15T00:00:00+08:00[Asia/Taipei]", "2026-11-15T01:00:00"],
    ["2026-11-15T00:00:00", "2026-11-15T01:00:00-08"],
    ["2026-11-15T00:00:00", "2026-11-15T01:00:00+0800[u-ca=iso8601]"],
    ["2026-11-15T00:00:00[Asia/Taipei]", "2026-11-15T01:00:00"],
    ["2026-11-15T00:00:00", "2026-11-15T01:00:00[+08:00]"],
  ];
  for (const command of commands) {
    for (const [start, end] of pairs) {
      const refused = await run([...command, "--base-url", server.baseUrl, "--start", start, "--end", end, "--timezone", "UTC"]);
      assert.notEqual(refused.code, 0, refused.stdout);
      assert.match(refused.stdout, /without an offset/);
      assert.deepEqual(state.requests, []);
    }
  }
  for (const [start, end] of [
    ["2026-11-15T00:00:00", "2026-11-15T01:00:00"],
    ["2026-11-15T00:00:00[u-ca=iso8601]", "2026-11-15T01:00:00[u-ca=iso8601]"],
  ]) {
    const accepted = await run(["uncategorized", "--rules", file, "--base-url", server.baseUrl,
      "--start", start, "--end", end, "--timezone", "UTC"]);
    assert.equal(accepted.code, 0, accepted.stdout);
    assert.match(accepted.stdout, /Editor,3600/);
  }
  const dates = await run(["totals", "--label", "Reading", "--base-url", server.baseUrl,
    "--start", "2026-11-15", "--end", "2026-11-16", "--timezone", "UTC"]);
  assert.equal(dates.code, 0, dates.stdout);
});

test("legacy add and revert atomically replace the file behind a symlink", async t => {
  const { file, dir } = await setup(t);
  const link = path.join(dir, "linked-rules.json");
  const backup = path.join(dir, "backup.json");
  await symlink(file, link);
  const originalGroup = (await stat(file)).gid;
  const otherGroup = process.getgroups().find(gid => gid !== originalGroup);
  if (otherGroup !== undefined) await chown(file, process.getuid(), otherGroup);
  await chmod(file, 0o640);
  const identity = async () => {
    const { uid, gid, mode } = await stat(file);
    return { uid, gid, mode: mode & 0o777 };
  };
  const owner = await identity();
  const before = await readFile(file);
  const old = await open(file);
  t.after(() => old.close());
  const added = await add(link, dir, "^Editor$");
  assert.equal(added.code, 0, added.stdout);
  const edited = await readFile(file);
  assert.notDeepEqual(edited, before);
  assert.deepEqual(await old.readFile(), before);
  assert.deepEqual(await readFile(backup), before);
  assert.deepEqual(await readFile(link), edited);
  assert.deepEqual(await identity(), owner);

  const previous = await open(file);
  t.after(() => previous.close());
  const restored = await revert(link, backup);
  assert.equal(restored.code, 0, restored.stdout);
  assert.deepEqual(await previous.readFile(), edited);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(link), before);
  assert.deepEqual(await identity(), owner);
});

test("legacy regex alternatives refuse capture-sensitive composition before writing", async t => {
  const { file, dir, activity, state } = await setup(t);
  const backup = path.join(dir, "backup.json");
  for (const [existing, addition] of [
    ["^(a)\\1$", "^(b)\\1$"],
    ["^(a)$", "^(b)\\1$"],
    ["^\\1$", "^(b)$"],
    ["^(?<tag>a)\\k<tag>$", "^b$"],
    ["^(?<tag>a)$", "[\\k]"],
  ]) {
    const doc = document();
    doc.category_sets[0].categories[0].rule.regex = existing;
    const bytes = JSON.stringify(doc);
    await writeFile(file, bytes);
    const result = await add(file, dir, addition);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(await readFile(file, "utf8"), bytes);
    await assert.rejects(readFile(backup), { code: "ENOENT" });
  }

  const doc = document();
  doc.category_sets[0].categories[0].rule.regex = "^(?<first>a)$";
  await writeFile(file, JSON.stringify(doc));
  const added = await add(file, dir, "^(?<second>b)$");
  assert.equal(added.code, 0, added.stdout);
  for (const app of ["a", "b"]) {
    state.events.window = [event(3600, { app })];
    const result = await activity();
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /apps_count: 0/);
  }
});

test("legacy replacement refuses ACL-protected rules", { skip: process.platform !== "darwin" }, async t => {
  const { file, dir } = await setup(t);
  const before = await readFile(file);
  const backup = path.join(dir, "restore.json");
  await writeFile(backup, Buffer.concat([before, Buffer.from("\n")]));
  await chmod(file, 0o640);
  execFileSync("chmod", ["+a", "nobody deny read", file]);
  const inode = (await stat(file)).ino;
  for (const edit of [() => add(file, dir, "^Editor$"), () => revert(file, backup)]) {
    const result = await edit();
    assert.match(result.stdout, /UNSUPPORTED/);
    assert.equal((await stat(file)).ino, inode);
    assert.deepEqual(await readFile(file), before);
    assert.match(execFileSync("ls", ["-lde", file], { encoding: "utf8" }), /^ +0: \S+ deny read$/m);
  }
  await assert.rejects(readFile(path.join(dir, "backup.json")), { code: "ENOENT" });
});

test("explicit paths resolve dot-dot after following directory symlinks", async t => {
  const { file, dir, server } = await setup(t);
  const other = path.join(dir, "other");
  const subdir = path.join(other, "subdir");
  const link = path.join(dir, "link");
  await mkdir(subdir, { recursive: true });
  await symlink(subdir, link);
  const requested = path.relative(root, link) + "/../rules.json";
  const backup = path.relative(root, link) + "/../backup.json";
  const actual = path.join(other, "rules.json");
  const untouched = await readFile(file);
  const doc = document();
  doc.category_sets[0].categories[0].rule.regex = "^Other$";
  await writeFile(actual, JSON.stringify(doc));
  const shown = await run(["rules", "preview", "--full", "--file", requested]);
  assert.equal(shown.code, 0, shown.stdout);
  assert.match(shown.stdout, /\^Other\$/);
  const added = await run([
    "rules", "add", "--file", requested, "--set", "default", "--name", "Work",
    "--pattern", "^Editor$", "--expect", await fileRevision(actual), "--backup", backup,
  ]);
  assert.equal(added.code, 0, added.stdout);
  assert.deepEqual(await readFile(file), untouched);
  assert.match(await readFile(actual, "utf8"), /\^Other\$\|\^Editor\$/);
  assert.equal(await readFile(path.join(other, "backup.json"), "utf8"), JSON.stringify(doc));
  const uncategorized = await run(["uncategorized", "--rules", requested, "--base-url", server.baseUrl, ...range]);
  assert.equal(uncategorized.code, 0, uncategorized.stdout);
  assert.match(uncategorized.stdout, /apps_count: 0/);
  assert.equal((await revert(requested, backup)).code, 0);
  assert.equal(await readFile(actual, "utf8"), JSON.stringify(doc));
  await assert.rejects(readFile(path.join(dir, "backup.json")), { code: "ENOENT" });

  const locks = path.relative(root, link) + "/../locks";
  const started = await run(["timer", "start", "--label", "Editor", "--base-url", server.baseUrl, "--state", locks]);
  assert.equal(started.code, 0, started.stdout);
  assert.equal((await stat(path.join(other, "locks"))).isDirectory(), true);
  await assert.rejects(stat(path.join(dir, "locks")), { code: "ENOENT" });
});

test("explicit empty targets refuse before contacting the synthetic server", async t => {
  const { dir, file, server, state } = await setup(t);
  const env = { AWAXI_BASE_URL: server.baseUrl, AWAXI_STATE: dir, AWAXI_NOW: "2026-11-15T01:00:00Z" };
  for (const [args, flag] of [
    [["timer", "start", "--label", "Work"], "--base-url"],
    [["timer", "start", "--label", "Work"], "--state"],
    [["timer", "start", "--label", "Work"], "--now"],
    [["timer", "start", "--label", "Work"], "--bucket"],
    [["--tui", "--once", ...range], "--bucket"],
    [["--tui", "--once", ...range], "--host"],
    [["uncategorized", "--rules", file, ...range], "--host"],
    [["uncategorized", "--server-rules", ...range], "--rules"],
    [["views", "show"], "--id"],
    [["rules", "export", "--native"], "--file"],
  ]) {
    for (const value of [[flag, ""], [flag + "="]]) {
      const result = await run([...args, ...value], { env });
      assert.equal(result.code, 2, flag + result.stdout);
      assert.ok(result.stdout.includes(flag), result.stdout);
      assert.deepEqual(state.requests, []);
    }
  }
  const omitted = await run(["timer", "start", "--label", "Work"], { env });
  assert.equal(omitted.code, 0, omitted.stdout);
  assert.equal(state.eventPosts, 1);
});

test("malformed and credential-bearing URLs do not leak input to CLI or dashboard output", async () => {
  for (const args of [["timer", "status"], ["--tui", "--once"]]) {
    for (const url of ["http://synthetic-user:dummy-secret@", "http://synthetic-user:dummy-secret@localhost"]) {
      const result = await run([...args, "--base-url", url]);
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, /base-url|username or password/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-user|dummy-secret/);
    }
  }
});

test("review URL components are rejected before contacting the server", async t => {
  const { server, state, dir } = await setup(t);
  const args = ["timer", "start", "--label", "Work", "--state", dir];
  for (const suffix of ["/synthetic-path", "/synthetic-path/..", "?synthetic-query", "#synthetic-fragment", "?", "#"]) {
    const result = await run([...args, "--base-url", server.baseUrl + suffix]);
    assert.equal(result.code, 2, result.stdout);
    assert.doesNotMatch(result.stdout, /synthetic-(path|query|fragment)/);
    assert.deepEqual(state.requests, []);
  }
  const env = { AWAXI_BASE_URL: server.baseUrl + "/synthetic-path" };
  assert.equal((await run(["--tui", "--once"], { env })).code, 2);
  assert.deepEqual(state.requests, []);
  assert.equal((await run([...args, "--base-url", server.baseUrl + "/"])).code, 0);
  assert.equal(state.eventPosts, 1);
});

test("review explicit blank match fields leave existing and new rules untouched", async t => {
  const { file, dir } = await setup(t);
  const original = await readFile(file);
  for (const flags of [["--select-keys="], ["--select-keys", ", ,"]]) {
    for (const newCategory of [false, true]) {
      const args = [
        "rules", "add", "--file", file, "--set", "default", "--name", newCategory ? "New" : "Work",
        "--pattern", "^Editor$", "--expect", await fileRevision(file), "--backup", path.join(dir, "backup.json"),
      ];
      const result = await run([...args, ...flags]);
      assert.equal(result.code, 2, result.stdout);
      assert.deepEqual(await readFile(file), original);
      await assert.rejects(readFile(path.join(dir, "backup.json")), { code: "ENOENT" });
    }
  }
});

test("review legacy preview can inspect stale selections without enabling their use", async t => {
  const { file, dir, activity, state } = await setup(t);
  const backup = path.join(dir, "stale.json");
  const doc = document();
  doc.active_set_ids.push("deleted");
  await writeFile(backup, JSON.stringify(doc));
  const preview = await run(["rules", "preview", "--file", backup, "--full"]);
  assert.equal(preview.code, 0, preview.stdout);
  assert.match(preview.stdout, /coverage: incomplete/);
  assert.match(preview.stdout, /\^Notes\$/);
  assert.notEqual((await revert(file, backup)).code, 0);
  await writeFile(file, JSON.stringify(doc));
  assert.notEqual((await add(file, dir, "^Editor$")).code, 0);
  assert.notEqual((await activity()).code, 0);
  assert.deepEqual(state.requests, []);
  doc.category_sets[0].categories[0].name = 42;
  await writeFile(backup, JSON.stringify(doc));
  assert.notEqual((await run(["rules", "preview", "--file", backup, "--full"])).code, 0);
});

test("fully classified overlaps preserve app and domain identity", async t => {
  const { activity, state } = await setup(t);
  for (const [bucket, events] of [
    ["window", [event(60, { app: "Notes" }), event(60, { app: "Editor", title: "Notes" })]],
    ["web", [event(60, { url: "https://first.test", title: "Notes" }), event(60, { url: "https://second.test", title: "Notes" })]],
  ]) {
    state.events.window = [];
    state.events.web = [];
    state.events[bucket] = events;
    const refused = await activity();
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stdout, /INCOMPLETE/);
    assert.doesNotMatch(refused.stdout, /apps_count|domains_count/);
  }
  state.events.window = [event(60, { app: "Notes" }), event(60, { app: "Notes" })];
  state.events.web = [event(60, { url: "https://first.test/a", title: "Notes" }), event(60, { url: "https://first.test/b", title: "Notes" })];
  const result = await activity();
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /apps_count: 0/);
  assert.match(result.stdout, /domains_count: 0/);
});

test("review legacy edits recheck target identity and bytes after backup or staging", async t => {
  const { file, dir } = await setup(t);
  const original = await readFile(file);
  const link = path.join(dir, "current.json");
  const alternate = path.join(dir, "alternate.json");
  const backup = path.join(dir, "backup.json");
  const changed = Buffer.concat([original, Buffer.from("\n")]);
  await writeFile(alternate, original);
  for (const action of ["add", "revert"]) {
    for (const retarget of [true, false]) {
      await writeFile(file, original);
      await symlink(file, link);
      if (action === "revert") await writeFile(backup, Buffer.concat([changed, Buffer.from("\n")]));
      const nodeArgs = preloadArgs(`
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const writeFile = fs.writeFile;
        fs.writeFile = async (name, ...args) => {
          await writeFile(name, ...args);
          if (${action === "add"} && name !== ${JSON.stringify(backup)}) return;
          if (${retarget}) {
            await fs.unlink(${JSON.stringify(link)});
            await fs.symlink(${JSON.stringify(alternate)}, ${JSON.stringify(link)});
          } else await writeFile(${JSON.stringify(file)}, ${JSON.stringify(changed.toString())});
        };
        syncBuiltinESMExports();
      `);
      const result = action === "add"
        ? await add(link, dir, "^Editor$", [], "backup.json", { nodeArgs })
        : await revert(link, backup, { nodeArgs });
      assert.match(result.stdout, /CONFLICT/);
      assert.deepEqual(await readFile(file), retarget ? original : changed);
      assert.deepEqual(await readFile(alternate), original);
      await rm(link);
      await rm(backup);
    }
  }
});

test("concurrent legacy add and revert through aliases cannot both use one revision", { timeout: 10000 }, async t => {
  const { file, dir } = await setup(t);
  const original = await readFile(file);
  const revision = await fileRevision(file);
  const link = path.join(dir, "current.json");
  await symlink(file, link);
  const addBackup = path.join(dir, "add-backup.json");
  const restoreBackup = path.join(dir, "restore-backup.json");
  const restoreDoc = document();
  restoreDoc.category_sets[0].categories[0].rule.regex = "^Restore$";
  const restoreBytes = JSON.stringify(restoreDoc);
  await writeFile(restoreBackup, restoreBytes);
  const ready = Promise.withResolvers();
  const adding = run(["rules", "add", "--file", file, "--set", "default", "--name", "Work", "--pattern", "^Editor$",
    "--expect", revision, "--backup", addBackup], {
    nodeArgs: preloadArgs(`
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const rename = fs.rename;
      fs.rename = async (...args) => {
        await new Promise(resolve => {
          process.once("message", resolve);
          process.send("rename-ready");
        });
        return rename(...args);
      };
      syncBuiltinESMExports();
    `),
    onMessage: (_, child) => ready.resolve(child),
  });
  const addingChild = await Promise.race([ready.promise, adding.then(result => { throw new Error(result.stdout + result.stderr); })]);
  t.after(() => { if (addingChild.exitCode === null) addingChild.kill(); });
  let released = false;
  const releaseAdd = () => {
    if (released) return;
    released = true;
    if (addingChild.connected) addingChild.send("continue");
  };
  const reverting = run(["rules", "revert", "--file", link, "--backup", restoreBackup, "--expect", revision], {
    nodeArgs: preloadArgs(`
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.open;
      fs.open = async (...args) => {
        try { return await open(...args); }
        catch (error) {
          if (error.code === "EEXIST") process.send("lock-held");
          throw error;
        }
      };
      syncBuiltinESMExports();
    `),
    onMessage: releaseAdd,
  });
  const reverted = await reverting;
  releaseAdd();
  const added = await adding;
  assert.equal(added.code, 0, added.stdout);
  assert.match(added.stdout, /result: updated/);
  assert.match(reverted.stdout, /code: CONFLICT/);
  assert.deepEqual(await readFile(addBackup), original);
  assert.equal(await readFile(restoreBackup, "utf8"), restoreBytes);
  assert.match(JSON.parse(await readFile(file, "utf8")).category_sets[0].categories[0].rule.regex, /Editor/);
});

test("review view updates recheck the revision after the backup", async t => {
  const { dir, server, state } = await setup(t);
  const views = [{ id: "summary", elements: [] }];
  const changed = [...views, { id: "another", elements: [] }];
  state.settings.views = views;
  const backup = path.join(dir, "views.json");
  const nodeArgs = preloadArgs(`
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const writeFile = fs.writeFile;
    fs.writeFile = async (name, ...args) => {
      await writeFile(name, ...args);
      if (name !== ${JSON.stringify(backup)}) return;
      const response = await fetch(${JSON.stringify(server.baseUrl + "/api/0/settings/views")}, {
        method: "POST", body: ${JSON.stringify(JSON.stringify(changed))},
      });
      if (!response.ok) throw new Error("Synthetic view edit failed");
    };
    syncBuiltinESMExports();
  `);
  const result = await run([
    "views", "add-stopwatch", "--id", "summary", "--base-url", server.baseUrl,
    "--state", dir, "--backup", backup, "--expect", revisionOf(views),
  ], { nodeArgs });
  assert.match(result.stdout, /CONFLICT/);
  assert.deepEqual(state.settings.views, changed);
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")).views, views);
  assert.equal(state.settingsPosts, 1);
  const updated = await run([
    "views", "add-stopwatch", "--id", "summary", "--base-url", server.baseUrl,
    "--state", dir, "--backup", path.join(dir, "fresh-views.json"), "--expect", revisionOf(changed),
  ]);
  assert.equal(updated.code, 0, updated.stdout);
  assert.deepEqual(state.settings.views, [
    { id: "summary", elements: [{ type: "top_stopwatches", props: {} }] }, changed[1],
  ]);
});

test("views reports a failed confirmation as an uncertain write", async t => {
  const { dir, server, state } = await setup(t);
  const views = [{ id: "summary", elements: [] }];
  state.settings.views = views;
  const subdir = path.join(dir, "other", "subdir");
  await mkdir(subdir, { recursive: true });
  const link = path.join(dir, "link");
  await symlink(subdir, link);
  const backup = link + "/../views.json";
  const nodeArgs = preloadArgs(`
    const request = fetch;
    let wrote = false;
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/api/0/settings/views") && wrote) throw new Error("Synthetic read failure");
      const response = await request(url, options);
      if (url.endsWith("/api/0/settings/views") && options.method === "POST") wrote = true;
      return response;
    };
  `);
  const result = await run([
    "views", "add-stopwatch", "--id", "summary", "--base-url", server.baseUrl,
    "--state", dir, "--backup", backup, "--expect", revisionOf(views),
  ], { nodeArgs });
  assert.match(result.stdout, /UNCERTAIN_WRITE/);
  assert.ok(result.stdout.includes(backup), result.stdout);
  assert.equal(state.settingsPosts, 1);
  assert.equal(state.settings.views[0].elements[0].type, "top_stopwatches");
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")).views, views);
  await assert.rejects(readFile(path.join(dir, "views.json")), { code: "ENOENT" });
});

test("views gives the saved backup when a committed POST loses its response", async t => {
  const { dir, server, state } = await setup(t);
  const views = [{ id: "summary", elements: [] }];
  state.settings.views = views;
  state.faults.dropSettingWrite = "views";
  const backup = path.join(dir, "before-views.json");
  const result = await run([
    "views", "add-stopwatch", "--id", "summary", "--base-url", server.baseUrl,
    "--state", dir, "--backup", backup, "--expect", revisionOf(views),
  ]);
  assert.match(result.stdout, /code: UNCERTAIN_WRITE/);
  assert.match(result.stdout, /views show/);
  assert.ok(result.stdout.includes(backup), result.stdout);
  assert.doesNotMatch(result.stdout, /timer status/);
  assert.equal(state.settingsPosts, 1);
  assert.equal(state.settings.views[0].elements[0].type, "top_stopwatches");
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")).views, views);
});

function pythonReply(value, space, spaced = false) {
  let json = JSON.stringify(value, null, space);
  if (spaced) json = json.replace(/"(?:[^"\\]+|\\[\s\S])*"|[:,]/g, token => token.length === 1 ? token + " " : token);
  return json.replace(/[\u007f-\uffff]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

function pythonDecode(input, compact = false) {
  const script = "import json, sys; print(json.dumps(json.load(sys.stdin), separators=(',', ':') if sys.argv[1] == 'true' else None))";
  return execFileSync("python3", ["-c", script, String(compact)], {
    input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
}

async function setupNative(t, { python = false, debug = false, pythonNumbers = false } = {}) {
  const dir = await mkdtemp(path.join(root, ".review-test-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const digest = "ecbfd637750abb8f7da32dbc32a8f6d41ba167f28dfb8ec0512e304429a94a40";
  const bundle = "synthetic native webUI";
  const version = python ? "v0.14.2" : "v0.14.2 (rust)";
  const state = { settings: {}, mutations: 0, requests: [] };
  const connections = new WeakMap();
  let nextConnection = 1;
  const server = http.createServer(async (req, res) => {
    if (!connections.has(req.socket)) connections.set(req.socket, nextConnection++);
    state.requests.push({ method: req.method, path: req.url, connection: connections.get(req.socket) });
    if (req.url === "/") return res.end('<script src="/js/index.15e65e70.js"></script>');
    if (req.url === "/js/index.15e65e70.js") return res.end(bundle);
    if (req.url === "/api/0/info") return res.end(JSON.stringify({ version }));
    if (req.url === (python ? "/api/0/settings" : "/api/0/settings/")) {
      if (pythonNumbers) return res.end(pythonDecode(JSON.stringify(state.settings), true));
      return res.end(python ? pythonReply(state.settings, debug ? 2 : 0) : JSON.stringify(state.settings));
    }
    const key = req.url.split("/").at(-1);
    if (req.method === "DELETE") delete state.settings[key];
    else if (req.method === "POST") {
      state.mutations += 1;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const decoded = pythonNumbers ? pythonDecode(body) : null;
      const value = decoded === null ? JSON.parse(body) : JSON.parse(decoded, (_, number, context) =>
        typeof number === "number" && JSON.stringify(number) !== context.source ? JSON.rawJSON(context.source) : number);
      if (state.rejectPost?.(value)) {
        res.statusCode = 400;
        return res.end();
      }
      if (python && value === null) delete state.settings[key];
      else state.settings[key] = value;
      if (state.mutations === state.dropAt) return res.destroy();
      if (python) return res.end(decoded ?? pythonReply(value, debug ? 4 : 0, !debug));
      res.statusCode = 201;
      return res.end();
    } else {
      res.statusCode = 404;
      return res.end();
    }
    state.mutations += 1;
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.notEqual(server.address().port, 5600);
  const base = "http://127.0.0.1:" + server.address().port;
  const target = { base_url: base, server_version: version, webui_sha256: digest };
  const backup = path.join(dir, "backup.json");
  const outgoing = path.join(dir, "outgoing.json");
  await writeFile(backup, JSON.stringify({
    format: "activitywatch-axi.native-rules-backup.v1",
    target,
    revision: revisionOf({}),
    settings: {},
  }));

  const preload = `
    import crypto from "node:crypto";
    import { syncBuiltinESMExports } from "node:module";
    const createHash = crypto.createHash;
    crypto.createHash = (...args) => {
      const hash = createHash(...args);
      const update = hash.update.bind(hash);
      hash.update = (content, ...options) => content === ${JSON.stringify(bundle)}
        ? { digest: () => ${JSON.stringify(digest)} }
        : update(content, ...options);
      return hash;
    };
    syncBuiltinESMExports();
  `;
  const options = { nodeArgs: preloadArgs(preload) };
  const native = (command, extra) => run(["rules", command, "--base-url", base, ...extra], options);
  const restore = (from, to) => run([
    "rules", "revert", "--native", "--server", "--base-url", base, "--state", dir,
    "--backup", from, "--save-backup", to, "--expect", revisionOf(state.settings),
  ], options);
  return { backup, dir, outgoing, native, restore, state, target };
}

test("native restore only writes when its outgoing settings can be restored", async t => {
  const { backup, dir, outgoing, restore, state } = await setupNative(t);
  for (const invalid of [
    { category_sets: { future: true } },
    { category_sets: [{ id: "bad", categories: [false] }] },
    { active_set_ids: [false] },
    { classes: [{ name: ["Work"] }] },
  ]) {
    state.settings = structuredClone(invalid);
    const result = await restore(backup, outgoing);
    assert.match(result.stdout, /UNSUPPORTED/);
    assert.deepEqual(state.settings, invalid);
    assert.equal(state.mutations, 0);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }

  state.settings = { classes: [{
    name: ["Work"], rule: { type: "none" },
    text: "x".repeat(8 * 1024 * 1024 - 1000),
    values: Array(250).fill(0),
  }] };
  const oversized = await restore(backup, outgoing);
  assert.match(oversized.stdout, /backup would exceed the 8 MiB restore limit/);
  assert.equal(state.mutations, 0);
  await assert.rejects(readFile(outgoing), { code: "ENOENT" });

  const partial = { classes: null, category_sets: document().category_sets, unrelated: 42 };
  state.settings = structuredClone(partial);
  const restored = await restore(backup, outgoing);
  assert.equal(restored.code, 0, restored.stdout);
  assert.deepEqual(state.settings, { unrelated: 42 });
  const reversed = await restore(outgoing, path.join(dir, "reverse-backup.json"));
  assert.equal(reversed.code, 0, reversed.stdout);
  assert.deepEqual(state.settings, partial);
});

test("native settings preflight includes the Python GET encoding and terminator", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t, { python: true });
  const doc = document();
  const before = { category_sets: doc.category_sets, active_set_ids: doc.active_set_ids, classes: doc.category_sets[0].categories };
  const after = structuredClone(before);
  after.category_sets.push({
    id: "inactive",
    categories: [{ name: ["Other"], rule: { type: "none" }, padding: "é".repeat(800_000) }],
  });
  const file = path.join(dir, "desired.json");
  const backup = path.join(dir, "desired-backup.json");
  await writeFile(file, JSON.stringify({ format: "activitywatch-axi.native-rules.v1", coverage: "complete", target, settings: after }));
  await writeFile(backup, JSON.stringify({ format: "activitywatch-axi.native-rules-backup.v1", target, revision: revisionOf(after), settings: after }));
  const bytesAtLimitWithoutNewline = 8 * 1024 * 1024 - (pythonReply({ ...after, unrelated: "" }).length - 1);
  state.settings = { ...before, unrelated: "x".repeat(bytesAtLimitWithoutNewline) };
  const expect = revisionOf(state.settings);
  for (const action of [
    () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]),
    () => restore(backup, outgoing),
  ]) {
    const result = await action();
    assert.match(result.stdout, /UNSUPPORTED/);
    assert.equal(state.mutations, 0);
    assert.equal(revisionOf(state.settings), expect);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
  state.settings.unrelated = state.settings.unrelated.slice(1);
  const accepted = await restore(backup, outgoing);
  assert.equal(accepted.code, 0, accepted.stdout);
  assert.equal(state.mutations, 1);
  assert.equal(pythonReply(state.settings).length, 8 * 1024 * 1024);
});

test("native settings preflight bounds Python POST formatting separately", async t => {
  for (const debug of [false, true]) {
    const { dir, outgoing, restore, state, target } = await setupNative(t, { python: true, debug });
    state.settings = { unrelated: true };
    const values = Array(debug ? 100_000 : 500_000).fill(0);
    const category = { name: ["Work"], rule: { type: "none" }, padding: "é".repeat(debug ? 1_210_000 : 1_200_000), values };
    const settings = { classes: [category] };
    assert.ok(pythonReply(settings, debug ? 2 : 0).length <= 8 * 1024 * 1024);
    assert.ok(pythonReply(settings.classes, debug ? 4 : 0, !debug).length > 8 * 1024 * 1024);
    const backup = path.join(dir, "desired-backup.json");
    await writeFile(backup, JSON.stringify({ format: "activitywatch-axi.native-rules-backup.v1", target, revision: revisionOf(settings), settings }));
    const result = await restore(backup, outgoing);
    assert.match(result.stdout, /UNSUPPORTED/);
    assert.equal(state.mutations, 0);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
});

test("review native apply and restore preflight intermediate settings", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const category = (length) => ({ name: ["Work"], rule: { type: "none" }, padding: "x".repeat(length) });
  const taxonomy = (active, inactive) => ({
    category_sets: [{ id: "default", categories: [active] }, { id: "inactive", categories: inactive }],
    active_set_ids: ["default"],
    classes: [active],
  });
  const settings = taxonomy(category(900_000), []);
  state.settings = { ...settings, unrelated: "x".repeat(6_500_000) };
  const desired = taxonomy(category(100_000), [category(1_300_000)]);
  const input = path.join(dir, "document.json");
  const backup = path.join(dir, "input-backup.json");
  await writeFile(input, JSON.stringify({ format: "activitywatch-axi.native-rules.v1", coverage: "complete", target, settings: desired }));
  await writeFile(backup, JSON.stringify({ format: "activitywatch-axi.native-rules-backup.v1", target, revision: revisionOf(desired), settings: desired }));
  const current = revisionOf(state.settings);
  for (const action of [
    () => native("apply", ["--server", "--file", input, "--state", dir, "--expect", current, "--backup", outgoing]),
    () => restore(backup, outgoing),
  ]) {
    const result = await action();
    assert.match(result.stdout, /UNSUPPORTED/);
    assert.equal(state.mutations, 0);
    assert.equal(revisionOf(state.settings), current);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
});

function nativeTaxonomy(active = {}, inactive = {}) {
  const category = { name: ["Work"], rule: { type: "none" }, ...active };
  return {
    category_sets: [{ id: "default", categories: [category] }, { id: "inactive", categories: [], ...inactive }],
    active_set_ids: ["default"],
    classes: [category],
  };
}

async function nativeInputs(dir, target, settings) {
  const file = path.join(dir, "desired.json");
  const backup = path.join(dir, "desired-backup.json");
  await writeFile(file, JSON.stringify({ format: "activitywatch-axi.native-rules.v1", coverage: "complete", target, settings }));
  const revision = revisionOf(JSON.parse(JSON.stringify(settings)));
  await writeFile(backup, JSON.stringify({ format: "activitywatch-axi.native-rules-backup.v1", target, revision, settings }));
  return { file, backup };
}

test("native Rust refuses unsupported payloads before backup creation or POST", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const rejects = (value, depth = 0) => {
    if (typeof value === "string") return !value.isWellFormed();
    return value !== null && typeof value === "object" && (depth === 127 ||
      Object.entries(value).some(([key, child]) => !key.isWellFormed() || rejects(child, depth + 1)));
  };
  state.rejectPost = rejects;
  const before = nativeTaxonomy();
  state.settings = structuredClone(before);
  const apply = file => native("apply", ["--server", "--file", file, "--state", dir, "--expect", revisionOf(before), "--backup", outgoing]);
  let nested = "valid 🐈";
  for (let depth = 0; depth < 125; depth++) nested = [nested];
  for (const extension of [{ value: "\ud800" }, { "\udfff": true }, { value: [nested] }]) {
    const desired = nativeTaxonomy({}, extension);
    assert.ok(rejects(desired.category_sets));
    const { file, backup } = await nativeInputs(dir, target, desired);
    for (const operation of [() => apply(file), () => restore(backup, outgoing)]) {
      const refused = await operation();
      assert.match(refused.stdout, /code: UNSUPPORTED/);
      assert.equal(state.mutations, 0);
      assert.deepEqual(state.settings, before);
      await assert.rejects(readFile(outgoing), { code: "ENOENT" });
    }
  }
  const desired = nativeTaxonomy({}, { "clé 🐈": nested });
  assert.equal(rejects(desired.category_sets), false);
  const { file } = await nativeInputs(dir, target, desired);
  const applied = await apply(file);
  assert.equal(applied.code, 0, applied.stdout);
  assert.deepEqual(state.settings, desired);
  const restored = await restore(outgoing, path.join(dir, "reverse.json"));
  assert.equal(restored.code, 0, restored.stdout);
  assert.deepEqual(state.settings, before);
});

test("native documents reject invalid UTF-8 before preview, apply, or revert", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy();
  state.settings = structuredClone(before);
  const desired = nativeTaxonomy({ rule: { type: "regex", regex: "^Café$" } });
  const { file, backup } = await nativeInputs(dir, target, desired);
  const preview = () => run(["rules", "preview", "--native", "--file", file, "--full"]);
  const valid = await preview();
  assert.equal(valid.code, 0, valid.stdout);
  assert.match(valid.stdout, /Café/);
  for (const input of [file, backup]) {
    const original = await readFile(input, "utf8");
    await writeFile(input, Buffer.from(original, "latin1"));
  }
  for (const operation of [preview,
    () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", revisionOf(before), "--backup", outgoing]),
    () => restore(backup, outgoing),
  ]) {
    const refused = await operation();
    assert.match(refused.stdout, /code: VALIDATION_ERROR/);
    assert.match(refused.stdout, /UTF-8/);
    assert.equal(state.mutations, 0);
    assert.deepEqual(state.settings, before);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
});

test("native preflight refuses a forward write whose backup cannot be restored in key order", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy({ padding: "x".repeat(100_000) }, { padding: "x".repeat(1_400_000) });
  const after = nativeTaxonomy({ padding: "x".repeat(900_000) });
  state.settings = { ...before, unrelated: "x".repeat(6_400_000) };
  const { file, backup } = await nativeInputs(dir, target, after);
  const expect = revisionOf(state.settings);
  for (const operation of [
    () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]),
    () => restore(backup, outgoing),
  ]) {
    const result = await operation();
    assert.match(result.stdout, /code: UNSUPPORTED/);
    assert.equal(state.mutations, 0);
    assert.equal(revisionOf(state.settings), expect);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
});

test("native preflight bounds backups of complete and interrupted settings", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy({ padding: "x".repeat(900_000) });
  state.settings = before;
  const expect = revisionOf(before);
  const backupSize = settings => Buffer.byteLength(JSON.stringify({
    format: "activitywatch-axi.native-rules-backup.v1", target, revision: revisionOf(settings), settings,
  }, null, 2) + "\n");
  for (const size of [100_000, 50_000]) {
    const after = nativeTaxonomy({}, { padding: "x".repeat(7_200_000), values: Array(size).fill(0) });
    const mixed = { ...after, classes: before.classes };
    assert.equal(backupSize(after) > 8 * 1024 * 1024, size === 100_000);
    assert.ok(backupSize(mixed) > 8 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(mixed)) < 8 * 1024 * 1024);
    const { file, backup } = await nativeInputs(dir, target, after);
    for (const operation of [
      () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]),
      () => restore(backup, outgoing),
    ]) {
      const result = await operation();
      assert.match(result.stdout, /backup would exceed the 8 MiB restore limit/);
      assert.equal(state.mutations, 0);
      assert.equal(revisionOf(state.settings), expect);
      await assert.rejects(readFile(outgoing), { code: "ENOENT" });
    }
  }
});

test("native reads and documents refuse numeric values they would round", async t => {
  const integer = nativeTaxonomy({}, { values: [JSON.rawJSON("9007199254740993")] });
  const fractional = nativeTaxonomy({}, { values: [JSON.rawJSON("1.0000000000000001")] });
  for (const python of [false, true]) {
    const { dir, native, outgoing, restore, state, target } = await setupNative(t, { python, pythonNumbers: python });
    const current = nativeTaxonomy();
    state.settings = structuredClone(current);
    const expect = revisionOf(current);
    for (const settings of [integer, fractional]) {
      const { file, backup } = await nativeInputs(dir, target, settings);
      for (const operation of [
        () => run(["rules", "preview", "--native", "--file", file, "--full"]),
        () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]),
        () => restore(backup, outgoing),
      ]) {
        const result = await operation();
        assert.match(result.stdout, /code: UNSUPPORTED/);
        assert.equal(state.mutations, 0);
        assert.deepEqual(state.settings, current);
        await assert.rejects(readFile(outgoing), { code: "ENOENT" });
      }
    }
    state.settings = integer;
    const exported = path.join(dir, "export.json");
    for (const [command, flags] of [["show", ["--full"]], ["export", ["--file", exported]]]) {
      const result = await native(command, ["--native", ...flags]);
      assert.match(result.stdout, /code: UNSUPPORTED/);
    }
    assert.equal(state.mutations, 0);
    await assert.rejects(readFile(exported), { code: "ENOENT" });
  }
});

test("native Python refuses lossy integer and float conversions before files or POSTs", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t, { python: true, pythonNumbers: true });
  const current = nativeTaxonomy();
  const output = path.join(dir, "export.json");
  const apply = (file, expect) => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]);
  for (const token of ["100000000000000000000000", "1.0000000000000001e+18"]) {
    const lossy = nativeTaxonomy({}, { values: [JSON.rawJSON(token)] });
    state.settings = structuredClone(current);
    const { file, backup } = await nativeInputs(dir, target, lossy);
    for (const result of [await apply(file, revisionOf(current)), await restore(backup, outgoing)]) {
      assert.match(result.stdout, /code: UNSUPPORTED/);
    }
    assert.equal(state.mutations, 0);
    assert.deepEqual(state.settings, current);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });

    state.settings = lossy;
    await nativeInputs(dir, target, current);
    const expect = revisionOf(JSON.parse(JSON.stringify(lossy)));
    for (const result of [
      await native("export", ["--native", "--file", output]),
      await apply(file, expect),
      await native("revert", ["--native", "--server", "--backup", backup, "--state", dir, "--expect", expect, "--save-backup", outgoing]),
    ]) {
      assert.match(result.stdout, /code: UNSUPPORTED/);
    }
    assert.equal(state.mutations, 0);
    assert.equal(JSON.stringify(state.settings), JSON.stringify(lossy));
    await assert.rejects(readFile(output), { code: "ENOENT" });
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
});

test("native Rust refuses decimals that its pinned decoder rounds differently", async t => {
  const rustDecimal = token => {
    const [integer, fraction] = token.split(".");
    return Number(BigInt(integer + fraction)) / 10 ** fraction.length;
  };
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const current = nativeTaxonomy({}, { values: [42] });
  state.settings = structuredClone(current);
  const expect = revisionOf(current);
  for (const [token, rustValue, jsValue, emittedRustValue] of [
    ["9007199254740993.0", 9007199254740994, 9007199254740992],
    ["0.10000000010000000000", 0.10000000009999999, 0.1000000001],
    ["1.40000000000000010", 1.4000000000000001, 1.4000000000000001, 1.4],
  ]) {
    assert.equal(rustDecimal(token), rustValue);
    assert.equal(JSON.parse(token), jsValue);
    if (emittedRustValue !== undefined) {
      assert.equal(rustDecimal(JSON.stringify(jsValue)), emittedRustValue);
      assert.notEqual(emittedRustValue, jsValue);
    }
    const lossy = nativeTaxonomy({}, { values: [JSON.rawJSON(token)] });
    const { file, backup } = await nativeInputs(dir, target, lossy);
    for (const operation of [
      () => run(["rules", "preview", "--native", "--file", file]),
      () => native("apply", ["--server", "--file", file, "--state", dir, "--expect", expect, "--backup", outgoing]),
      () => restore(backup, outgoing),
    ]) {
      const result = await operation();
      assert.match(result.stdout, /code: UNSUPPORTED/, token);
      assert.equal(state.mutations, 0);
      assert.deepEqual(state.settings, current);
      await assert.rejects(readFile(outgoing), { code: "ENOENT" });
    }
  }
});

test("native Rust refuses an overflowing integer that changes on exponent replay", async t => {
  const token = "316912650057057350374175801344";
  const value = JSON.parse(token);
  const prefix = token.slice(0, 19);
  assert.ok(BigInt(token.slice(0, 20)) >= (1n << 64n));
  assert.equal(BigInt(value), BigInt(token));
  assert.notEqual(Number(prefix) * 10 ** (token.length - prefix.length), value);
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy({}, { values: [42] });
  state.settings = before;
  const lossy = nativeTaxonomy({}, { values: [JSON.rawJSON(token)] });
  const { file, backup } = await nativeInputs(dir, target, lossy);
  const apply = () => native("apply", ["--server", "--file", file, "--state", dir,
    "--expect", revisionOf(before), "--backup", outgoing]);
  for (const operation of [
    () => run(["rules", "preview", "--native", "--file", file]), apply, () => restore(backup, outgoing),
  ]) {
    assert.match((await operation()).stdout, /code: UNSUPPORTED/);
    assert.equal(state.mutations, 0);
    assert.deepEqual(state.settings, before);
    await assert.rejects(readFile(outgoing), { code: "ENOENT" });
  }
  // Rust settings GET serializes its decoded Value, rather than echoing an
  // overflowing integer token supplied to the synthetic server verbatim.
  const exported = path.join(dir, "export.json");
  const shown = await native("show", ["--native"]);
  assert.equal(shown.code, 0, shown.stdout);
  const exportResult = await native("export", ["--native", "--file", exported]);
  assert.equal(exportResult.code, 0, exportResult.stdout);
  assert.match(await readFile(exported, "utf8"), /"values"\s*:\s*\[\s*42\s*\]/);
  assert.equal(state.mutations, 0);
  assert.deepEqual(state.settings, before);
});

test("native Rust keeps unrelated settings in revisions without requiring replay", async t => {
  const { dir, native, outgoing, state, target } = await setupNative(t);
  const before = nativeTaxonomy();
  const after = nativeTaxonomy({}, { values: [42] });
  state.settings = { ...before, unrelated: 1e24 };
  const canonicalBefore = '{"active_set_ids":["default"],"category_sets":[{"categories":[{"name":["Work"],"rule":{"type":"none"}}],"id":"default"},{"categories":[],"id":"inactive"}],"classes":[{"name":["Work"],"rule":{"type":"none"}}],"unrelated":1e+24}';
  const canonicalAfter = '{"active_set_ids":["default"],"category_sets":[{"categories":[{"name":["Work"],"rule":{"type":"none"}}],"id":"default"},{"categories":[],"id":"inactive","values":[42]}],"classes":[{"name":["Work"],"rule":{"type":"none"}}],"unrelated":1e+24}';
  const expect = createHash("sha256").update(canonicalBefore).digest("hex");
  const show = () => native("show", ["--native"]);
  const shown = await show();
  assert.equal(shown.code, 0, shown.stdout);
  assert.match(shown.stdout, new RegExp(`^revision: ${expect}$`, "m"));

  const { file } = await nativeInputs(dir, target, after);
  const apply = (revision, backup) => native("apply", ["--server", "--file", file, "--state", dir, "--expect", revision, "--backup", backup]);
  const applied = await apply(expect, outgoing);
  assert.equal(applied.code, 0, applied.stdout);
  assert.deepEqual(state.settings, { ...after, unrelated: 1e24 });
  assert.deepEqual(JSON.parse(await readFile(outgoing, "utf8")).settings, before);
  const appliedRevision = createHash("sha256").update(canonicalAfter).digest("hex");
  assert.match(applied.stdout, new RegExp(`^revision: ${appliedRevision}$`, "m"));

  state.settings.unrelated = 2e24;
  const changedRevision = createHash("sha256").update(canonicalAfter.replace('"unrelated":1e+24', '"unrelated":2e+24')).digest("hex");
  assert.notEqual(changedRevision, appliedRevision);
  const changed = await show();
  assert.equal(changed.code, 0, changed.stdout);
  assert.match(changed.stdout, new RegExp(`^revision: ${changedRevision}$`, "m"));
  const refusedBackup = path.join(dir, "conflict.json");
  assert.match((await apply(appliedRevision, refusedBackup)).stdout, /code: CONFLICT/);
  assert.equal(state.mutations, 1);
  await assert.rejects(readFile(refusedBackup), { code: "ENOENT" });

  state.settings.category_sets[1].values = [1e24];
  const exported = path.join(dir, "export.json");
  assert.match((await native("export", ["--native", "--file", exported])).stdout, /code: UNSUPPORTED/);
  await assert.rejects(readFile(exported), { code: "ENOENT" });
});

test("native writes and recovers bounded fractional and exact extension values", async t => {
  const exactFraction = 1.1250000000000002;
  const before = nativeTaxonomy({}, { values: [9007199254740992, 1000000000000000100, 0.125, exactFraction] });
  const fractions = [exactFraction, ...Array(340_000).fill(0.5)];
  const input = nativeTaxonomy({}, { values: [JSON.rawJSON("1000000000000000000000"), JSON.rawJSON("1.25e+18"), ...fractions] });
  const after = nativeTaxonomy({}, { values: [1e21, 1250000000000000000, ...fractions] });
  for (const python of [false, true]) {
    const { dir, native, outgoing, restore, state, target } = await setupNative(t, { python, pythonNumbers: python });
    state.settings = structuredClone(before);
    const exported = path.join(dir, "export.json");
    const result = await native("export", ["--native", "--file", exported]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(await readFile(exported, "utf8"), /\b1000000000000000100\b/);
    const { file } = await nativeInputs(dir, target, input);
    const applied = await native("apply", ["--server", "--file", file, "--state", dir, "--expect", revisionOf(before), "--backup", outgoing]);
    assert.equal(applied.code, 0, applied.stdout);
    assert.deepEqual(state.settings, after);
    const reverse = path.join(dir, "reverse.json");
    const restored = await restore(outgoing, reverse);
    assert.equal(restored.code, 0, restored.stdout);
    assert.deepEqual(state.settings, before);
    if (python) {
      const response = await fetch(target.base_url + "/api/0/settings");
      assert.match(await response.text(), /\b1000000000000000100\b/);
    }
    const reapplied = await restore(reverse, path.join(dir, "resaved.json"));
    assert.equal(reapplied.code, 0, reapplied.stdout);
    assert.deepEqual(state.settings, after);
  }
});

test("native apply and restore use fresh connections for settings writes", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy({}, { values: [1] });
  const desired = nativeTaxonomy({}, { values: [2] });
  state.settings = structuredClone(before);
  const { file } = await nativeInputs(dir, target, desired);
  const applied = await native("apply", ["--server", "--file", file, "--state", dir,
    "--expect", revisionOf(before), "--backup", outgoing]);
  assert.equal(applied.code, 0, applied.stdout);
  assert.deepEqual(state.settings, desired);
  const applyRequests = state.requests.slice();
  const restoreStart = state.requests.length;
  const restored = await restore(outgoing, path.join(dir, "reverse.json"));
  assert.equal(restored.code, 0, restored.stdout);
  assert.deepEqual(state.settings, before);
  const restoreRequests = state.requests.slice(restoreStart);
  const reused = [];
  for (const [name, requests] of [["apply", applyRequests], ["restore", restoreRequests]]) {
    const writes = requests.filter(request => request.method === "POST" || request.method === "DELETE");
    assert.equal(writes.length, 1, `${name} write count`);
    const write = writes[0];
    const previous = requests.slice(0, requests.indexOf(write));
    t.diagnostic(`${name}: write connection ${write.connection}; prior read connections ${previous.map(request => request.connection).join(",")}; writes ${writes.length}`);
    if (previous.some(request => request.connection === write.connection)) reused.push(name);
  }
  assert.equal(state.mutations, 2);
  assert.deepEqual(reused, [], "native settings writes reused read connections");
});

test("native restore does not retry a persisted write with a lost response", async t => {
  const { dir, outgoing, restore, state, target } = await setupNative(t);
  const before = nativeTaxonomy({}, { values: [1] });
  const desired = nativeTaxonomy({}, { values: [2] });
  state.settings = structuredClone(before);
  const { backup } = await nativeInputs(dir, target, desired);
  state.dropAt = 1;
  const result = await restore(backup, outgoing);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /UNCERTAIN_WRITE/);
  assert.equal(state.requests.filter(request => request.method === "POST" || request.method === "DELETE").length, 1);
  assert.equal(state.mutations, 1);
  assert.deepEqual(state.settings, desired);
  assert.deepEqual(JSON.parse(await readFile(outgoing, "utf8")).settings, before);
});

test("native restores after an interrupted write and can restore its partial backup", async t => {
  const { dir, native, outgoing, restore, state, target } = await setupNative(t);
  const { file } = await nativeInputs(dir, target, nativeTaxonomy());
  state.settings = { unrelated: "keep" };
  state.dropAt = 2;
  const applied = await native("apply", ["--server", "--initialize", "--file", file, "--state", dir, "--expect", revisionOf(state.settings), "--backup", outgoing]);
  assert.match(applied.stdout, /UNCERTAIN_WRITE/);
  assert.equal(state.mutations, 2);
  assert.ok(state.settings.category_sets);
  assert.equal(Object.hasOwn(state.settings, "classes"), false);
  const partial = structuredClone(state.settings);
  const recovery = path.join(dir, "partial.json");
  assert.equal((await restore(outgoing, recovery)).code, 0);
  assert.deepEqual(state.settings, { unrelated: "keep" });
  assert.equal((await restore(recovery, path.join(dir, "restored.json"))).code, 0);
  assert.deepEqual(state.settings, partial);
});

test("review native complete exports fit the native preview reader", async t => {
  const { dir, native, state } = await setupNative(t);
  const doc = document();
  const category = doc.category_sets[0].categories[0];
  category.padding = "x".repeat(4_192_000);
  category.values = Array(1000).fill(0);
  state.settings = { category_sets: doc.category_sets, active_set_ids: doc.active_set_ids, classes: [category] };
  const file = path.join(dir, "export.json");
  const result = await native("export", ["--native", "--file", file]);
  if (result.code !== 0) {
    assert.match(result.stdout, /UNSUPPORTED/);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } else {
    const preview = await run(["rules", "preview", "--native", "--file", file]);
    assert.equal(preview.code, 0, preview.stdout);
    assert.match(preview.stdout, /coverage: complete/);
  }
  category.padding = "";
  category.values = [];
  const subdir = path.join(dir, "other", "subdir");
  await mkdir(subdir, { recursive: true });
  const link = path.join(dir, "link");
  await symlink(subdir, link);
  const small = path.relative(root, link) + "/../small-export.json";
  const exported = await native("export", ["--native", "--file", small]);
  assert.equal(exported.code, 0, exported.stdout);
  await assert.rejects(readFile(path.join(dir, "small-export.json")), { code: "ENOENT" });
  const preview = await run(["rules", "preview", "--native", "--file", small]);
  assert.equal(preview.code, 0, preview.stdout);
  assert.match(preview.stdout, /coverage: complete/);
});

test("R1 stale locks fail closed for concurrent timer commands", async t => {
  const { dir, server, state } = await setup(t);
  const dead = spawn(process.execPath, ["-e", ""], { cwd: root });
  await new Promise(resolve => dead.on("close", resolve));
  const lock = `${dead.pid}:0:dead`;
  await writeFile(path.join(dir, "timer.lock"), lock);
  const args = ["timer", "start", "--label", "work", "--state", dir, "--base-url", server.baseUrl];
  const results = await Promise.all([run(args), run(args)]);
  for (const result of results) {
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout, /LOCK_HELD/);
  }
  assert.equal(state.eventPosts, 0);
  assert.equal(await readFile(path.join(dir, "timer.lock"), "utf8"), lock);
  await rm(path.join(dir, "timer.lock"));
  const acquired = await run(args);
  assert.equal(acquired.code, 0, acquired.stdout);
  assert.equal(state.eventPosts, 1);
});

test("R2 web observations preserve separate app totals", async t => {
  const { activity, state } = await setup(t);
  state.events.web = [event(3600, { url: "https://background.test/path" })];
  const result = await activity();
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Editor,3600/);
  assert.match(result.stdout, /background\.test,3600/);
});

test("dashboard counts unattributed non-HTTP tab observations without exposing tab data", async t => {
  const { server, state } = await setup(t);
  state.events.web = [event(60, { url: "file:///private-tab-path", title: "Private tab title" })];
  const result = await run(["--tui", "--once", "--base-url", server.baseUrl, ...range]);
  assert.equal(result.code, 0, result.stdout);
  const web = result.stdout.split("Web tabs")[1]?.split("Categories")[0] ?? "";
  assert.match(web, /union\s+1m\b/);
  assert.match(web, /Unattributed\s+━+ 1m\b/);
  assert.doesNotMatch(web, /No events in this range|unreadable/);
  assert.doesNotMatch(result.stdout, /file:|private-tab-path|Private tab title/);
});

test("R3 malformed complete rules are refused before activity reads for file and server", async t => {
  const { file, server, state } = await setup(t);
  const changes = [
    d => { d.active_set_ids = []; },
    d => { d.active_set_ids = ["missing"]; },
    d => { d.active_set_ids.push("default"); },
    d => { d.category_sets[0].id = 42; },
    d => { d.category_sets.push(structuredClone(d.category_sets[0])); },
    d => { d.category_sets[0].categories = null; },
    d => { d.category_sets[0].tombstones = ["Work"]; },
    d => { d.category_sets[0].categories[0].name = "Work"; },
    d => { d.category_sets[0].categories[0].rule.type = "future"; },
    d => { d.category_sets[0].categories[0].rule.regex = 42; },
    d => { d.category_sets[0].categories[0].rule.regex = "["; },
    d => { d.category_sets[0].categories[0].rule.ignore_case = "false"; },
    d => { d.category_sets[0].categories[0].rule.select_keys = "app"; },
    d => { d.category_sets[0].categories[0].rule.priority = "10"; },
    d => { d.category_sets[0].categories[0].rule.weight = 1.5; },
  ];
  for (const change of changes) {
    const doc = document();
    change(doc);
    await writeFile(file, JSON.stringify(doc));
    Object.assign(state.settings, { category_sets: doc.category_sets, active_set_ids: doc.active_set_ids, classes: doc.classes });
    for (const source of [["--rules", file], ["--server-rules"]]) {
      state.requests.length = 0;
      const result = await run(["uncategorized", ...source, "--base-url", server.baseUrl, ...range]);
      assert.notEqual(result.code, 0, JSON.stringify(doc) + result.stdout);
      assert.equal(state.requests.some(r => r.path === "/api/0/query/"), false);
    }
  }
});

test("R3 native preview retains compatibility checks and valid empty regex matches", async t => {
  const { file, dir, activity } = await setup(t);
  const doc = document();
  doc.category_sets[0].categories[0].rule.regex = "";
  doc.category_sets[0].categories[0].rule.priority = 10;
  doc.category_sets[0].tombstones = ['["Hidden"]'];
  doc.category_sets.push({ id: "overlay", categories: [
    { name: ["Hidden"], rule: { type: "regex", regex: "hidden" } },
    { name: ["Work"], rule: { type: "regex", regex: "masked" } },
  ] });
  doc.active_set_ids.push("overlay");
  doc.classes = [structuredClone(doc.category_sets[0].categories[0])];
  const native = { format: "activitywatch-axi.native-rules.v1", coverage: "complete", target: {}, settings: { category_sets: doc.category_sets, active_set_ids: doc.active_set_ids, classes: doc.classes } };
  const nativeFile = path.join(dir, "native.json");
  await writeFile(nativeFile, JSON.stringify(native));
  const valid = await run(["rules", "preview", "--native", "--file", nativeFile]);
  assert.equal(valid.code, 0, valid.stdout);
  native.settings.classes = [];
  await writeFile(nativeFile, JSON.stringify(native));
  const invalid = await run(["rules", "preview", "--native", "--file", nativeFile]);
  assert.notEqual(invalid.code, 0, invalid.stdout);
  assert.match(invalid.stdout, /classes must equal/);
  await writeFile(file, JSON.stringify(doc));
  const classified = await activity();
  assert.equal(classified.code, 0, classified.stdout);
  assert.match(classified.stdout, /apps_count: 0/);
});

test("R4 modifiers apply to new, exact, none, null, and extended rules", async t => {
  const { file, dir, activity, state } = await setup(t);
  for (const [index, original] of [undefined, { type: "regex", regex: "^Notes$", select_keys: ["app"] }, { type: "none" }, { type: null }, { type: "regex", regex: "^Other$" }].entries()) {
    const doc = document();
    if (original) doc.category_sets[0].categories[0].rule = original;
    else doc.category_sets[0].categories = [];
    await writeFile(file, JSON.stringify(doc));
    const result = await add(file, dir, "^Notes$", ["--ignore-case", "--select-keys", "url"], `backup-${index}.json`);
    assert.equal(result.code, 0, result.stdout);
    const rule = JSON.parse(await readFile(file, "utf8")).category_sets[0].categories[0].rule;
    assert.equal(rule.ignore_case, true);
    assert.deepEqual(rule.select_keys, ["url"]);
    state.events.window = [event(3600, { app: "Editor", url: "notes" })];
    const classified = await activity();
    assert.equal(classified.code, 0, classified.stdout);
    assert.match(classified.stdout, /apps_count: 0/);
  }
});

test("R5 escaped pipes do not suppress new alternatives", async t => {
  const { file, dir, activity, state } = await setup(t);
  const doc = document();
  doc.category_sets[0].categories[0].rule.regex = "foo\\|bar";
  await writeFile(file, JSON.stringify(doc));
  const result = await add(file, dir, "bar");
  assert.equal(result.code, 0, result.stdout);
  state.events.window = [event(3600, { app: "bar" })];
  const classified = await activity();
  assert.equal(classified.code, 0, classified.stdout);
  assert.match(classified.stdout, /apps_count: 0/);
});

test("R6 conflicting hosts are refused before event reads in CLI and dashboard", async t => {
  const { activity, state, server } = await setup(t);
  for (const id of ["web", "afk"]) {
    state.buckets[id].hostname = "B";
    for (const args of [null, ["--tui", "--once", "--base-url", server.baseUrl, ...range]]) {
      state.requests.length = 0;
      const result = args ? await run(args) : await activity();
      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stdout, /--host/);
      assert.equal(state.requests.some(r => r.path === "/api/0/query/"), false);
    }
    state.buckets[id].hostname = "A";
  }
  state.buckets.web.hostname = "B";
  state.buckets.afk.hostname = "B";
  const explicit = await activity("--host", "A");
  assert.equal(explicit.code, 0, explicit.stdout);
  assert.match(explicit.stdout, /afk_filter: unavailable/);
  const dashboard = await run(["--tui", "--once", "--base-url", server.baseUrl, ...range, "--host", "A"]);
  assert.equal(dashboard.code, 0, dashboard.stdout);
  assert.match(dashboard.stdout, /host A/);
});

test("R7 empty AFK and coverage gaps withhold both app and domain totals", async t => {
  const { activity, state } = await setup(t);
  state.events.web = [event(3600, { url: "https://background.test" })];
  for (const afk of [[], [event(3590, { status: "not-afk" }, 10)], [event(3590, { status: "not-afk" })], [event(10, { status: "not-afk" }), event(3580, { status: "not-afk" }, 20)]]) {
    state.events.afk = afk;
    const result = await activity();
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout, /INCOMPLETE/);
    assert.doesNotMatch(result.stdout, /apps_count|domains_count/);
  }
  state.events.afk = [event(3600, { status: "afk" })];
  const known = await activity();
  assert.equal(known.code, 0, known.stdout);
  assert.match(known.stdout, /apps_count: 0/);

  state.events.afk = [event(1200, { status: "not-afk" }, 2400), event(1200, { status: "not-afk" }),
    event(1200, { status: "afk" }, 1200)];
  state.events.window = [event(3000, { app: "Editor" }, 600), event(2700, { app: "Editor" })];
  const clipped = await activity();
  assert.equal(clipped.code, 0, clipped.stdout);
  assert.match(clipped.stdout, /Editor,2400/);
  assert.match(clipped.stdout, /background\.test,2400/);
  state.events.window = [event(2100, { app: "Editor" }), event(2100, { app: "Browser" }, 1500)];
  const overlapOnlyWhileAfk = await activity();
  assert.equal(overlapOnlyWhileAfk.code, 0, overlapOnlyWhileAfk.stdout);
  assert.match(overlapOnlyWhileAfk.stdout, /Editor,1200/);
  assert.match(overlapOnlyWhileAfk.stdout, /Browser,1200/);
});

test("R8 overlapping app and domain identities are refused, including categorized siblings", async t => {
  const { activity, state } = await setup(t);
  for (const other of ["Beta", "Notes"]) {
    state.events.window = [event(60, { app: "Alpha" }), event(60, { app: other })];
    const result = await activity();
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout, /INCOMPLETE/);
  }
  state.events.window = [];
  for (const other of ["beta.test", "Notes"]) {
    state.events.web = [event(60, { url: "https://alpha.test" }), event(60, { url: `https://${other}`, title: other })];
    const result = await activity();
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout, /INCOMPLETE/);
  }
  state.events.web = [event(60, { url: "https://alpha.test/a" }), event(60, { url: "https://alpha.test/b" })];
  const same = await activity();
  assert.equal(same.code, 0, same.stdout);
  assert.match(same.stdout, /alpha\.test,60/);
});

test("R9 repeated exact additions preserve bytes and do not create backups", async t => {
  const { file, dir } = await setup(t);
  const initial = await add(file, dir, "^Notes$");
  assert.equal(initial.code, 0, initial.stdout);
  const bytes = await readFile(file);
  const repeat = await add(file, dir, "^Notes$");
  assert.equal(repeat.code, 0, repeat.stdout);
  assert.match(repeat.stdout, /no-op/);
  assert.deepEqual(await readFile(file), bytes);
  const absent = path.join(dir, "unused.json");
  const again = await add(file, dir, "^Notes$", [], "unused.json");
  assert.equal(again.code, 0, again.stdout);
  await assert.rejects(readFile(absent), { code: "ENOENT" });
});

test("R10 range changes queue a fresh read and never paint obsolete results", { timeout: 15000 }, async t => {
  const { server, state } = await setup(t);
  const splitFrames = output => output.split("\u001b[H\u001b[2J").slice(1);
  const isActivityFrame = frame => frame.includes("foreground union");
  for (const [keys, failFirst, scroll, afterPaint] of [
    ["7", false], ["7t", false], ["t7", false], ["r7", false], ["r", false, true], ["7", true], ["7j", false, false, true],
  ]) {
    state.requests.length = 0;
    const script = `
      import { runTui } from './src/tui.js';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdout.columns = 140;
      process.stdout.rows = ${scroll ? 13 : 60};
      const original = fetch;
      let first = true;
      let switched = false;
      globalThis.fetch = async (...args) => {
        if (first) {
          first = false;
          if (!${Boolean(afterPaint)}) {
            await new Promise(resolve => {
              process.once('message', () => {
                process.stdin.emit('data', Buffer.from(${JSON.stringify(keys)}));
                resolve();
              });
              process.send('pending');
            });
          }
          if (${failFirst}) throw new Error('obsolete request failed');
        } else if (switched) {
          switched = false;
          await new Promise(resolve => setImmediate(resolve));
          process.stdout.rows = 13;
          process.stdout.emit('resize');
        }
        return original(...args);
      };
      process.on('message', message => {
        if (message === 'quit') process.stdin.emit('data', Buffer.from('q'));
        if (message === 'scroll') process.stdin.emit('data', Buffer.from('jj'));
        if (message === 'range') {
          switched = true;
          process.stdin.emit('data', Buffer.from(${JSON.stringify(keys)}));
        }
      });
      await runTui(['--base-url', ${JSON.stringify(server.baseUrl)}, '--now', '2026-11-15T01:00:00Z', '--timezone', 'UTC']);
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, NO_COLOR: "1" } });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "";
    let stderr = "";
    let scrollSent = false;
    let rangeSent = false;
    let quitSent = false;
    child.stdout.on("data", chunk => {
      output += chunk;
      const frames = splitFrames(output).filter(isActivityFrame);
      if (scroll && !scrollSent && frames.length > 0) {
        scrollSent = true;
        child.send("scroll");
      }
      if (afterPaint && !rangeSent && frames.length > 0) {
        rangeSent = true;
        child.send("range");
      }
      const nextRangeRendered = frames.length >= 2 && /last seven days|↑ 1 more/.test(frames.at(-1));
      if (!quitSent && (afterPaint ? nextRangeRendered : frames.length >= (scroll ? 3 : 1))) {
        quitSent = true;
        child.send("quit");
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("message", () => child.send("switch"));
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(code, 0, stderr);
    const frames = splitFrames(output);
    const activityFrames = frames.filter(isActivityFrame);
    assert.equal(activityFrames.length, afterPaint ? 2 : scroll ? 3 : 1, output);
    assert.match(activityFrames[0].split("\n")[0], keys.endsWith("7") ? /last seven days/ : /today/);
    if (scroll) assert.match(activityFrames.at(-1), /↑ 2 more/);
    if (afterPaint) {
      const waiting = frames.slice(frames.indexOf(activityFrames[0]) + 1, frames.indexOf(activityFrames[1]));
      assert.ok(waiting.length > 0, output);
      assert.ok(waiting.every(frame => frame === "Reading last seven days…"), output);
      assert.match(activityFrames[1], /↑ 1 more/);
    }
    assert.equal(state.requests.filter(r => r.path === "/api/0/buckets/").length, failFirst ? 1 : 2);
  }
});
