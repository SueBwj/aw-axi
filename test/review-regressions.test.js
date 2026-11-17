import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionOf } from "../src/revision.js";
import { startServer } from "./synthetic-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const range = ["--start", "2026-11-15T00:00:00", "--end", "2026-11-15T01:00:00", "--timezone", "UTC"];
const event = (seconds, data, offset = 0) => ({ timestamp: new Date(Date.parse("2026-11-15T00:00:00Z") + offset * 1000).toISOString(), duration: seconds, data });
const document = () => ({ format: "activitywatch-axi.rules.v1", coverage: "complete", category_sets: [{ id: "default", categories: [{ name: ["Work"], rule: { type: "regex", regex: "^Notes$" } }] }], active_set_ids: ["default"], classes: [] });

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/aw-axi.js", ...args], { cwd: root, env: { ...process.env, AWAXI_BASE_URL: "", AWAXI_STATE: "", AWAXI_NOW: "", NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
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

async function add(file, dir, pattern, extra = [], backup = "backup.json") {
  const doc = JSON.parse(await readFile(file, "utf8"));
  const expect = revisionOf({ category_sets: doc.category_sets, active_set_ids: doc.active_set_ids, classes: doc.classes });
  return run(["rules", "add", "--file", file, "--set", "default", "--name", "Work", "--pattern", pattern, "--expect", expect, "--backup", path.join(dir, backup), ...extra]);
}

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
  for (const [keys, failFirst] of [["7", false], ["7t", false], ["r", false], ["7", true]]) {
    state.requests.length = 0;
    const script = `
      import { runTui } from './src/tui.js';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdout.columns = 140;
      process.stdout.rows = 60;
      const original = fetch;
      let first = true;
      globalThis.fetch = async (...args) => {
        if (first) {
          first = false;
          await new Promise(resolve => {
            process.once('message', () => {
              for (const key of ${JSON.stringify(keys)}) process.stdin.emit('data', Buffer.from(key));
              resolve();
            });
            process.send('pending');
          });
          if (${failFirst}) throw new Error('obsolete request failed');
        }
        return original(...args);
      };
      process.on('message', message => { if (message === 'quit') process.stdin.emit('data', Buffer.from('q')); });
      await runTui(['--base-url', ${JSON.stringify(server.baseUrl)}, '--now', '2026-11-15T01:00:00Z', '--timezone', 'UTC']);
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, NO_COLOR: "1" } });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "";
    let stderr = "";
    let quitSent = false;
    child.stdout.on("data", chunk => {
      output += chunk;
      if (!quitSent && output.includes("\u001b[H\u001b[2J")) {
        quitSent = true;
        child.send("quit");
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("message", () => child.send("switch"));
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(code, 0, stderr);
    const frames = output.split("\u001b[H\u001b[2J").slice(1);
    assert.equal(frames.length, 1, output);
    assert.match(frames[0].split("\n")[0], keys === "7" ? /last seven days/ : /today/);
    assert.equal(state.requests.filter(r => r.path === "/api/0/buckets/").length, failFirst ? 2 : 4);
  }
});
