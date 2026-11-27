import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { createClient } from "./client.js";

export function baseUrlFrom(flags) {
  const raw = flags["base-url"] ?? process.env.AWAXI_BASE_URL;
  if (!raw) {
    throw new AxiError("`--base-url` is required", "VALIDATION_ERROR", [
      "Example: aw-axi timer status --base-url http://127.0.0.1:5600",
      "There is no default port, so a command cannot reach an ActivityWatch server by surprise.",
    ]);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AxiError("`--base-url` must be a valid URL", "VALIDATION_ERROR");
  }
  if (url.username || url.password) {
    throw new AxiError("The ActivityWatch URL cannot include a username or password", "VALIDATION_ERROR");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AxiError("`--base-url` must be http or https", "VALIDATION_ERROR");
  }
  if (!/^https?:\/\/[^/\\?#]+\/?$/i.test(raw.trim())) {
    throw new AxiError("`--base-url` must be an origin without a path, query, or fragment", "VALIDATION_ERROR");
  }
  if (process.env.AWAXI_REFUSE_5600 === "1" && url.port === "5600") {
    throw new AxiError("Refusing port 5600 for this run.", "VALIDATION_ERROR", [
      "Point --base-url at the task-owned loopback server.",
    ]);
  }
  return url.origin;
}

export function clientFrom(flags, signal, options) {
  return createClient(baseUrlFrom(flags), signal, options);
}

export function absolutePath(value) {
  return path.isAbsolute(value) ? value : process.cwd() + path.sep + value;
}

export function stateDirFrom(flags) {
  const raw = flags.state ?? process.env.AWAXI_STATE;
  if (!raw) {
    throw new AxiError("`--state` is required for this command", "VALIDATION_ERROR", [
      "Pass a directory this process may use for its own lock file.",
    ]);
  }
  return absolutePath(raw);
}

export function nowFrom(flags) {
  const raw = flags.now ?? (process.env.AWAXI_NOW || undefined);
  if (raw === undefined) return new Date();
  const calendar = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.exec(raw);
  const date = new Date(raw);
  let valid = Boolean(calendar) && Number.isFinite(date.getTime());
  if (valid) {
    const offset = calendar[7];
    let [year, month, day, hour, minute, second] = calendar.slice(1, 7).map(part => Number(part ?? 0));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    valid = day > 0 && day <= days[month - 1];
    if (valid && !offset) {
      if (hour === 24) {
        hour = 0;
        day += 1;
        if (day > days[month - 1]) {
          day = 1;
          month += 1;
        }
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      valid = date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day &&
        date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second;
    }
  }
  if (!valid) {
    throw new AxiError(`--now or AWAXI_NOW must be a valid ISO 8601 date-time: \`${raw}\``, "VALIDATION_ERROR", [
      "Use a date-time such as 2026-11-15T00:00:00Z",
    ]);
  }
  return date;
}

export function requireLabel(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\r\n]/.test(value)) {
    throw new AxiError("The label must be 1 to 200 characters and a single line", "VALIDATION_ERROR");
  }
  return value;
}

export function requireEventId(value) {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value ?? "") || !Number.isSafeInteger(id)) {
    throw new AxiError("--id must be a positive safe integer", "VALIDATION_ERROR");
  }
  return id;
}
