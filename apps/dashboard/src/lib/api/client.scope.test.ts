// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, setActiveOrganizationId, setApiResourceScope } from "./client";
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); setApiResourceScope("account-a"); setActiveOrganizationId("org-a"); });
afterEach(() => { setApiResourceScope(""); setActiveOrganizationId(null); vi.unstubAllGlobals(); });
const response = (name: string) => Response.json({ name });

it("deduplicates the same authenticated read without sharing it across Cloud accounts", async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { finish = done; })).mockResolvedValueOnce(response("New account"));
  const first = api.get("system/servers"), duplicate = api.get("system/servers");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  setApiResourceScope("account-b");
  expect(await api.get("system/servers")).toEqual({ name: "New account" });
  finish(response("Old account"));
  expect(await first).toEqual({ name: "Old account" });
  expect(await duplicate).toEqual({ name: "Old account" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not collapse requests carrying different organization scopes", async () => {
  fetchMock.mockImplementation(async (_url, init) => response(new Headers(init.headers).get("X-Organization-Id")!));
  const [a, b] = await Promise.all([api.get("projects/home"), api.get("projects/home", { headers: { "X-Organization-Id": "org-b" } })]);
  expect(a).toEqual({ name: "org-a" }); expect(b).toEqual({ name: "org-b" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
