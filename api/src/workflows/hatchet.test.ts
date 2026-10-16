import assert from "node:assert/strict";

import { parseWorkspaceApiKeyScopes } from "../auth/api-key-scopes";
import {
  HatchetError,
  deleteWorkflowDefinition,
  isHatchetId,
  tenantFromToken,
} from "./hatchet";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

// A run id from a request goes into a Hatchet path, so it must be a UUID.
assert.equal(isHatchetId(RUN), true);
assert.equal(isHatchetId("../x"), false);
assert.equal(isHatchetId(`${RUN}/logs`), false);

// A person cannot mint the worker's scope: it carries model access.
assert.throws(
  () => parseWorkspaceApiKeyScopes(["mcp", "workflows:runtime"]),
  /reserved/,
);

// A Hatchet token is the whole connection: tenant and API address come from it.
const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const token = jwt({ sub: TENANT, server_url: "https://hatchet.example/" });
delete process.env.HATCHET_API_URL;
assert.deepEqual(tenantFromToken(token), {
  tenantId: TENANT,
  token,
  apiUrl: "https://hatchet.example",
});
// HATCHET_API_URL wins over the address in the token.
process.env.HATCHET_API_URL = "http://10.0.0.1:8080";
assert.equal(tenantFromToken(token).apiUrl, "http://10.0.0.1:8080");
delete process.env.HATCHET_API_URL;
for (const bad of [
  "",
  "not-a-token",
  jwt({ server_url: "https://x" }),
  jwt({ sub: TENANT }),
]) {
  assert.throws(() => tenantFromToken(bad), HatchetError, `must refuse ${bad}`);
}

// Deleting a workflow deletes only the one of exactly that name, and a
// workflow Hatchet already forgot (404) is not an error.
async function deleteTests() {
  const DIGEST = "33333333-3333-3333-3333-333333333333";
  const OTHER = "44444444-4444-4444-4444-444444444444";
  const tenant = { tenantId: TENANT, token: "t", apiUrl: "https://h" };
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith(`https://h/api/v1/tenants/${TENANT}/workflows?`)) {
      return Response.json({
        rows: [
          { name: "digest", metadata: { id: DIGEST } },
          { name: "digest-weekly", metadata: { id: OTHER } },
        ],
      });
    }
    return new Response(null, { status: url.endsWith(DIGEST) ? 204 : 404 });
  }) as typeof fetch;
  try {
    assert.equal(await deleteWorkflowDefinition(tenant, "digest"), true);
    assert.deepEqual(calls.slice(1), [
      `DELETE https://h/api/v1/workflows/${DIGEST}`,
    ]);
    assert.equal(await deleteWorkflowDefinition(tenant, "gone"), false);
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    await assert.rejects(
      deleteWorkflowDefinition(tenant, "digest"),
      HatchetError,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

deleteTests()
  .then(() => console.log("workflows hatchet tests passed"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
