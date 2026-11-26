import { AxiError } from "axi-sdk-js";

export function parseArgs(argv, definition) {
  const flags = {};
  const positionals = [];
  const names = Object.keys(definition.flags);
  const known = new Set(names);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (!known.has(name)) {
      throw new AxiError(
        `Unknown flag --${name} for \`${definition.command}\``,
        "VALIDATION_ERROR",
        [
          `Valid flags: ${names.map((flag) => `--${flag}`).join(", ")}`,
          `Run \`aw-axi ${definition.command} --help\``,
        ],
      );
    }
    if (Object.hasOwn(flags, name)) {
      throw new AxiError(`Duplicate flag --${name}`, "VALIDATION_ERROR", [
        `Run \`aw-axi ${definition.command} --help\``,
      ]);
    }
    const kind = definition.flags[name];
    if (kind === "boolean") {
      if (inline !== undefined) {
        throw new AxiError(`--${name} does not take a value`, "VALIDATION_ERROR");
      }
      flags[name] = true;
      continue;
    }
    if (inline === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new AxiError(`--${name} requires a value`, "VALIDATION_ERROR", [
          `Use --${name}=<value>`,
        ]);
      }
      inline = next;
      index += 1;
    }
    flags[name] = inline;
  }
  if (positionals.length > 0) {
    throw new AxiError(
      `Unexpected argument \`${positionals[0]}\` for \`${definition.command}\``,
      "VALIDATION_ERROR",
      [`Run \`aw-axi ${definition.command} --help\``],
    );
  }
  for (const name of definition.required ?? []) {
    if (flags[name] === undefined) {
      throw new AxiError(`--${name} is required`, "VALIDATION_ERROR", [
        `Run \`aw-axi ${definition.command} --help\``,
      ]);
    }
  }
  return flags;
}
