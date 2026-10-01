import { describe, expect, it, vi } from "vitest";
import { CloudRuntime } from "./cloud";
import type { BuildConfig } from "../types";

const resources = { cpuCores: 0.5, memoryMb: 768, diskMb: 8192 };
const config = (overrides: Partial<BuildConfig> = {}): BuildConfig =>
  ({
    projectId: "project",
    sessionId: "session",
    deploymentId: "deployment",
    slug: "example",
    repoUrl: "https://github.com/example/project",
    branch: "main",
    commitSha: "0123456789abcdef",
    stack: "docker",
    envVars: {},
    resources,
    ...overrides,
  }) as BuildConfig;

function fixture() {
  const order: string[] = [];
  const workspaces = new Map<string, ReturnType<typeof add>>();
  const remove = vi.fn(async (id: string) => {
    workspaces.delete(id);
    return { success: true };
  });
  function add(id: string, allocation = { cpus: 0.5, memory_mb: 768, disk_size_mb: 8192 }) {
    const stream = vi.fn(async function* (cmd: string[]) {
      const command = cmd.join(" ");
      const output = command.includes("cat 'Dockerfile'")
        ? 'FROM alpine:3.20\nRUN echo built\nCMD ["echo", "ready"]\n'
        : command.includes("git --version")
          ? "git version 2.45.0\n"
          : "";
      if (output) yield { event: "stdout", data: Buffer.from(output).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    const workspace = {
      id,
      allocation,
      get: vi.fn(async () => {
        if (!workspaces.has(id))
          throw Object.assign(new Error("Workspace removed"), { status: 404 });
        return { id, namespace: "customer", resources: { ...allocation } };
      }),
      resources: {
        update: vi.fn(async (next: { cpus: number; memory_mb: number; disk_size_mb?: number }) => {
          order.push(`resize:${id}`);
          Object.assign(allocation, next);
          return { success: true, relaunched: true };
        }),
      },
      runtime: vi.fn(async () => {
        order.push(`runtime:${id}`);
        return { exec: { stream } };
      }),
      lifecycle: { makeTemporary: vi.fn(async () => ({})) },
      delete: vi.fn(async () => {
        order.push(`delete:${id}`);
        return remove(id);
      }),
      stream,
    };
    workspaces.set(id, workspace);
    return workspace;
  }
  const create = vi.fn(async () => {
    if (workspaces.size)
      throw Object.assign(new Error("No room for a second workspace"), {
        code: "NAMESPACE_LIMIT_REACHED",
      });
    const id = `workspace-${create.mock.calls.length}`;
    order.push(`create:${id}`);
    add(id);
    return { id };
  });
  const runtime = new CloudRuntime(
    { workspaces: { create }, workspace: (id: string) => workspaces.get(id) } as never,
    { namespace: "customer" },
  );
  return { runtime, create, add, order, remove, workspaces };
}

describe("native Cloud build reservations", () => {
  it("releases the source probe before creating the actual Dockerfile builder", async () => {
    const f = fixture();
    const result = await f.runtime.build(config());
    expect(result).toMatchObject({ status: "deploying", imageRef: "workspace-2" });
    expect(f.order.indexOf("delete:workspace-1")).toBeLessThan(
      f.order.indexOf("create:workspace-2"),
    );
    expect(f.workspaces.size).toBe(1);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("does not start another builder when the source probe cannot be released", async () => {
    const f = fixture();
    f.remove.mockRejectedValue(new Error("Provider cleanup failed"));
    expect(await f.runtime.build(config())).toMatchObject({
      status: "failed",
      errorMessage: "Provider cleanup failed",
    });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.workspaces.size).toBe(1);
  });

  it("waits for accepted source deletion to be confirmed by the provider", async () => {
    const f = fixture();
    f.remove.mockImplementationOnce(async (id: string) => {
      const workspace = f.workspaces.get(id)!;
      workspace.get.mockImplementationOnce(async () => {
        f.workspaces.delete(id);
        throw Object.assign(new Error("Workspace removed"), { status: 404 });
      });
      return { success: true, accepted: true };
    });
    expect(await f.runtime.build(config())).toMatchObject({
      status: "deploying",
      imageRef: "workspace-2",
    });
    expect(f.workspaces.size).toBe(1);
  });

  it("sizes the uploaded workspace before building, preserving its identity and larger disk", async () => {
    const f = fixture();
    const upload = f.add("uploaded", { cpus: 0.25, memory_mb: 256, disk_size_mb: 16384 });
    const result = await f.runtime.build(
      config({
        stack: "node",
        cloudWorkspaceId: "uploaded",
        sourceStaged: true,
        buildCommand: "echo built",
        installCommand: "",
        rootDirectory: "",
        hasServer: true,
      }),
    );
    expect(result).toMatchObject({ imageRef: "uploaded" });
    expect(result.status).not.toBe("failed");
    expect(f.create).not.toHaveBeenCalled();
    expect(upload.resources.update).toHaveBeenCalledExactlyOnceWith({
      cpus: 0.5,
      memory_mb: 768,
      disk_size_mb: 16384,
      apply: true,
    });
    expect(f.order.indexOf("resize:uploaded")).toBeLessThan(f.order.indexOf("runtime:uploaded"));
    expect(upload.delete).not.toHaveBeenCalled();
  });

  it("retains a structured provider refusal and the uploaded source for retry", async () => {
    const f = fixture();
    const upload = f.add("uploaded", { cpus: 0.25, memory_mb: 256, disk_size_mb: 8192 });
    const refused = Object.assign(new Error("Namespace full"), { code: "NAMESPACE_LIMIT_REACHED" });
    upload.resources.update.mockRejectedValue(refused);
    expect(
      await f.runtime.build(
        config({ stack: "node", cloudWorkspaceId: "uploaded", sourceStaged: true }),
      ),
    ).toMatchObject({ status: "failed", errorCause: refused });
    expect(upload.runtime).not.toHaveBeenCalled();
    expect(upload.delete).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
