import { Command } from "commander";
import { AddDnsCredentialBody, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const dnsCommand = new Command("dns").description("Manage DNS providers and zone access");
dnsCommand.command("providers").description("List DNS providers, scopes and token setup links")
  .action(() => printResult(() => getShipClient().dns.listProviders()));
dnsCommand.command("verify-zone").argument("<hostname>", "Hostname to resolve against your DNS credentials")
  .description("Check DNS zone access")
  .action((hostname: string) => printResult(async () => {
    const result = await getShipClient().dns.verifyZone({ hostname });
    if (!result.matched) process.exitCode = 1;
    return result;
  }));
const credentials = new Command("credentials").description("Manage DNS automation credentials");
credentials.command("list").description("List masked DNS credentials")
  .action(() => printResult(() => getShipClient().dns.listCredentials()));
credentials.command("get").argument("<id>", "Credential ID").description("Show a masked DNS credential")
  .action((id: string) => printResult(() => getShipClient().dns.getCredential(id)));
credentials.command("add").argument("<file>", "JSON object containing provider, name and apiToken")
  .description("Store DNS credentials for automatic records and certificates")
  .action((file: string) => printResult(() => getShipClient().dns.addCredential(parseInput(AddDnsCredentialBody, readJsonInput(file)))));
credentials.command("remove").alias("rm").argument("<id>", "Credential ID")
  .description("Remove DNS automation credentials").option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove DNS credential ${id}?`);
    return getShipClient().dns.removeCredential(id);
  }));
dnsCommand.addCommand(credentials);
