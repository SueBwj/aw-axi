import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { getSetting, putSetting } from "./client.js";
import { withLock } from "./lock.js";
import { stateDirFrom } from "./options.js";
import { revisionOf, stableStringify } from "./revision.js";

const BACKUP_FORMAT = "activitywatch-axi.views-backup.v1";

export async function viewsShow(flags, client) {
  const views = await getSetting(client, "views");
  const revision = revisionOf(views);
  if (views === null) {
    return {
      revision,
      views: null,
      browser_fallback: "unreadable",
      result:
        "Server views are null. A browser-local fallback may exist. This CLI cannot read it and will not replace it with a default layout.",
    };
  }
  if (!Array.isArray(views)) {
    throw new AxiError(
      "Server views are neither null nor a list. They were not replaced.",
      "AMBIGUOUS",
    );
  }
  const shown = flags.id ? views.filter((view) => view?.id === flags.id) : views;
  if (flags.id && shown.length !== 1) {
    throw new AxiError(
      shown.length === 0
        ? `No view has id ${JSON.stringify(flags.id)}. No default view was created.`
        : `${shown.length} views have id ${JSON.stringify(flags.id)}.`,
      "AMBIGUOUS",
    );
  }
  const rows = shown.map((view) => summarize(view));
  return {
    revision,
    view_count: views.length,
    views: rows.length === 0 ? "0 views" : rows,
    browser_fallback: "server-value-present",
  };
}

export async function addStopwatch(flags, client) {
  if (!flags.id) throw new AxiError("--id is required", "VALIDATION_ERROR");
  const expect = flags.expect;
  if (!/^[a-f0-9]{64}$/.test(expect ?? "")) {
    throw new AxiError("--expect must be the current sha256 revision", "VALIDATION_ERROR");
  }
  const backup = path.resolve(flags.backup ?? "");
  if (!flags.backup) throw new AxiError("--backup is required", "VALIDATION_ERROR");
  const stateDir = stateDirFrom(flags);
  return withLock(stateDir, "settings", async () => {
    const views = await getSetting(client, "views");
    if (views === null) {
      throw new AxiError(
        "Server views are null. The stopwatch panel was not added and no default layout was written.",
        "UNSUPPORTED",
        ["A browser-local Summary layout is not readable from this CLI."],
      );
    }
    if (!Array.isArray(views)) {
      throw new AxiError("Server views are not a list. Nothing was written.", "AMBIGUOUS");
    }
    const matches = views.filter((view) => view?.id === flags.id);
    if (matches.length !== 1) {
      throw new AxiError(
        matches.length === 0
          ? `No view has id ${JSON.stringify(flags.id)}. Nothing was written.`
          : `${matches.length} views have id ${JSON.stringify(flags.id)}. Nothing was written.`,
        "AMBIGUOUS",
      );
    }
    const actual = revisionOf(views);
    if (actual !== expect) {
      throw new AxiError(`The current views revision is ${actual}, not ${expect}. Nothing was written.`, "CONFLICT", [
        "Run `aw-axi views show --base-url <url>` and pass that revision.",
      ]);
    }
    const target = matches[0];
    if (!Array.isArray(target.elements)) {
      throw new AxiError("The selected view has no element list. Nothing was written.", "AMBIGUOUS");
    }
    if (target.elements.some((element) => element?.type === "top_stopwatches")) {
      return { result: "no-op", id: flags.id, revision: actual, top_stopwatches: true };
    }
    const again = await getSetting(client, "views");
    if (revisionOf(again) !== expect) {
      throw new AxiError("Views changed after they were read. Nothing was written.", "CONFLICT");
    }
    const next = again.map((view) => {
      if (view !== target && view?.id !== flags.id) return view;
      if (view?.id !== flags.id) return view;
      return {
        ...view,
        elements: [...view.elements, { type: "top_stopwatches", props: {} }],
      };
    });
    if (next.filter((view) => view?.id === flags.id).length !== 1) {
      throw new AxiError("The selected view was no longer unique. Nothing was written.", "AMBIGUOUS");
    }
    await writeNewFile(
      backup,
      `${JSON.stringify({ format: BACKUP_FORMAT, revision: expect, views: again }, null, 2)}\n`,
    );
    await putSetting(client, "views", next);
    const confirmed = await getSetting(client, "views");
    if (stableStringify(confirmed) !== stableStringify(next)) {
      throw new AxiError(
        "Views do not match the write that was sent. It was not retried.",
        "UNCERTAIN_WRITE",
        [`Backup: ${backup}`, "Run `aw-axi views show --base-url <url>` before another edit."],
      );
    }
    return {
      result: "updated",
      id: flags.id,
      backup,
      revision: revisionOf(confirmed),
      top_stopwatches: true,
      server_transaction: "unsupported",
    };
  });
}

function summarize(view) {
  const elements = Array.isArray(view?.elements) ? view.elements.map((element) => element?.type ?? "unknown") : null;
  return {
    id: view?.id ?? null,
    name: view?.name ?? null,
    elements,
    top_stopwatches: Array.isArray(elements) && elements.includes("top_stopwatches"),
  };
}

async function writeNewFile(file, contents) {
  try {
    await writeFile(file, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new AxiError(`${file} already exists. Choose a new backup path.`, "CONFLICT");
    }
    throw error;
  }
}

export async function readViewsBackup(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
