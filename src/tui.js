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
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  rejectConflicts(argv);
  const once = argv.includes("--once");
  const flags = parseArgs(
    argv.filter((token) => token !== "--tui" && token !== "--once"),
    {
      command: "--tui",
      flags: {
        "base-url": "string",
        host: "string",
        bucket: "string",
        start: "string",
        end: "string",
        timezone: "string",
        now: "string",
      },
    },
  );
  const interactive = !once && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    await printOnce(flags);
    return;
  }
  await live(flags);
}

function rejectConflicts(argv) {
  const command = argv.find((token) => COMMANDS.includes(token));
  const output = argv.find((token) => OUTPUT_FLAGS.has(token) || token.startsWith("--format=") || token.startsWith("--output="));
  if (!command && !output) return;
  const which = command ? `command \`${command}\`` : `output flag \`${output}\``;
  throw new AxiError(`\`--tui\` cannot be combined with ${which}.`, "VALIDATION_ERROR", [
    "Run `aw-axi --tui --base-url <url>` for the dashboard.",
    "Run the other command without `--tui` for its usual output.",
  ]);
}

async function printOnce(flags) {
  const columns = process.stdout.columns || 80;
  try {
    const model = await dashboardFrom(flags, "today");
    writeFrame(model, columns);
  } catch (error) {
    writeFrame(errorModel(error), columns);
    process.exitCode = error instanceof AxiError ? exitCodeForError(error) : 1;
  }
}

function writeFrame(model, columns) {
  const color = colorEnabled(process.stdout);
  process.stdout.write(`${paintDashboard(renderDashboard(model, { columns }), color)}\n`);
}

async function live(flags) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let mode = "today";
  let scroll = 0;
  let view = { ok: false, message: "Reading the current range." };
  let refreshing = false;
  let pending = false;
  let closed = false;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\u001b[?1049h\u001b[?25l");
  const restore = () => {
    if (closed) return;
    closed = true;
    stdout.write("\u001b[?25h\u001b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdin.off("data", onData);
    stdout.off("resize", paint);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
  const paint = () => {
    if (closed) return;
    const columns = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const framed = frameDashboard(renderDashboard(view, { columns }), { rows, scroll });
    scroll = framed.offset;
    stdout.write(`\u001b[H\u001b[2J${paintDashboard(framed.text, colorEnabled(stdout))}`);
  };
  const refresh = () => {
    if (closed) return;
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    dashboardFrom(flags, mode).then(
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
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    if (text.includes("\u0003") || text.includes("q")) {
      restore();
      return;
    }
    if (text.includes("r")) {
      refresh();
      return;
    }
    if (text.includes("j") || text.includes("\u001b[B")) scroll += 1;
    if (text.includes("k") || text.includes("\u001b[A")) scroll = Math.max(0, scroll - 1);
    if (rangeModeAllowed(flags) && text.includes("t")) {
      mode = "today";
      scroll = 0;
      refresh();
      return;
    }
    if (rangeModeAllowed(flags) && text.includes("7")) {
      mode = "seven";
      scroll = 0;
      refresh();
      return;
    }
    paint();
  };
  const onSignal = () => restore();
  stdin.on("data", onData);
  stdout.on("resize", paint);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  refresh();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!closed) return;
      clearInterval(timer);
      resolve();
    }, 30);
  });
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
