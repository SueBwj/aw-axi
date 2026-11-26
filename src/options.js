import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { createClient } from "./client.js";

export function baseUrlFrom(flags) {
  const raw = flags["base-url"] || process.env.AWAXI_BASE_URL;
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
    throw new AxiError(`Could not read URL \`${raw}\``, "VALIDATION_ERROR");
  }
  if (url.username || url.password) {
    throw new AxiError("The ActivityWatch URL cannot include a username or password", "VALIDATION_ERROR");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AxiError("`--base-url` must be http or https", "VALIDATION_ERROR");
  }
  if (process.env.AWAXI_REFUSE_5600 === "1" && url.port === "5600") {
    throw new AxiError("Refusing port 5600 for this run.", "VALIDATION_ERROR", [
      "Point --base-url at the task-owned loopback server.",
    ]);
  }
  return url.origin;
}

export function clientFrom(flags) {
  return createClient(baseUrlFrom(flags));
}

export function stateDirFrom(flags) {
  const raw = flags.state || process.env.AWAXI_STATE;
  if (!raw) {
    throw new AxiError("`--state` is required for this command", "VALIDATION_ERROR", [
      "Pass a directory this process may use for its own lock file.",
    ]);
  }
  return path.resolve(raw);
}

export function nowFrom(flags) {
  const raw = flags.now || process.env.AWAXI_NOW;
  if (!raw) return new Date();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new AxiError(`Could not read --now \`${raw}\``, "VALIDATION_ERROR", [
      "Use an instant such as 2026-11-15T00:00:00Z",
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
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new AxiError("--id must be a positive integer", "VALIDATION_ERROR");
  }
  return Number(value);
}
