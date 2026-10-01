import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";
import { BuildLogger } from "./build-pipeline";
import type { BuildConfig } from "../types";

const config = {
  projectId: "project",
  sessionId: "build",
  resources: { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 },
} as BuildConfig;
function fixture(transport = "cloud", buildKit = true) {
  const executor = {
    exec: vi.fn(async (command: string) =>
      command.includes("buildx version") && buildKit ? "OPENSHIP_BUILDKIT_OK\n" : "",
    ),
    streamExec: vi.fn(async (_command: string, _logger: unknown, _options: unknown) => ({
      code: 0,
      output: "",
    })),
  };
  const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    transport: { kind: transport },
    connectionOptions: { transport, executor },
  });
  return {
    executor,
    run: (signal?: AbortSignal) =>
      runtime.buildImageOnRemote(
        config,
        "/tmp/build dir",
        "Dockerfile",
        "openship/test:build",
        new BuildLogger(),
        { signal },
      ),
  };
}

describe("Cloud Docker build execution limits", () => {
  it("runs BuildKit inside the selected CPU/RAM budget and loads its image into the project's Docker host", async () => {
    const h = fixture();
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).toContain("--driver docker-container");
    expect(command).toContain("--driver-opt 'memory=536870912'");
    expect(command).toContain("--driver-opt 'memory-swap=536870912'");
    expect(command).toContain("--driver-opt 'cpu-quota=25000'");
    expect(command).toContain("--driver-opt 'cpu-period=100000'");
    expect(command).toContain("--load --progress=plain");
    expect(command).toContain("cd '/tmp/build dir'");
    expect(command).not.toContain("--use");
    expect(command).toContain("trap ");
    expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force --keep-state");
  });
  it.each([1, 137])(
    "removes only the project's builder after a failed build (exit %s)",
    async (code) => {
      const h = fixture();
      h.executor.streamExec.mockResolvedValue({ code, output: "" });
      await expect(h.run()).rejects.toThrow(`docker build exited with code ${code}`);
      expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force --keep-state");
      expect(h.executor.exec.mock.calls.at(-1)![0]).not.toContain("prune");
    },
  );
  it("cleans up the builder after cancellation even if the remote stream resolves normally", async () => {
    const h = fixture();
    const controller = new AbortController();
    h.executor.streamExec.mockImplementation(async () => {
      controller.abort();
      return { code: 0, output: "" };
    });
    await expect(h.run(controller.signal)).rejects.toMatchObject({ name: "BuildCancelledError" });
    expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force --keep-state");
  });
  it("applies the same budget to the legacy Cloud Docker builder", async () => {
    const h = fixture("cloud", false);
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).toContain("--memory 536870912 --memory-swap 536870912");
    expect(command).toContain("--cpu-quota 25000 --cpu-period 100000");
    expect(command).not.toContain("buildx create");
  });
  it.each([true, false])(
    "keeps the self-hosted SSH build path unchanged (BuildKit: %s)",
    async (buildKit) => {
      const h = fixture("ssh", buildKit);
      await h.run();
      const command = h.executor.streamExec.mock.calls[0]![0];
      expect(command).not.toContain("--memory");
      expect(command).not.toContain("--cpu-quota");
      expect(command).not.toContain("buildx create");
    },
  );
});
