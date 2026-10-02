// Test-only GitHub + Cloud-billing boundary for the real native worker. Keep
// platform operations, encryption, authorization and persistence unchanged,
// without contacting either GitHub or the live Cloud billing catalog — a real
// network round-trip there is flaky in CI (transient 5xx / connectivity) and
// unrelated to what these tests exercise.
const networkFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  if (url.origin === "https://api.openship.io" && url.pathname === "/api/billing/plans") {
    return Response.json({
      data: {
        locale: url.searchParams.get("locale") ?? "en",
        annual: { enabled: true, monthsFree: 2 },
        ui: {},
        plans: [],
      },
    });
  }

  if (url.origin !== "https://api.github.com") return networkFetch(input, init);
  if (request.method !== "GET" || url.pathname !== "/user") {
    throw new Error(`Unexpected GitHub fixture request: ${request.method} ${url.pathname}`);
  }
  if (request.headers.get("authorization") !== "Bearer persistent-private-token") {
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  return Response.json(
    { login: "alice", id: 1, avatar_url: "" },
    { headers: { "x-oauth-scopes": "repo" } },
  );
};
