import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { withLock } from "./lock.js";
import { stateDirFrom } from "./options.js";
import { revisionOf, stableStringify } from "./revision.js";

export const NATIVE_FORMAT = "activitywatch-axi.native-rules.v1";
const BACKUP_FORMAT = "activitywatch-axi.native-rules-backup.v1";
const KEYS = ["category_sets", "active_set_ids", "classes"];
// Released v0.14.2 webUI, aw-webui 42fe89f07914b8190dc2f0cb59e0df1a976a1261.
// Pin the served bundle, not just the backend version: they can be upgraded independently.
const BUNDLE = "/js/index.15e65e70.js";
const BUNDLE_HASH = "ecbfd637750abb8f7da32dbc32a8f6d41ba167f28dfb8ec0512e304429a94a40";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const fail = (message, code = "VALIDATION_ERROR") => { throw new AxiError(message, code); };
const subset = (settings) => Object.fromEntries(KEYS.filter(k => Object.hasOwn(settings, k)).map(k => [k, settings[k]]));

async function capability(client) {
  const url = new URL(client.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    fail("Native rules require an explicit HTTP loopback target.");
  }
  const info = await client.request("GET", "/api/0/info");
  if (!["v0.14.2", "v0.14.2 (rust)"].includes(info?.version)) {
    fail("Native rules support only the verified v0.14.2 Python/Rust release.", "UNSUPPORTED");
  }
  const html = await client.request("GET", "/", { raw: true });
  if (typeof html !== "string" || !html.includes(BUNDLE)) {
    fail("The served webUI build is not supported. No settings were written.", "UNSUPPORTED");
  }
  const bundle = await client.request("GET", BUNDLE, { raw: true });
  if (createHash("sha256").update(bundle).digest("hex") !== BUNDLE_HASH) {
    fail("The served webUI bundle does not match the verified release.", "UNSUPPORTED");
  }
  return { base_url: client.baseUrl, server_version: info.version, webui_sha256: BUNDLE_HASH };
}

async function readSettings(client, target) {
  const settings = await client.request("GET", target.server_version.endsWith("(rust)") ? "/api/0/settings/" : "/api/0/settings");
  if (!object(settings)) fail("The native settings response is not an object.", "UNSUPPORTED");
  return settings;
}

export async function nativeShow(flags, client) {
  const target = await capability(client);
  const all = await readSettings(client, target);
  const settings = subset(all);
  let coverage = "complete";
  try { validateSettings(settings); } catch { coverage = Object.keys(settings).length ? "incomplete" : "absent"; }
  const result = {
    target, revision: revisionOf(all), revision_scope: "all-server-settings",
    coverage, presence: Object.fromEntries(KEYS.map(k => [k, Object.hasOwn(settings, k)])),
    browser_local: "not-read; server values take priority, missing keys may use browser fallback or native defaults",
    ui_adoption: "not-verified; reload the intended native UI and verify classification",
  };
  if (flags.full) result.settings = settings;
  if (flags.file) {
    await privateFile(flags.file, { format: NATIVE_FORMAT, coverage, target, settings });
    result.file = path.resolve(flags.file);
  }
  return result;
}

export async function nativePreview(flags) {
  const doc = await readDocument(flags.file);
  validateDocument(doc);
  return {
    file: path.resolve(flags.file), target: doc.target, coverage: doc.coverage,
    active_set_ids: doc.settings.active_set_ids,
    sets: doc.settings.category_sets.map(s => ({ id: s.id, active: doc.settings.active_set_ids.includes(s.id), categories: s.categories.length, tombstones: s.tombstones?.length ?? 0 })),
    ...(flags.full ? { settings: doc.settings } : {}),
    ...(doc.settings.category_sets.some(set => set.categories.some(category => category.rule.select_keys?.includes("url")))
      ? { desktop_activity_limit: "The pinned native desktop Activity query does not pass browser URL fields to its category events." }
      : {}),
    browser_local: "not-read", ui_adoption: "not-verified",
  };
}

export async function nativeApply(flags, client, restoring = false) {
  if (!flags.server || !flags["base-url"] || !flags.state) fail("Native writes require --server, --base-url, and --state explicitly.");
  if (restoring && flags.file) fail("Native restore uses --backup; --file belongs to legacy file restore.");
  if (!/^[a-f0-9]{64}$/.test(flags.expect ?? "")) fail("--expect must be the current all-server-settings revision.");
  const backup = restoring ? flags["save-backup"] : flags.backup;
  if (!backup) fail(restoring ? "--save-backup is required for a private backup before restore." : "--backup is required.");
  const doc = await readDocument(restoring ? flags.backup : flags.file);
  if (restoring) {
    if (!object(doc) || doc.format !== BACKUP_FORMAT || !object(doc.settings) || Object.keys(doc.settings).some(k => !KEYS.includes(k)) || doc.revision !== revisionOf(doc.settings)) {
      fail("Invalid native rules backup.");
    }
    // Interrupted multi-key writes can leave a partial snapshot. Restore its exact
    // presence/value shape, without pretending it was a complete effective taxonomy.
    for (const [key, value] of Object.entries(doc.settings)) {
      if (value === null) continue;
      if (!Array.isArray(value)) fail("Invalid native backup setting shape.");
      if (key === "active_set_ids" && value.some(id => typeof id !== "string" || !id)) fail("Invalid backup active IDs.");
      const categories = key === "classes" ? value : key === "category_sets" ? value.flatMap(set => {
        if (!object(set) || typeof set.id !== "string" || !Array.isArray(set.categories)) fail("Invalid backup category set.");
        return set.categories;
      }) : [];
      if (categories.some(category => !object(category) || !validName(category.name) || !object(category.rule))) fail("Invalid backup category.");
    }
  } else validateDocument(doc);
  return withLock(stateDirFrom(flags), "settings", async () => {
    const target = await capability(client);
    if (!equal(doc.target, target)) fail("The document target differs from this server/build. Nothing was written.", "CONFLICT");
    const current = await readSettings(client, target);
    if (revisionOf(current) !== flags.expect) fail("Server settings changed. Read the current revision before applying.", "CONFLICT");
    const before = subset(current);
    const after = doc.settings;
    if (!restoring) {
      try { validateSettings(before); } catch {
        if (!flags.initialize || Object.values(before).some(value => value !== null)) {
          fail("Native category settings are absent/incomplete or unsupported. Only absent/null settings can use --initialize with a complete document; defaults were not invented.", "UNSUPPORTED");
        }
      }
    }
    // Python's set_setting removes falsey values. Such stored values cannot be faithfully restored.
    if (target.server_version === "v0.14.2") {
      for (const values of [before, after]) {
        for (const value of Object.values(values)) {
          if (value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0) || (object(value) && Object.keys(value).length === 0)) {
            fail("Python v0.14.2 deletes falsey settings; this state cannot be faithfully written and restored.", "UNSUPPORTED");
          }
        }
      }
    }
    if (equal(before, after)) return { result: "no-op", revision: flags.expect, ui_adoption: "not-verified" };
    if (!equal(current, await readSettings(client, target))) fail("Settings changed before backup. Nothing was written.", "CONFLICT");
    await privateFile(backup, { format: BACKUP_FORMAT, target, revision: revisionOf(before), settings: before });
    const expected = structuredClone(current);
    const written = [];
    try {
      for (const key of KEYS) {
        if (Object.hasOwn(before, key) === Object.hasOwn(after, key) && equal(before[key], after[key])) continue;
        if (!equal(expected, await readSettings(client, target))) fail("Settings changed between native writes.", written.length ? "UNCERTAIN_WRITE" : "CONFLICT");
        if (!Object.hasOwn(after, key)) {
          await client.request(target.server_version.endsWith("(rust)") ? "DELETE" : "POST", `/api/0/settings/${key}`, { mutation: true, ...(target.server_version === "v0.14.2" ? { body: null } : {}) });
          delete expected[key];
        } else {
          await client.request("POST", `/api/0/settings/${key}`, { body: after[key], mutation: true });
          expected[key] = after[key];
        }
        written.push(key);
        if (!equal(expected, await readSettings(client, target))) fail("Native settings did not match after a write.", "UNCERTAIN_WRITE");
      }
    } catch (error) {
      throw new AxiError(`Native write stopped: ${error.message}. No retry or automatic rollback was attempted.`, written.length || error.code === "UNCERTAIN_WRITE" ? "UNCERTAIN_WRITE" : error.code || "SERVER", [`Private backup: ${path.resolve(backup)}`, `Acknowledged write requests: ${written.join(", ") || "none"}; the interrupted operation may still have persisted.`, "Read the current revision, then explicitly restore after checking it."]);
    }
    return { result: restoring ? "restored" : "persisted", backup: path.resolve(backup), revision: revisionOf(expected), changed_keys: written, server_transaction: "unsupported", browser_local: "not-read-or-modified", ui_adoption: "not-verified; reload the native UI and check a known activity" };
  });
}

function validateDocument(doc) {
  if (!object(doc) || doc.format !== NATIVE_FORMAT || doc.coverage !== "complete" || !object(doc.target)) fail("Supply a complete activitywatch-axi.native-rules.v1 document with an explicit target.");
  validateSettings(doc.settings);
}

function validateSettings(settings) {
  if (!object(settings) || Object.keys(settings).length !== 3 || !KEYS.every(k => Object.hasOwn(settings, k))) fail("A complete document contains exactly category_sets, active_set_ids, and classes.");
  validateCategorySets(settings);
  const { category_sets: sets, active_set_ids: active, classes } = settings;
  if (!Array.isArray(classes)) fail("Native classes must be a list.");
  const ordered = active.map(id => sets.find(s => s.id === id));
  const seen = new Set();
  const hidden = new Set(ordered[0].tombstones ?? []);
  const merged = [];
  ordered.forEach((set, index) => {
    for (const category of set.categories) {
      const key = JSON.stringify(category.name);
      if (seen.has(key) || (index > 0 && hidden.has(key))) continue;
      seen.add(key);
      merged.push(category);
    }
  });
  // The supplied compatibility list must reflect native set priority and tombstones.
  // Do not silently regenerate it and lose unknown fields from either representation.
  if (!equal(classes, merged)) fail("classes must equal the effective categories in active-set order, including primary tombstones.");
}

export function validateCategorySets(settings) {
  if (!object(settings)) fail("Category settings must be an object.");
  const { category_sets: sets, active_set_ids: active } = settings;
  if (!Array.isArray(sets) || !sets.length || !Array.isArray(active) || !active.length) fail("Nonempty native sets and active IDs are required; empty selection would activate a native fallback.");
  const ids = new Set();
  for (const set of sets) {
    if (!object(set) || typeof set.id !== "string" || !set.id || ids.has(set.id) || !Array.isArray(set.categories)) fail("Invalid or duplicate native category set.");
    ids.add(set.id);
    const names = new Set();
    for (const category of set.categories) {
      if (!object(category) || !validName(category.name) || !object(category.rule) || !["regex", "none", null].includes(category.rule.type)) fail("Unsupported native category shape or rule type.");
      const name = JSON.stringify(category.name);
      if (names.has(name)) fail("Duplicate category name in one set.");
      names.add(name);
      const rule = category.rule;
      if (rule.type === "regex") {
        if (typeof rule.regex !== "string") fail("Regex rules require a string pattern.");
        try { new RegExp(rule.regex); } catch { fail("Invalid native regex pattern."); }
      }
      if (rule.ignore_case !== undefined && typeof rule.ignore_case !== "boolean") fail("ignore_case must be boolean.");
      if (rule.select_keys !== undefined && (!Array.isArray(rule.select_keys) || rule.select_keys.some(k => typeof k !== "string" || !k))) fail("Invalid select_keys.");
      for (const key of ["priority", "weight"]) if (rule[key] !== undefined && !Number.isInteger(rule[key])) fail(`Invalid rule ${key}.`);
    }
    if (set.tombstones !== undefined) {
      if (!Array.isArray(set.tombstones)) fail("Invalid tombstones.");
      for (const tombstone of set.tombstones) {
        try { if (typeof tombstone !== "string" || !validName(JSON.parse(tombstone))) throw Error(); } catch { fail("Tombstones must be JSON-encoded category paths."); }
      }
    }
  }
  if (new Set(active).size !== active.length || active.some(id => !ids.has(id))) fail("Active IDs must be unique and refer to supplied sets.");
}

function validName(name) { return Array.isArray(name) && name.length > 0 && name.every(v => typeof v === "string" && v.length > 0); }

async function readDocument(file) {
  if (!file) fail("A document path is required.");
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) fail("Document exceeds the 8 MiB limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("Document is not valid JSON."); }
}

async function privateFile(file, document) {
  try { await writeFile(path.resolve(file), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("Backup/export already exists. Choose a new private file.", "CONFLICT");
    throw error;
  }
}
