import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { OpenshipClient, ApiError } from "@repo/sdk/client";
import { addContext, DEFAULT_CONTEXT, getContext, setActiveContext, withCommandContext } from "../lib/config";
import { fetchCaps } from "../lib/caps";
import { err, info, isJsonMode, ok, printJson } from "../lib/output";
import { exitCommand } from "../lib/command-exit";

export const loginCommand = new Command("login")
  .description("Authenticate with a Personal Access Token (create one in dashboard Settings)")
  .option("--token <token>", "Personal Access Token (opsh_pat_...) for non-interactive login")
  .option("--api-url <url>", "API base URL (defaults to the saved context or local installation)")
  .option("--dashboard-url <url>", "Dashboard base URL (defaults to the saved context or local installation)")
  .option("--context <name>", "Name of the context to store this login under", DEFAULT_CONTEXT)
  .action(async (opts) => {
    const contextName: string = opts.context || DEFAULT_CONTEXT;
    // Re-authenticate at the same endpoints unless the operator overrides them.
    const existing = getContext(contextName);
    const apiUrl: string = opts.apiUrl || existing.apiUrl || LOCAL_API_URL;
    const dashboardUrl: string = opts.dashboardUrl || existing.dashboardUrl || LOCAL_DASHBOARD_URL;

    let token: string | undefined = opts.token;

    // Interactive: open the PAT settings page and read a pasted token.
    if (!token) {
      if (isJsonMode() || !input.isTTY) {
        err("Pass --token <token> for non-interactive login.");
        exitCommand(1);
      }
      const settingsUrl = `${dashboardUrl}/settings`;
      info(
        chalk.bold("\n  Openship login\n") +
          chalk.dim("  Create a Personal Access Token in Settings → Personal Access Tokens,\n") +
          chalk.dim("  then paste it here.\n"),
      );
      try {
        const { default: open } = await import("open");
        await open(settingsUrl);
      } catch {
        // Browser open is best-effort; the URL is printed below regardless.
      }
      info(
        chalk.dim("  If the browser didn't open, visit:\n") + chalk.cyan(`  ${settingsUrl}\n`),
      );

      const rl = createInterface({ input, output });
      token = await rl.question("  Paste your token: ");
      rl.close();
    }

    token = token?.trim();
    if (!token) {
      err("No token provided.");
      exitCommand(1);
    }
    if (!token.startsWith("opsh_pat_")) {
      err(
        chalk.red("\n  That doesn't look like an Openship token (expected opsh_pat_…).\n"),
      );
      exitCommand(1);
    }

    // Validate the token against an authenticated endpoint before storing.
    // 200 → valid; 403 → valid but lacks settings:read scope (still usable).
    let scoped = false;
    try {
      const client = new OpenshipClient({ baseUrl: apiUrl, token, timeoutMs: 8000 });
      await client.tokens.list();
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        scoped = true;
      } else {
        err(error instanceof ApiError && error.status === 401
          ? "Token rejected by the API. Check that it is valid and not revoked."
          : `Could not validate the token at ${apiUrl}. Check the API URL and connectivity.`);
        exitCommand(1);
      }
    }

    addContext(contextName, { apiUrl, dashboardUrl, token });
    setActiveContext(contextName);

    // Best-effort capability discovery so later commands can gate offline.
    await withCommandContext(() => fetchCaps({ force: true, context: contextName })).catch(() => undefined);

    if (isJsonMode()) {
      printJson({ authenticated: true, context: contextName, apiUrl, dashboardUrl, scoped });
      return;
    }
    ok(`Logged in (context "${contextName}").`);
    if (scoped) {
      info(
        chalk.dim("  (Token lacks settings:read scope — some commands may be limited.)\n"),
      );
    }
  });
