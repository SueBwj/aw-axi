import { clipDisplay, displayWidth, formatDuration, padDisplay, sanitizeTerminal } from "./tui-data.js";

const TONES = {
  plain: "",
  amber: "\u001b[38;5;179m",
  teal: "\u001b[38;5;73m",
  peach: "\u001b[38;5;216m",
  bar: "\u001b[38;5;110m",
};

export function renderDashboard(model, { columns = 80 } = {}) {
  const width = Math.max(1, columns);
  if (model?.loading) return clipDisplay(`Reading ${rangeLabel(model.mode)}…`, width);
  const lines = model?.ok ? board(model, width) : errorBoard(model, width);
  return lines.join("\n");
}

export function paintDashboard(text, color) {
  if (!color) return text;
  return text.split("\n").map((line) => paint(line)).join("\n");
}

export function frameDashboard(text, { columns = 80, rows = 24, scroll = 0 } = {}) {
  const lines = text.split("\n");
  const hint = lines.at(-1) ?? "";
  const body = lines.slice(0, -1);
  if (rows <= 1) return { text: hint, offset: 0, hidden: body.length };
  const showStatus = rows >= 3;
  const room = rows - (showStatus ? 2 : 1);
  const offset = Math.max(0, Math.min(scroll, Math.max(0, body.length - room)));
  const slice = body.slice(offset, offset + room);
  while (slice.length < room) slice.push("");
  const above = offset > 0 ? `↑ ${offset} more` : "";
  const below = offset + room < body.length ? `↓ ${body.length - (offset + room)} more` : "";
  if (showStatus) slice.push(clipDisplay([above, below].filter(Boolean).join("  "), columns));
  return { text: [...slice, hint].join("\n"), offset, hidden: Math.max(0, body.length - room) };
}

function board(model, width) {
  const header = clipDisplay(
    `aw-axi  ${model.anchor}  ${model.timeZone}  ${rangeLabel(model.mode)}  host ${model.host}`,
    width,
  );
  const coverage = coverageCard(model);
  const timers = timerCard(model.timers);
  const apps = listCard("Apps", "share of the foreground union", model.apps, "No window bucket. Foreground is unknown, not zero.");
  const web = listCard("Web tabs", "observed tab time, not foreground browser use", model.web, "No web bucket. Observed tab time is unknown, not zero.");
  const categories = noteCard("Categories", model.categories.reason);
  const uncategorized = noteCard("Uncategorized", model.uncategorized.reason);
  const hint = clipHint(
    model.mode === "explicit"
      ? "j/k scroll  ·  r refresh  ·  q quit"
      : "t today  ·  7 seven days  ·  j/k scroll  ·  r refresh  ·  q quit",
    width,
  );
  const body = width >= 100
    ? [
        ...pair(coverage, timers, width),
        "",
        ...fit(apps, width),
        "",
        ...fit(web, width),
        "",
        ...pair(categories, uncategorized, width),
      ]
    : [...stack([coverage, timers, apps, web, categories, uncategorized], width)];
  return [header, "", ...body, "", hint];
}

function errorBoard(model, width) {
  const message = model?.message || "The dashboard could not be read.";
  const detail = Array.isArray(model?.detail) ? model.detail : [];
  return [
    clipDisplay("aw-axi --tui", width),
    "",
    ...wrap(message, width),
    ...detail.flatMap((line) => wrap(line, width)),
    "",
    ...wrap("No activity totals are shown for this failed read.", width),
    "",
    clipHint("r refresh  ·  q quit", width),
  ];
}

function rangeLabel(mode) {
  if (mode === "seven") return "last seven days";
  if (mode === "explicit") return "explicit range";
  return "today";
}

function coverageCard(model) {
  const lines = ["Coverage", ""];
  lines.push(metric("elapsed", formatDuration(model.elapsed)));
  if (model.apps.absent) lines.push("foreground union  unknown");
  else if (model.apps.truncated) lines.push("foreground union  withheld at 10000 events");
  else {
    lines.push(metric("foreground union", formatDuration(model.apps.union)));
    const gap = Math.max(0, model.elapsed - model.apps.union);
    lines.push(metric("no window event", formatDuration(gap), true));
    lines.push("empty track is the rest of this union, not idle");
  }
  if (model.afk.absent) lines.push(metric("AFK", "unknown"));
  else if (model.afk.truncated) lines.push("AFK  withheld at 10000 events");
  else {
    lines.push(metric("not-afk", formatDuration(model.afk.notAfk)));
    lines.push(metric("afk", formatDuration(model.afk.afk)));
    lines.push(metric("AFK overlap", formatDuration(model.afk.overlap), true));
    lines.push(metric("AFK missing", formatDuration(model.afk.missing), true));
    if (model.afk.unrecognized) lines.push(metric("AFK unrecognized", formatDuration(model.afk.unrecognized), true));
  }
  lines.push(metric("not-afk with windows", "withheld"));
  if (model.apps.invalid || model.afk.invalid) lines.push("Some events were unreadable and were left out.");
  return lines;
}

function timerCard(timers) {
  const lines = ["Timers", "not added to foreground", ""];
  if (timers.state !== "ready") {
    lines.push(timers.reason);
    return lines;
  }
  if (timers.rows.length === 0) lines.push("No timer time in this range.");
  for (const row of timers.rows) {
    const label = sanitizeTerminal(row.label);
    const name = clipDisplay(label.trim() ? label : "(unnamed)", 24);
    if (row.running > 0) lines.push(`${name}  running ${formatDuration(row.running)}`);
    if (row.stored > 0) lines.push(`${name}  stored ${formatDuration(row.stored)}`);
  }
  if (timers.invalid) lines.push("Some timer events had no single-line label.");
  lines.push(timers.reason);
  return lines;
}

function listCard(title, measure, data, absentText) {
  const lines = [title, measure, ""];
  if (data.absent) {
    lines.push(absentText);
    return lines;
  }
  if (data.truncated || data.union === null) {
    lines.push("Withheld after 10000 events. A truncated list was not totaled.");
    return lines;
  }
  lines.push(metric("union", formatDuration(data.union)));
  const scale = data.union || 1;
  for (const row of data.rows) {
    const label = sanitizeTerminal(row.key);
    const name = clipDisplay(label.trim() ? label : "(unnamed)", 22);
    const bar = thinBar(row.ms / scale, 16);
    lines.push(`${padDisplay(name, 22, "start")} ${bar} ${formatDuration(row.ms)}`);
  }
  if (data.rows.length === 0) lines.push("No events in this range.");
  if (data.rowsOverlap) lines.push("Rows overlap. They are not a partition of the union.");
  if (data.invalid) lines.push("Some events were unreadable and were left out.");
  return lines;
}

function noteCard(title, reason) {
  return [title, "", reason];
}

function metric(label, value, unknown = false) {
  const shown = unknown ? `${value}  unknown` : value;
  return `${padDisplay(label, 22, "start")} ${shown}`;
}

function thinBar(ratio, width) {
  const bounded = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(bounded * width);
  return `${"━".repeat(filled)}${"╌".repeat(Math.max(0, width - filled))}`;
}

function pair(left, right, width) {
  const column = Math.floor((width - 2) / 2);
  const a = fit(left, column);
  const b = fit(right, column);
  const rows = Math.max(a.length, b.length);
  const lines = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${padDisplay(a[index] ?? "", column, "start")}  ${b[index] ?? ""}`);
  }
  return lines;
}

function stack(cards, width) {
  return cards.flatMap((card, index) => [...(index ? [""] : []), ...fit(card, width)]);
}

function fit(lines, width) {
  if (width < 5) return lines.flatMap((line) => wrap(line, width));
  const inner = width - 4;
  const boxed = ["┌" + "─".repeat(inner + 2) + "┐"];
  for (const line of lines) {
    for (const wrapped of wrap(line, inner)) boxed.push(`│ ${padDisplay(wrapped, inner, "start")} │`);
  }
  boxed.push("└" + "─".repeat(inner + 2) + "┘");
  return boxed.map((line) => clipDisplay(line, width));
}

function clipHint(text, width) {
  if (displayWidth(text) <= width) return text;
  let end = text.length;
  while (end > 0) {
    const space = text.lastIndexOf(" ", end - 1);
    if (space <= 0) break;
    end = space;
    const kept = text.slice(0, end).trimEnd();
    if (kept && displayWidth(`${kept}…`) <= width) return `${kept}…`;
  }
  return clipDisplay(text, width);
}

function wrap(text, width) {
  const source = String(text);
  if (displayWidth(source) <= width) return [source];
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    const piece = clipDisplay(word, width);
    const next = current ? `${current} ${piece}` : piece;
    if (displayWidth(next) > width && current) {
      lines.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function paint(line) {
  return line
    .replaceAll("unknown", `${TONES.amber}unknown\u001b[0m`)
    .replaceAll("withheld", `${TONES.amber}withheld\u001b[0m`)
    .replaceAll("observed tab time, not foreground browser use", `${TONES.teal}observed tab time, not foreground browser use\u001b[0m`)
    .replaceAll("not added to foreground", `${TONES.peach}not added to foreground\u001b[0m`)
    .replaceAll(/[━╌]+/g, (bar) => `${TONES.bar}${bar}\u001b[0m`);
}
