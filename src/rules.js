import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { getSetting } from "./client.js";
import { validateCategorySets } from "./native-rules.js";
import { revisionOf, stableStringify } from "./revision.js";

const FORMAT = "activitywatch-axi.rules.v1";

export async function rulesShow(flags, client) {
  const document = await readServerRules(client);
  const coverage = coverageOf(document);
  const body = {
    revision: revisionOf(document),
    coverage,
    category_sets: Array.isArray(document.category_sets) ? document.category_sets.length : null,
    active_set_ids: Array.isArray(document.active_set_ids) ? document.active_set_ids : null,
    classes: Array.isArray(document.classes) ? document.classes.length : null,
    browser_extension: "not-readable",
  };
  if (coverage === "unsupported") {
    body.result =
      "These keys are absent/incomplete. The native UI may use shipped defaults or browser fallback. Run rules show --native for version-pinned detection; browser storage was not read.";
    body.help = [
      "Export the rules from the browser UI and run `aw-axi rules preview --file <path>`.",
      "A single exported category list does not include other enabled sets or their priority.",
    ];
  }
  if (flags.full && coverage !== "unsupported") body.rules = describeRules(document, true);
  else if (coverage === "complete" || coverage === "legacy-classes-only") body.rules = describeRules(document, false);
  return body;
}

export async function rulesExport(flags, client) {
  const file = requirePath(flags.file, "--file");
  const document = await readServerRules(client);
  const coverage = coverageOf(document);
  if (coverage === "unsupported") {
    throw new AxiError(
      "The server has no category settings. This CLI cannot see browser-local rules and did not write a file.",
      "UNSUPPORTED",
      ["Save the browser export yourself, then run `aw-axi rules preview --file <path>`."],
    );
  }
  const payload = {
    format: FORMAT,
    coverage: coverage === "complete" ? "server-sets" : "legacy-classes-only",
    browser_extension: "not-readable",
    category_sets: document.category_sets,
    active_set_ids: document.active_set_ids,
    classes: document.classes,
  };
  await writeNewFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    result: "exported",
    file,
    coverage: payload.coverage,
    browser_extension: "not-readable",
    revision: revisionOf(document),
  };
}

export async function rulesPreview(flags) {
  const file = requirePath(flags.file, "--file");
  const parsed = await readRulesFile(file);
  if (parsed.kind === "array") {
    return {
      file,
      coverage: "first-set-only",
      partial: true,
      categories: parsed.value.length,
      result:
        "This file is one category list. Other enabled sets and their priority are not in it, so it is not a complete configuration.",
      rules: flags.full ? summarizeCategories(parsed.value, true) : `${parsed.value.length} categories`,
    };
  }
  if (parsed.kind !== "document") {
    throw new AxiError(
      "The rules file is neither a category list nor an activitywatch-axi rules document.",
      "VALIDATION_ERROR",
    );
  }
  return {
    file,
    coverage: parsed.value.coverage ?? "unknown",
    partial: parsed.value.coverage !== "complete",
    revision: revisionOf(rulesPayload(parsed.value)),
    browser_extension: parsed.value.browser_extension ?? null,
    unknown_fields: unknownFields(parsed.value, [
      "format",
      "coverage",
      "browser_extension",
      "category_sets",
      "active_set_ids",
      "classes",
    ]),
    rules: describeRules(rulesPayload(parsed.value), Boolean(flags.full)),
  };
}

export async function rulesAdd(flags, client) {
  const expect = requireExpect(flags.expect);
  const backup = requirePath(flags.backup, "--backup");
  const edit = parseEdit(flags);
  if (flags.file && flags.server) {
    throw new AxiError("Pass either --file or --server", "VALIDATION_ERROR");
  }
  if (flags.file) return addFile(flags.file, edit, expect, backup);
  if (flags.server) throw new AxiError("Server edits require a complete native document. Use rules export --native, then rules apply.", "UNSUPPORTED");
  throw new AxiError("Pass --file or --server", "VALIDATION_ERROR");
}

export async function rulesRevert(flags, client) {
  const expect = requireExpect(flags.expect);
  const backup = requirePath(flags.backup, "--backup");
  if (flags.file && flags.server) {
    throw new AxiError("Pass either --file or --server", "VALIDATION_ERROR");
  }
  if (flags.file) return revertFile(flags.file, backup, expect);
  if (flags.server) throw new AxiError("Use rules revert --native with a target-bound native backup and --save-backup.", "UNSUPPORTED");
  throw new AxiError("Pass --file or --server", "VALIDATION_ERROR");
}

export async function loadCompleteRules(flags, client) {
  if (flags.rules && flags["server-rules"]) {
    throw new AxiError("Pass either --rules or --server-rules", "VALIDATION_ERROR");
  }
  if (flags.rules) {
    const parsed = await readRulesFile(requirePath(flags.rules, "--rules"));
    if (parsed.kind === "array") {
      throw new AxiError(
        "This rules file is only the first category set. Categorization was not run.",
        "UNSUPPORTED",
        ["Include every enabled set and active_set_ids in an activitywatch-axi rules file with coverage complete."],
      );
    }
    if (parsed.kind !== "document" || parsed.value.coverage !== "complete") {
      throw new AxiError(
        `Rules coverage is ${parsed.value?.coverage ?? "unknown"}. Categorization was not run.`,
        "UNSUPPORTED",
        ["Use a file whose coverage is complete, including every enabled set and its priority."],
      );
    }
    const payload = rulesPayload(parsed.value);
    return { source: "file", scope: "complete", categories: mergeActive(payload), document: payload };
  }
  if (flags["server-rules"]) {
    const document = await readServerRules(client);
    if (coverageOf(document) !== "complete") {
      throw new AxiError(
        "Server category settings are missing or incomplete. No default rules were used and categorization was not run.",
        "UNSUPPORTED",
        ["Browser-local rules were not searched. Pass --rules with an explicit complete file."],
      );
    }
    return {
      source: "server",
      scope: "server-sets-only",
      categories: mergeActive(document),
      document,
    };
  }
  throw new AxiError("Pass --rules <file> or --server-rules before categorizing", "VALIDATION_ERROR", [
    "Missing rules are reported as unsupported. They are not treated as an empty uncategorized total.",
  ]);
}

async function addFile(file, edit, expect, backup) {
  const absolute = requirePath(file, "--file");
  const original = await readFile(absolute);
  const parsed = parseDocumentBytes(original, absolute);
  assertExpect(rulesPayload(parsed), expect);
  const next = applyAdd(parsed, edit);
  if (stableStringify(rulesPayload(parsed)) === stableStringify(rulesPayload(next.document))) {
    return { result: "no-op", file: absolute, revision: expect, masked: next.masked };
  }
  const again = await readFile(absolute);
  if (!again.equals(original)) {
    throw new AxiError("The rules file changed after it was read. No backup was written and the file was not edited.", "CONFLICT");
  }
  await writeNewFile(backup, original);
  await writeFile(absolute, `${JSON.stringify(next.document, null, 2)}\n`, { mode: 0o600 });
  return {
    result: "updated",
    file: absolute,
    backup,
    revision: revisionOf(rulesPayload(next.document)),
    masked: next.masked,
    server_transaction: "unsupported",
  };
}

async function revertFile(file, backup, expect) {
  const absolute = requirePath(file, "--file");
  const current = await readFile(absolute);
  const parsed = parseDocumentBytes(current, absolute);
  assertExpect(rulesPayload(parsed), expect);
  const bytes = await readFile(backup);
  const again = await readFile(absolute);
  if (!again.equals(current)) {
    throw new AxiError("The rules file changed after it was read. It was not reverted.", "CONFLICT");
  }
  await writeFile(absolute, bytes);
  return { result: "restored", file: absolute, backup };
}

function applyAdd(document, edit) {
  const next = structuredClone(document);
  const sets = next.category_sets;
  const set = sets.find((item) => item.id === edit.setId);
  if (!set) {
    throw new AxiError(`Category set ${JSON.stringify(edit.setId)} is not in the document.`, "NOT_FOUND", [
      ...sets.map((item) => `set ${item.id}`),
    ]);
  }
  const key = JSON.stringify(edit.name);
  const existing = set.categories.find((category) => JSON.stringify(category.name) === key);
  if (!existing) {
    const rule = { type: "regex", regex: edit.pattern };
    set.categories.push({ name: edit.name, rule });
  } else {
    const rule = existing.rule;
    if (rule.type === "regex") {
      if (rule.regex !== edit.pattern) rule.regex = `${rule.regex}|${edit.pattern}`;
    } else {
      rule.type = "regex";
      rule.regex = edit.pattern;
    }
  }
  const edited = set.categories.find((category) => JSON.stringify(category.name) === key);
  if (edit.ignoreCase) edited.rule.ignore_case = true;
  if (edit.selectKeys) edited.rule.select_keys = edit.selectKeys;
  const payload = rulesPayload(next);
  const merged = mergeActive(payload);
  payload.classes = merged.map((category) => structuredClone(category));
  next.classes = payload.classes;
  const winner = merged.find((category) => JSON.stringify(category.name) === key);
  const masked = Boolean(winner && winner !== edited);
  return { document: next, masked };
}

export function mergeActive(document) {
  validateCategorySets(document);
  const ordered = document.active_set_ids.map((id) => document.category_sets.find((set) => set.id === id));
  const seen = new Set();
  const hidden = new Set(ordered[0].tombstones ?? []);
  const merged = [];
  ordered.forEach((set, index) => {
    for (const category of set.categories) {
      const key = JSON.stringify(category.name);
      if (seen.has(key)) continue;
      if (index > 0 && hidden.has(key)) continue;
      seen.add(key);
      merged.push(category);
    }
  });
  return merged;
}

function rulesPayload(document) {
  return {
    category_sets: document.category_sets ?? null,
    active_set_ids: document.active_set_ids ?? null,
    classes: document.classes ?? null,
  };
}

export function coverageOf(document) {
  if (document?.category_sets != null || document?.active_set_ids != null) {
    try {
      validateCategorySets(document);
      return "complete";
    } catch {
      return "unsupported";
    }
  }
  if (document?.category_sets == null && Array.isArray(document?.classes)) return "legacy-classes-only";
  return "unsupported";
}

function describeRules(document, full) {
  if (Array.isArray(document.category_sets)) {
    return document.category_sets.map((set) => ({
      id: set?.id ?? null,
      active: Array.isArray(document.active_set_ids) && document.active_set_ids.includes(set?.id),
      categories: Array.isArray(set?.categories) ? set.categories.length : null,
      ...(full ? { rules: summarizeCategories(set?.categories ?? [], true) } : {}),
      unknown_fields: unknownFields(set ?? {}, ["id", "categories", "tombstones"]),
    }));
  }
  if (Array.isArray(document.classes)) {
    return full ? summarizeCategories(document.classes, true) : `${document.classes.length} legacy categories`;
  }
  return "0 category sets";
}

function summarizeCategories(categories, full) {
  return categories.map((category) => {
    const regex = category?.rule?.regex;
    const shown =
      typeof regex === "string" && regex.length > 80 && !full
        ? `${regex.slice(0, 80)}… (${regex.length} chars)`
        : regex ?? null;
    return { name: (category?.name ?? []).join(" > "), regex: full ? regex ?? null : shown };
  });
}

function unknownFields(value, known) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).filter((key) => !known.includes(key));
}

function parseEdit(flags) {
  if (!flags.set || !flags.name || !flags.pattern) {
    throw new AxiError("--set, --name, and --pattern are required", "VALIDATION_ERROR");
  }
  const name = flags.name.split(">").map((part) => part.trim());
  if (name.some((part) => part.length === 0)) {
    throw new AxiError("--name must be a > separated category path", "VALIDATION_ERROR");
  }
  if (flags.pattern.length === 0 || flags.pattern.length > 2000) {
    throw new AxiError("--pattern must be 1 to 2000 characters", "VALIDATION_ERROR");
  }
  try {
    new RegExp(flags.pattern);
  } catch {
    throw new AxiError("The pattern is not a valid regular expression. Nothing was written.", "VALIDATION_ERROR");
  }
  const selectKeys = flags["select-keys"]
    ? flags["select-keys"].split(",").map((part) => part.trim()).filter(Boolean)
    : undefined;
  return { setId: flags.set, name, pattern: flags.pattern, ignoreCase: Boolean(flags["ignore-case"]), selectKeys };
}

async function readServerRules(client) {
  const [categorySets, activeIds, classes] = await Promise.all([
    getSetting(client, "category_sets"),
    getSetting(client, "active_set_ids"),
    getSetting(client, "classes"),
  ]);
  return { category_sets: categorySets, active_set_ids: activeIds, classes };
}

async function readRulesFile(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AxiError(`Rules file not found: ${file}`, "NOT_FOUND");
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AxiError("The rules file is not JSON. It was not modified.", "VALIDATION_ERROR");
  }
  if (Array.isArray(value)) return { kind: "array", value };
  if (value && typeof value === "object" && value.format === FORMAT) {
    if (value.coverage === "complete" || value.coverage === "server-sets") validateCategorySets(value);
    return { kind: "document", value };
  }
  return { kind: "other", value };
}

function parseDocumentBytes(bytes, file) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AxiError("The rules file is not JSON. It was not modified.", "VALIDATION_ERROR");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== FORMAT) {
    throw new AxiError(
      "Refusing to edit a file that is not an activitywatch-axi rules document.",
      "UNSUPPORTED",
      ["A first-set-only export cannot be edited into a complete configuration."],
    );
  }
  if (value.coverage !== "complete" && value.coverage !== "server-sets") {
    throw new AxiError(
      `Refusing to edit coverage ${value.coverage ?? "unknown"}.`,
      "UNSUPPORTED",
    );
  }
  validateCategorySets(value);
  return value;
}

function assertExpect(document, expect) {
  const actual = revisionOf(document);
  if (actual !== expect) {
    throw new AxiError(
      `The current revision is ${actual}, not ${expect}. Nothing was written.`,
      "CONFLICT",
      ["Read the document again and pass its current revision as --expect."],
    );
  }
}

function requireExpect(value) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) {
    throw new AxiError("--expect must be the current sha256 revision", "VALIDATION_ERROR");
  }
  return value;
}

function requirePath(value, flag) {
  if (!value) throw new AxiError(`${flag} is required`, "VALIDATION_ERROR");
  return path.resolve(value);
}

async function writeNewFile(file, contents) {
  try {
    await writeFile(file, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new AxiError(`${file} already exists. Choose a new path so the previous bytes stay intact.`, "CONFLICT");
    }
    throw error;
  }
}
