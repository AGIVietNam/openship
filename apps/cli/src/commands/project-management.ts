/** Project administration uses the same contracts and operations as deploy and the dashboard. */
import { Command, Option } from "commander";
import {
  UpdateProjectBody, UpdateResourcesBody, CreateProjectEnvironmentBody,
  ProjectControlSchemas, parseInput,
} from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const projectUpdateCommand = new Command("update")
  .description("Patch a project's build and runtime configuration")
  .argument("<id>", "Project ID")
  .argument("<file>", "JSON patch using the shared project update contract")
  .action((id: string, file: string) => printResult(() =>
    getShipClient().projects.update(id, parseInput(UpdateProjectBody, readJsonInput(file)))));

export const projectEnvironmentCommand = new Command("environment")
  .alias("environments")
  .description("Manage isolated project environments (each has its own project ID)");
projectEnvironmentCommand.command("list").alias("ls")
  .description("List this project's environments and their project IDs")
  .argument("<id>", "Project ID")
  .action((id: string) => printResult(() => getShipClient().projects.listEnvironments(id)));
projectEnvironmentCommand.command("create")
  .description("Create an isolated environment; deploy and link the returned project ID")
  .argument("<id>", "Source project ID")
  .argument("<name>", "Environment name")
  .option("--slug <slug>", "Environment slug")
  .option("--type <type>", "production | preview | development", "preview")
  .option("--branch <branch>", "Git branch for the environment")
  .addOption(new Option("--source-mode <mode>", "How this environment tracks source").choices(["branch", "manual"]))
  .action((id: string, name: string, opts) => printResult(() => getShipClient().projects.createEnvironment(id,
    parseInput(CreateProjectEnvironmentBody, {
      environmentName: name, environmentSlug: opts.slug, environmentType: opts.type,
      gitBranch: opts.branch, sourceMode: opts.sourceMode,
    }))));

export const projectResourcesCommand = new Command("resources")
  .description("Inspect and configure project CPU, memory, disk and build limits");
projectResourcesCommand.command("get").argument("<id>", "Project ID")
  .description("Show limits and available capacity from the engine")
  .action((id: string) => printResult(() => getShipClient().projects.getResources(id)));
projectResourcesCommand.command("set").argument("<id>", "Project ID")
  .argument("<file>", "JSON patch with production/build resource selections, sleepMode or port")
  .description("Change resource limits; the engine enforces destination capacity and Cloud policy")
  .action((id: string, file: string) => printResult(() =>
    getShipClient().projects.updateResources(id, parseInput(UpdateResourcesBody, readJsonInput(file)))));

export const projectStorageCommand = new Command("storage")
  .description("Inspect storage and bind an app's object storage connection");
projectStorageCommand.command("get").argument("<id>", "Project ID")
  .description("Show the storage binding, volumes and available providers")
  .action((id: string) => printResult(() => getShipClient().projects.getStorage(id)));
projectStorageCommand.command("bind").argument("<id>", "Project ID")
  .argument("<file>", "JSON storage binding: bucket and sourceProjectId, or external provider credentials")
  .description("Save an object storage binding; redeploy to apply its variables")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.bindStorage(id,
    parseInput(ProjectControlSchemas.bindStorage.input, readJsonInput(file)))));
projectStorageCommand.command("unbind").argument("<id>", "Project ID")
  .description("Remove the object's storage binding from this project")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove the storage binding from ${id}?`);
    return getShipClient().projects.unbindStorage(id);
  }));

export const projectConnectionsCommand = new Command("connections")
  .description("Wire app outputs into a project's environment through the engine");
for (const [name, method, description] of [
  ["list", "listConnections", "List this project's incoming app connections"],
  ["candidates", "listConnectionCandidates", "List apps that can supply connection outputs"],
  ["consumers", "listConnectionConsumers", "List projects consuming this project's outputs"],
] as const) {
  projectConnectionsCommand.command(name).argument("<id>", "Project ID").description(description)
    .action((id: string) => printResult(() => getShipClient().projects[method](id)));
}
projectConnectionsCommand.command("create").argument("<id>", "Target project ID")
  .argument("<file>", "JSON connection with sourceProjectId, outputId, envKey and optional mode")
  .description("Connect one app output; redeploy to apply it")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.createConnection(id,
    parseInput(ProjectControlSchemas.createConnection.input, readJsonInput(file)))));
projectConnectionsCommand.command("bundle").argument("<id>", "Target project ID")
  .argument("<file>", "JSON connection bundle with sourceProjectId and items")
  .description("Connect several app outputs atomically; redeploy to apply them")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.connectBundle(id,
    parseInput(ProjectControlSchemas.connectBundle.input, readJsonInput(file)))));
projectConnectionsCommand.command("remove").alias("rm")
  .argument("<id>", "Target project ID").argument("<connection>", "Connection ID")
  .description("Remove an app connection")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, connection: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove connection ${connection} from ${id}?`);
    return getShipClient().projects.removeConnection(id, connection);
  }));

export const projectInspectionCommands = ([
  ["pending", "getPendingActions", "Show pending deployment, routing and certificate actions"],
  ["incidents", "getIncidents", "Show this project's monitoring incidents"],
  ["drift", "getCommitStatus", "Compare source and deployment configuration"],
  ["rollback-capacity", "getRollbackCapacity", "Inspect retained rollback capacity"],
] as const).map(([name, method, description]) => new Command(name).argument("<id>", "Project ID")
  .description(description).action((id: string) => printResult(() => getShipClient().projects[method](id))));
