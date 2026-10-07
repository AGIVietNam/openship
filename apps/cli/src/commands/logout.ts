import { Command } from "commander";
import { clearToken, getActiveContext, getContext } from "../lib/config";
import { info, isJsonMode, ok, printJson } from "../lib/output";

export const logoutCommand = new Command("logout")
  .description("Remove the stored Openship token")
  .option("--context <name>", "Log out of a specific context (defaults to active)")
  .action((opts) => {
    const name: string = opts.context || getActiveContext();
    const removed = !!getContext(name).token;
    if (removed) clearToken(name);
    if (isJsonMode()) printJson({ authenticated: false, context: name, removed });
    else if (removed) ok(`Logged out (context "${name}").`);
    else info(`Not logged in (context "${name}").`);
  });
