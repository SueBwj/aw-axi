import { AxiError, runAxiCli } from "axi-sdk-js";
import { parseArgs } from "./args.js";
import { clientFrom } from "./options.js";
import { rulesAdd, rulesExport, rulesPreview, rulesRevert, rulesShow } from "./rules.js";
import { taskTotals } from "./totals.js";
import { countRunning, timerStart, timerStatus, timerStop, timerSwitch } from "./timer.js";
import { uncategorized } from "./uncategorized.js";
import { nativeApply, nativePreview, nativeShow } from "./native-rules.js";
import { VERSION } from "./version.js";
import { addStopwatch, viewsShow } from "./views.js";

const TOP_LEVEL_HELP = `activitywatch-axi ${VERSION}
Local commands for an ActivityWatch server on this machine.

Commands:
  timer start|stop|switch|status
  totals
  uncategorized
  rules show|export|preview|add|apply|revert
  views show|add-stopwatch

Pass --base-url for every server command. There is no default port.
See README.md's Run section for state-directory and locking requirements.
\`aw-axi --tui --base-url <url>\` opens the read-only statistics dashboard.
Run \`aw-axi <command> --help\` for that command.
This build does not self-update and does not install session hooks.
`;

const HELP = {
  timer: `timer start|stop|switch|status
Native general.stopwatch events. Stop rewrites the same event id.

aw-axi timer start --label <label> --base-url <url> --state <dir>
aw-axi timer stop --label <label> --base-url <url> --state <dir>
aw-axi timer switch --from <label> --to <label> --base-url <url> --state <dir>
aw-axi timer status --base-url <url>

Flags:
  --label --id --from --to --base-url --bucket --now --state
Starting the label that is already running is a no-op.
A lost write response is not sent again.
`,
  totals: `totals
Stored completed time and current running time for one label.

aw-axi totals --label <label> --base-url <url>
aw-axi totals --label <label> --start 2026-11-15T00:00:00 --end 2026-11-16T00:00:00 --timezone Asia/Taipei --base-url <url>

Flags:
  --label --start --end --timezone --base-url --bucket --now
--end is exclusive. Overlapping stored intervals count once.
Window and AFK time is not added.
`,
  uncategorized: `uncategorized
App and domain totals that no supplied rule matched.

aw-axi uncategorized --rules <file> --base-url <url> --timezone Asia/Taipei
aw-axi uncategorized --server-rules --base-url <url>

Flags:
  --rules --server-rules --start --end --timezone --host --base-url --now
The default range is the last seven local days, ending now.
Titles, full URLs, and raw events are not printed.
A partial or missing rule file is refused instead of reported as uncategorized.
App and observed web-tab totals are separate measures; do not add them together.
Conflicting hosts require --host. Gaps in an existing AFK bucket and ambiguous activity overlaps are refused.
`,
  rules: `rules show|export|preview|add|apply|revert
Explicit category-rule documents. Browser profiles are not searched.

aw-axi rules show --base-url <url>
aw-axi rules export --file <path> --base-url <url>
aw-axi rules preview --file <path>
aw-axi rules add --file <path> --set <id> --name <A>B> --pattern <regex> --expect <revision> --backup <path>
aw-axi rules revert --file <path> --backup <path> --expect <revision>

Flags:
  --file --server --set --name --pattern --ignore-case --select-keys
  --expect --backup --base-url --state --full
Native release-pinned path:
  rules show --native --base-url <url>
  rules export --native --file <path> --base-url <url>
  rules preview --native --file <complete-document>
  rules apply --server --file <complete-document> --base-url <url> --state <dir> --expect <revision> --backup <new-path>
  rules revert --native --server --backup <saved-backup> --save-backup <new-path> --base-url <url> --state <dir> --expect <revision>
Use --initialize only to explicitly initialize absent native settings from a complete document.
Server writes are one key at a time. There is no compare-and-swap.
Reload the native UI and verify classification separately; persistence is not UI adoption.
`,
  views: `views show|add-stopwatch
Dashboard layouts stored in the server views setting.

aw-axi views show --base-url <url>
aw-axi views add-stopwatch --id summary --expect <revision> --backup <path> --base-url <url> --state <dir>

Flags:
  --id --expect --backup --base-url --state
A null views value is left untouched. The CLI cannot see a browser-local override.
The read-compare-write is not atomic with other writers.
`,
};

export async function main() {
  if (process.argv.slice(2).includes("--tui")) {
    const { runTui } = await import("./tui.js");
    await runTui(process.argv.slice(2));
    return;
  }
  await runAxiCli({
    description: "Operate the local ActivityWatch API: timers, totals, uncategorized time, category rules, and dashboard settings.",
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command) => HELP[command] ?? null,
    home: () => home(),
    commands: {
      timer: (args) => timerCommand(args),
      totals: (args) => totalsCommand(args),
      uncategorized: (args) => uncategorizedCommand(args),
      rules: (args) => rulesCommand(args),
      views: (args) => viewsCommand(args),
      update: () => {
        throw new AxiError("This local-only build does not self-update or install hooks.", "UNSUPPORTED", [
          "Run `aw-axi --help` for the local commands.",
        ]);
      },
    },
  });
}

async function home() {
  if (!process.env.AWAXI_BASE_URL) {
    return {
      server: "not-configured",
      running_count: "unknown",
      help: [
        "Run `aw-axi timer status --base-url <url>` to see timer labels.",
        "Run `aw-axi --help` for the command list.",
      ],
    };
  }
  try {
    const counted = await countRunning(clientFrom({}));
    return {
      server: "reachable",
      bucket: counted.bucket,
      running_count: counted.running_count,
      help: ["Run `aw-axi timer status --base-url <url>` to see timer labels."],
    };
  } catch (error) {
    if (error instanceof AxiError && (error.code === "DISCONNECTED" || error.code === "SERVER")) {
      return {
        server: "unreachable",
        running_count: "unknown",
        help: ["Check --base-url, then run `aw-axi timer status --base-url <url>`."],
      };
    }
    throw error;
  }
}

async function timerCommand(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "start") {
    const flags = parseArgs(rest, {
      command: "timer start",
      flags: { label: "string", "base-url": "string", bucket: "string", now: "string", state: "string" },
      required: ["label"],
    });
    return timerStart(flags, clientFrom(flags));
  }
  if (sub === "stop") {
    const flags = parseArgs(rest, {
      command: "timer stop",
      flags: { label: "string", id: "string", "base-url": "string", bucket: "string", now: "string", state: "string" },
    });
    return timerStop(flags, clientFrom(flags));
  }
  if (sub === "switch") {
    const flags = parseArgs(rest, {
      command: "timer switch",
      flags: { to: "string", from: "string", "base-url": "string", bucket: "string", now: "string", state: "string" },
      required: ["to"],
    });
    return timerSwitch(flags, clientFrom(flags));
  }
  if (sub === "status") {
    const flags = parseArgs(rest, {
      command: "timer status",
      flags: { "base-url": "string", bucket: "string", now: "string" },
    });
    return timerStatus(flags, clientFrom(flags));
  }
  throw new AxiError("timer needs start, stop, switch, or status", "VALIDATION_ERROR", [
    "Run `aw-axi timer --help`",
  ]);
}

async function totalsCommand(args) {
  const flags = parseArgs(args, {
    command: "totals",
    flags: {
      label: "string",
      start: "string",
      end: "string",
      timezone: "string",
      "base-url": "string",
      bucket: "string",
      now: "string",
    },
    required: ["label"],
  });
  return taskTotals(flags, clientFrom(flags));
}

async function uncategorizedCommand(args) {
  const flags = parseArgs(args, {
    command: "uncategorized",
    flags: {
      rules: "string",
      "server-rules": "boolean",
      start: "string",
      end: "string",
      timezone: "string",
      host: "string",
      "base-url": "string",
      now: "string",
    },
  });
  return uncategorized(flags, clientFrom(flags));
}

async function rulesCommand(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "show") {
    const flags = parseArgs(rest, {
      command: "rules show",
      flags: { "base-url": "string", full: "boolean", native: "boolean" },
    });
    return flags.native ? nativeShow(flags, clientFrom(flags)) : rulesShow(flags, clientFrom(flags));
  }
  if (sub === "export") {
    const flags = parseArgs(rest, {
      command: "rules export",
      flags: { file: "string", "base-url": "string", native: "boolean" },
      required: ["file"],
    });
    return flags.native ? nativeShow(flags, clientFrom(flags)) : rulesExport(flags, clientFrom(flags));
  }
  if (sub === "preview") {
    const flags = parseArgs(rest, {
      command: "rules preview",
      flags: { file: "string", full: "boolean", native: "boolean" },
      required: ["file"],
    });
    return flags.native ? nativePreview(flags) : rulesPreview(flags);
  }
  if (sub === "apply") {
    const flags = parseArgs(rest, {
      command: "rules apply",
      flags: { file: "string", server: "boolean", "base-url": "string", state: "string", expect: "string", backup: "string", initialize: "boolean" },
      required: ["file", "server", "base-url", "state", "expect", "backup"],
    });
    return nativeApply(flags, clientFrom(flags));
  }
  if (sub === "add") {
    const flags = parseArgs(rest, {
      command: "rules add",
      flags: {
        file: "string",
        server: "boolean",
        set: "string",
        name: "string",
        pattern: "string",
        "ignore-case": "boolean",
        "select-keys": "string",
        expect: "string",
        backup: "string",
        "base-url": "string",
        state: "string",
      },
      required: ["set", "name", "pattern", "expect", "backup"],
    });
    return rulesAdd(flags, flags.server ? clientFrom(flags) : null);
  }
  if (sub === "revert") {
    const flags = parseArgs(rest, {
      command: "rules revert",
      flags: {
        native: "boolean",
        "save-backup": "string",
        file: "string",
        server: "boolean",
        backup: "string",
        expect: "string",
        "base-url": "string",
        state: "string",
      },
      required: ["backup", "expect"],
    });
    return flags.native ? nativeApply(flags, clientFrom(flags), true) : rulesRevert(flags, flags.server ? clientFrom(flags) : null);
  }
  throw new AxiError("rules needs show, export, preview, add, apply, or revert", "VALIDATION_ERROR", [
    "Run `aw-axi rules --help`",
  ]);
}

async function viewsCommand(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "show") {
    const flags = parseArgs(rest, {
      command: "views show",
      flags: { "base-url": "string", id: "string" },
    });
    return viewsShow(flags, clientFrom(flags));
  }
  if (sub === "add-stopwatch") {
    const flags = parseArgs(rest, {
      command: "views add-stopwatch",
      flags: { id: "string", expect: "string", backup: "string", "base-url": "string", state: "string" },
      required: ["id", "expect", "backup"],
    });
    return addStopwatch(flags, clientFrom(flags));
  }
  throw new AxiError("views needs show or add-stopwatch", "VALIDATION_ERROR", [
    "Run `aw-axi views --help`",
  ]);
}
