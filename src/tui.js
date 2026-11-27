import { emitKeypressEvents } from "node:readline";
import { AxiError, exitCodeForError } from "axi-sdk-js";
import { parseArgs } from "./args.js";
import { dashboardFrom, rangeModeAllowed, sanitizeTerminal } from "./tui-data.js";
import { frameDashboard, paintDashboard, renderDashboard } from "./tui-render.js";

const COMMANDS = ["timer", "totals", "uncategorized", "rules", "views", "update"];
const OUTPUT_FLAGS = new Set(["--json", "--toon", "--format", "--output"]);

const HELP = `aw-axi --tui
Read-only activity, AFK coverage, app and website durations, and manual timers.

aw-axi --tui --base-url <url>
aw-axi --tui --base-url <url> --host <hostname>
aw-axi --tui --base-url <url> --start 2026-11-16T00:00:00 --end 2026-11-16T12:00:00 --timezone Asia/Shanghai
aw-axi --tui --base-url <url> --once

Flags:
  --base-url --host --bucket --start --end --timezone --now --once
--now (or AWAXI_NOW) accepts an ISO 8601 date-time, for example 2026-11-15T00:00:00Z.
--base-url is required. There is no default port.
The default range is today in --timezone, ending at the refresh anchor. --end is exclusive.
t and 7 switch today and the last seven days. An explicit range does not offer those keys.
--once prints one frame and exits. A non-TTY does the same.
q and Ctrl-C quit. r refreshes. j and k scroll.
NO_COLOR and TERM=dumb leave the layout and drop color.
Timer totals are not added to foreground time.
Missing or overlapping AFK time stays unknown. No status is chosen by sort order.
Observed web-tab time is not foreground browser use. App and web rows are not added together.
Categories stay unavailable unless a complete native rule set is already stored, and even then
desktop category totals stay withheld: window events do not carry browser URLs.
Titles, full URLs, and raw events are not printed.
This view does not write to the server.
`;

export async function runTui(argv) {
  try {
    await dispatchTui(argv);
  } catch (error) {
    process.stdout.write(startupError(error));
    process.exitCode = error instanceof AxiError ? exitCodeForError(error) : 1;
  }
}

async function dispatchTui(argv) {
  const flags = parseArgs(argv, {
    command: "--tui",
    flags: {
      tui: "boolean",
      once: "boolean",
      help: "boolean",
      "base-url": "string",
      host: "string",
      bucket: "string",
      start: "string",
      end: "string",
      timezone: "string",
      now: "string",
    },
    rejectUnexpected: rejectConflict,
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  const interactive = !flags.once && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    await printOnce(flags);
    return;
  }
  await live(flags);
}

function rejectConflict(token) {
  const command = COMMANDS.includes(token);
  if (!command && !OUTPUT_FLAGS.has(token.split("=", 1)[0])) return;
  const which = command ? `command \`${token}\`` : `output flag \`${token}\``;
  throw new AxiError(`\`--tui\` cannot be combined with ${which}.`, "VALIDATION_ERROR", [
    "Run `aw-axi --tui --base-url <url>` for the dashboard.",
    "Run the other command without `--tui` for its usual output.",
  ]);
}

async function printOnce(flags) {
  try {
    const model = await dashboardFrom(flags, "today");
    writeFrame(model);
  } catch (error) {
    writeFrame(errorModel(error));
    process.exitCode = error instanceof AxiError ? exitCodeForError(error) : 1;
  }
}

function writeFrame(model) {
  const stdout = process.stdout;
  const columns = stdout.columns || 80;
  const text = renderDashboard(model, { columns });
  stdout.write(`${paintDashboard(text, colorEnabled(stdout))}\n`);
}

async function live(flags) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let mode = rangeModeAllowed(flags) ? "today" : "explicit";
  let scroll = 0;
  let view = null;
  let refreshing = false;
  let pending = false;
  let closed = false;
  const controller = new AbortController();
  const quit = Promise.withResolvers();
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\u001b[?1049h\u001b[?25l");
  const restore = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    stdout.write("\u001b[?25h\u001b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdin.off("keypress", onKeypress);
    stdout.off("resize", paint);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    quit.resolve();
  };
  const paint = () => {
    if (closed) return;
    const columns = stdout.columns || 80;
    let text = renderDashboard(view ?? { loading: true, mode }, { columns });
    if (view) {
      const framed = frameDashboard(text, { columns, rows: stdout.rows || 24, scroll });
      scroll = framed.offset;
      text = framed.text;
    }
    stdout.write(`\u001b[H\u001b[2J${paintDashboard(text, colorEnabled(stdout))}`);
  };
  const refresh = () => {
    if (closed) return;
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    dashboardFrom(flags, mode, controller.signal).then(
      (model) => {
        if (pending || closed) return;
        view = model;
      },
      (error) => {
        if (pending || closed) return;
        view = errorModel(error);
      },
    ).finally(() => {
      refreshing = false;
      if (closed) return;
      if (pending) {
        pending = false;
        refresh();
      } else {
        paint();
      }
    });
  };
  const onKeypress = (text, key) => {
    if (closed) return;
    if (text === "\u0003" || text === "q") {
      restore();
      return;
    }
    if (text === "r") {
      refresh();
      return;
    }
    if (rangeModeAllowed(flags) && (text === "t" || text === "7")) {
      const nextMode = text === "t" ? "today" : "seven";
      scroll = 0;
      if (nextMode !== mode) {
        mode = nextMode;
        view = null;
        paint();
      }
      refresh();
      return;
    }
    if (text === "j" || key.name === "down") scroll += 1;
    else if (text === "k" || key.name === "up") scroll = Math.max(0, scroll - 1);
    else return;
    if (view) paint();
  };
  const onSignal = () => restore();
  stdin.on("keypress", onKeypress);
  stdout.on("resize", paint);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  refresh();
  await quit.promise;
}

function startupError(error) {
  const message = sanitizeTerminal(error instanceof Error ? error.message : String(error));
  const code = error instanceof AxiError ? error.code : "UNKNOWN";
  const lines = [`error: ${JSON.stringify(message)}`, `code: ${code}`];
  const help = error instanceof AxiError ? error.suggestions ?? [] : [];
  if (help.length > 0) {
    lines.push(`help[${help.length}]:`);
    for (const item of help) lines.push(`  - ${sanitizeTerminal(item)}`);
  }
  return `${lines.join("\n")}\n`;
}

function errorModel(error) {
  if (error instanceof AxiError) {
    return {
      ok: false,
      message: sanitizeTerminal(error.message),
      detail: (error.suggestions ?? []).map((line) => sanitizeTerminal(line)),
    };
  }
  return { ok: false, message: sanitizeTerminal(error instanceof Error ? error.message : String(error)), detail: [] };
}

function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream?.isTTY);
}
