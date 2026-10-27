import assert from "node:assert/strict";
import {
  CLOSE_CALL_DETAIL_FIELDS,
  CLOSE_CALL_HYDRATION_FIELDS,
  CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
  CloseConnector,
  closeCallNeedsDetail,
  formatCloseApiErrorResponse,
  mergeCloseCallDetail,
} from "./connector";
import {
  ACTIVITY_SCHEMA_MAP,
  buildCloseSearchFieldSelection,
  closeActivitySearchFields,
  splitCloseSearchFieldSelection,
} from "./schema";
import { MAKO_SYSTEM_FIELDS } from "../base/BaseConnector";

function createConnector() {
  return new CloseConnector({
    id: "ds_close",
    name: "Close",
    type: "close",
    config: { api_key: "test-key" },
  } as any);
}

function testCloseApiErrorResponseIsFormattedForLogs() {
  const error = Object.assign(
    new Error("Request failed with status code 400"),
    {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: "Invalid field selection",
          "field-errors": { _fields: ["Unsupported field"] },
        },
      },
    },
  );

  assert.equal(
    formatCloseApiErrorResponse(error),
    '{"error":"Invalid field selection","field-errors":{"_fields":["Unsupported field"]}}',
  );
}

function testUserWebhookEventsAreSupported() {
  const connector = createConnector();

  // Close has no user.* webhook selectors — membership carries user CDC.
  assert.deepEqual(connector.getWebhookEventsForEntities(["users"]), [
    "membership.activated",
    "membership.deactivated",
  ]);
}

function testUserWebhookEventsAreMapped() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventMapping("membership.activated"), {
    entity: "users",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("membership.deactivated"), {
    entity: "users",
    operation: "delete",
  });
  // Legacy user.* mappings retained for defensive processing.
  assert.deepEqual(connector.getWebhookEventMapping("user.created"), {
    entity: "users",
    operation: "upsert",
  });
}

function testUserWebhookPayloadIsExtractedForProcessing() {
  const connector = createConnector();

  assert.deepEqual(
    connector.extractWebhookData({
      event: {
        object_type: "membership",
        action: "activated",
        object_id: "memb_123",
        data: {
          id: "memb_123",
          user_id: "user_123",
          user: {
            id: "user_123",
            email: "user@example.com",
            first_name: "Test",
            date_updated: "2026-05-20T07:00:00.000Z",
          },
        },
      },
    }),
    {
      id: "user_123",
      data: {
        id: "user_123",
        email: "user@example.com",
        first_name: "Test",
        date_updated: "2026-05-20T07:00:00.000Z",
      },
    },
  );
}

function testUserWebhookCdcRecordUsesUsersEntity() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      id: "evt_123",
      event: {
        object_type: "membership",
        action: "deactivated",
        object_id: "memb_123",
        data: {
          id: "memb_123",
          user_id: "user_123",
          user: { id: "user_123" },
        },
      },
    },
    "membership.deactivated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "users");
  assert.equal(records[0].recordId, "user_123");
  assert.equal(records[0].operation, "delete");
  assert.deepEqual(records[0].payload, { id: "user_123" });
}

// Regression: Close nests its unique event id at `event.event.id`. The CDC
// record's changeId must resolve to it so distinct updates get distinct
// idempotency keys (instead of collapsing onto `lead.updated:<recordId>`).
function testWebhookChangeIdUsesNestedEventId() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_nested_123",
        object_type: "lead",
        action: "updated",
        object_id: "lead_abc",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_abc",
          display_name: "Acme",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].changeId, "ev_nested_123");
}

// When no vendor event id is present, the fallback changeId must include the
// source timestamp so two distinct updates of the same record never share a
// changeId (and therefore never collapse to one idempotency key).
function testWebhookChangeIdFallbackIncludesSourceTs() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        object_type: "lead",
        action: "updated",
        object_id: "lead_xyz",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_xyz",
          display_name: "Beta",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.ok(
    records[0].changeId.endsWith(":2026-06-21T17:19:39.000Z"),
    `changeId should include sourceTs, got ${records[0].changeId}`,
  );
  assert.ok(records[0].changeId.includes("lead_xyz"));
}

function testGroupsEntityIsAvailable() {
  const connector = createConnector();

  assert.ok(
    connector.getAvailableEntities().includes("groups"),
    "groups should be an available entity",
  );
  assert.ok(
    connector.getEntityMetadata().some(meta => meta.name === "groups"),
    "groups should be present in entity metadata",
  );
}

function testCallWebhookEventsIncludeUpdated() {
  const connector = createConnector();

  // Regression: `activity.call updated` was missing from the subscription
  // list, so manually-logged calls (source "External") kept duration 0 forever
  // and recordings never attached — while created/answered/completed flowed.
  assert.deepEqual(connector.getWebhookEventsForEntities(["activities:Call"]), [
    "activity.call.created",
    "activity.call.updated",
    "activity.call.deleted",
    "activity.call.answered",
    "activity.call.completed",
  ]);
  assert.deepEqual(connector.getWebhookEventMapping("activity.call.updated"), {
    entity: "activities:Call",
    operation: "upsert",
  });
}

function testTaskCompletedWebhookEventsIncludeUpdated() {
  const connector = createConnector();

  assert.deepEqual(
    connector.getWebhookEventsForEntities(["activities:TaskCompleted"]),
    [
      "activity.task_completed.created",
      "activity.task_completed.updated",
      "activity.task_completed.deleted",
    ],
  );
}

function testGroupWebhookEventsAreScopedToGroups() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventsForEntities(["groups"]), [
    "group.created",
    "group.updated",
    "group.deleted",
  ]);
}

function testGroupWebhookEventsAreMapped() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventMapping("group.created"), {
    entity: "groups",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("group.updated"), {
    entity: "groups",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("group.deleted"), {
    entity: "groups",
    operation: "delete",
  });
}

async function testGroupSchemaResolves() {
  const connector = createConnector();

  const schema = await connector.resolveSchema("groups");
  assert.ok(schema, "groups schema should resolve");
  if (!schema) return;
  assert.equal(schema.entity, "groups");
  assert.ok(schema.fields.members, "groups schema should expose members");
  assert.ok(
    schema.fields.organization_id,
    "groups schema should expose organization_id",
  );
}

// Regression: opportunity custom fields must be flattened into `custom_cf_*`
// columns on the backfill path. Previously only leads and custom_objects were
// flattened, so opportunity custom fields stayed buried in the nested `custom`
// JSON blob and never materialized as destination columns.
function testOpportunityBackfillFlattensCustomFields() {
  const connector = createConnector();

  const normalized = connector.normalizeBackfillRecord("opportunities", {
    id: "oppo_123",
    lead_id: "lead_abc",
    status_label: "Active",
    date_updated: "2026-06-21T17:19:39.000Z",
    // Nested blob (Search API `custom` field)
    custom: { cf_renewal: "2027-01-01", cf_amount: 42 },
    // Flat dotted key (explicit `_fields=custom.cf_<id>` selector)
    "custom.cf_owner": "user_1",
  });

  assert.ok(normalized);
  if (!normalized) return;
  const payload = normalized.payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_renewal, "2027-01-01");
  assert.equal(payload.custom_cf_amount, 42);
  assert.equal(payload.custom_cf_owner, "user_1");
  assert.ok(
    !("custom.cf_owner" in payload),
    "dotted key should be renamed, not duplicated",
  );
  assert.deepEqual(
    payload.custom,
    { cf_renewal: "2027-01-01", cf_amount: 42 },
    "nested custom blob should be preserved as JSON fallback",
  );
}

// Same regression for the webhook path: opportunity.updated payloads carry a
// nested `custom` object which must land in `custom_cf_*` columns.
function testOpportunityWebhookFlattensCustomFields() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_oppo_1",
        object_type: "opportunity",
        action: "updated",
        object_id: "oppo_123",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "oppo_123",
          status_label: "Active",
          date_updated: "2026-06-21T17:19:39.000Z",
          custom: { cf_renewal: "2027-01-01" },
        },
      },
    },
    "opportunity.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "opportunities");
  const payload = records[0].payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_renewal, "2027-01-01");
}

// Contacts share the same custom-field mechanics as opportunities.
function testContactBackfillFlattensCustomFields() {
  const connector = createConnector();

  const normalized = connector.normalizeBackfillRecord("contacts", {
    id: "cont_123",
    lead_id: "lead_abc",
    date_updated: "2026-06-21T17:19:39.000Z",
    custom: { cf_linkedin: "https://linkedin.com/in/x" },
  });

  assert.ok(normalized);
  if (!normalized) return;
  const payload = normalized.payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_linkedin, "https://linkedin.com/in/x");
}

// Legacy lead-only fields use lcf_ IDs, which the schema and API selectors
// already support. Both ingestion paths must preserve them as flat columns.
function testLeadBackfillPreservesLegacyCustomFields() {
  const connector = createConnector();
  const records: Record<string, unknown>[] = [
    { "custom.lcf_owner": "user_legacy" },
    { custom_lcf_owner: "user_legacy" },
    { custom: { lcf_owner: "user_legacy" } },
    { custom_lcf_owner: null, custom: { lcf_owner: "user_old" } },
  ];

  for (const [index, record] of records.entries()) {
    const normalized = connector.normalizeBackfillRecord("leads", {
      id: "lead_legacy",
      date_updated: "2026-10-05T10:00:00.000Z",
      "custom.cf_current": "user_current",
      ...record,
    });
    assert.ok(normalized);
    const payload = normalized.payload as Record<string, unknown>;
    assert.equal(payload.custom_lcf_owner, index === 3 ? null : "user_legacy");
    assert.equal(payload.custom_cf_current, "user_current");
    assert.ok(!("custom.lcf_owner" in payload));
  }
}

function testLeadWebhookPreservesLegacyCustomFields() {
  const connector = createConnector();
  for (const customFields of [
    { "custom.lcf_owner": "user_legacy" },
    { custom: { lcf_owner: "user_legacy" } },
  ]) {
    const records = connector.extractWebhookCdcRecords(
      {
        event: {
          id: "ev_legacy",
          object_type: "lead",
          action: "updated",
          object_id: "lead_legacy",
          date_updated: "2026-10-05T10:00:00.000Z",
          data: { id: "lead_legacy", ...customFields },
        },
      },
      "lead.updated",
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].entity, "leads");
    const payload = records[0].payload as Record<string, unknown>;
    assert.equal(payload.custom_lcf_owner, "user_legacy");
    assert.ok(!("custom.lcf_owner" in payload));
  }
}

// The Search API field selection must enumerate every custom field as an
// explicit `custom.cf_<id>` selector (plus keep the `custom` blob fallback),
// so no field is silently missing from backfill payloads.
function testSearchFieldSelectionIncludesCustomFieldSelectors() {
  const selection = buildCloseSearchFieldSelection(
    ["id", "lead_id", "custom"],
    [
      {
        id: "cf_renewal",
        name: "Renewal Date",
        type: "date",
        appliesTo: "opportunity",
      },
      {
        id: "cf_amount",
        name: "Amount",
        type: "number",
        appliesTo: "opportunity",
      },
      { id: "", name: "bogus", type: "text", appliesTo: "opportunity" },
    ],
  );

  assert.deepEqual(selection, [
    "id",
    "lead_id",
    "custom",
    "custom.cf_renewal",
    "custom.cf_amount",
  ]);
}

function makeCustomFields(count: number, appliesTo = "lead") {
  return Array.from({ length: count }, (_, i) => ({
    id: `cf_${String(i).padStart(3, "0")}`,
    name: `Field ${i}`,
    type: "text",
    appliesTo,
  }));
}

// Close rejects a `_fields` list past an undocumented ceiling (~100+). The
// selection must be split so no single request names more than the budget
// of custom selectors, with the remainder shaped as by-id follow-ups that
// each start with the `id` merge key.
function testSplitFieldSelectionRespectsBudget() {
  const plan = splitCloseSearchFieldSelection(
    ["id", "name", "date_created"],
    makeCustomFields(130),
    60,
  );

  assert.equal(plan.primary.length, 3 + 60);
  assert.deepEqual(plan.primary.slice(0, 3), ["id", "name", "date_created"]);
  assert.equal(plan.primary[3], "custom.cf_000");
  assert.equal(plan.primary[62], "custom.cf_059");

  assert.equal(plan.supplemental.length, 2);
  assert.equal(plan.supplemental[0][0], "id");
  assert.equal(plan.supplemental[0].length, 61);
  assert.equal(plan.supplemental[0][1], "custom.cf_060");
  assert.equal(plan.supplemental[1][0], "id");
  assert.equal(plan.supplemental[1].length, 11);
  assert.equal(plan.supplemental[1][10], "custom.cf_129");

  // Everything fits: no follow-ups, and `id` is always requested.
  const small = splitCloseSearchFieldSelection(
    ["name"],
    makeCustomFields(5),
    60,
  );
  assert.deepEqual(small.supplemental, []);
  assert.equal(small.primary[0], "id");
  assert.equal(small.primary.length, 2 + 5);

  // Duplicate ids (a shared field listed twice) are requested once.
  const dup = splitCloseSearchFieldSelection(
    ["id"],
    [...makeCustomFields(2), ...makeCustomFields(2)],
    60,
  );
  assert.deepEqual(dup.primary, ["id", "custom.cf_000", "custom.cf_001"]);
}

/**
 * Stub Close client for the lead backfill: serves one page of `pageRows`,
 * rejects any search request whose `_fields.lead` is longer than
 * `maxFields` with the 400 Close returns for an oversized selection, and
 * answers by-id follow-ups with the requested selectors for each id.
 */
function stubLeadSearchApi(params: {
  customFieldCount: number;
  maxFields: number;
  pageRows: Array<Record<string, unknown>>;
}) {
  const searchBodies: any[] = [];
  let servedPage = false;
  const post = async (_url: string, body: any) => {
    if (body?.include_counts) {
      return { data: { count: { total: params.pageRows.length }, data: [] } };
    }
    const idQuery = body?.query?.queries?.find((q: any) => q?.type === "or");
    if (!idQuery && body?._limit === 1 && Array.isArray(body?.sort)) {
      // Oldest-record probe used to seed the date window
      return {
        data: {
          data: [
            {
              id: params.pageRows[0].id,
              date_created: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    }
    if (!idQuery && body?._limit === 1) {
      // Gap probe after the window is exhausted — no more data
      return { data: { data: [] } };
    }
    searchBodies.push(body);
    const fields: string[] = body?._fields?.lead ?? [];
    if (fields.length > params.maxFields) {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: {
          status: 400,
          headers: {},
          data: { "field-errors": { _fields: ["Too many fields requested"] } },
        },
      });
    }

    if (idQuery) {
      // By-id follow-up: return only the requested selectors for each id.
      const ids: string[] = idQuery.queries.map((q: any) => q.value);
      return {
        data: {
          data: params.pageRows
            .filter(row => ids.includes(String(row.id)))
            .map(row => {
              const out: Record<string, unknown> = { id: row.id };
              for (const field of fields) {
                if (field !== "id" && field in row) out[field] = row[field];
              }
              return out;
            }),
          cursor: null,
        },
      };
    }

    if (!servedPage) {
      servedPage = true;
      return {
        data: {
          data: params.pageRows.map(row => {
            const out: Record<string, unknown> = {};
            for (const field of fields) {
              if (field in row) out[field] = row[field];
            }
            return out;
          }),
          cursor: null,
        },
      };
    }
    return { data: { data: [], cursor: null } };
  };

  const api = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/lead/") {
        return { data: { fields: makeCustomFields(params.customFieldCount) } };
      }
      return { data: { data: [] } };
    },
    post,
  };
  return { api, searchBodies };
}

function makeLeadRow(id: string, customFieldCount: number) {
  const row: Record<string, unknown> = {
    id,
    name: `Lead ${id}`,
    date_created: "2026-01-02T00:00:00.000Z",
    date_updated: "2026-01-03T00:00:00.000Z",
  };
  for (const field of makeCustomFields(customFieldCount)) {
    row[`custom.${field.id}`] = `${id}:${field.id}`;
  }
  return row;
}

// Regression for the July 2026 outage: an org with 130 lead custom fields
// must sync every one of them as a flat `custom_cf_*` key, without any
// request exceeding the per-request selector budget.
async function testLeadBackfillSplitsCustomFieldsAcrossRequests() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 130), makeLeadRow("lead_b", 130)];
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 130,
    maxFields: 100,
    pageRows: rows,
  });
  (connector as any).closeApi = api;

  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onProgress: () => {},
    rateLimitDelay: 1,
  } as any);

  assert.equal(state.hasMore, false);
  const pageRequests = searchBodies.filter(
    b => !b.query?.queries?.some((q: any) => q?.type === "or"),
  );
  const byIdRequests = searchBodies.filter(b =>
    b.query?.queries?.some((q: any) => q?.type === "or"),
  );
  // One paged request serves the rows; the loop then advances the window and
  // issues one more paged request that comes back empty.
  assert.ok(pageRequests.length >= 1, "a paged request for the window");
  assert.equal(byIdRequests.length, 2, "two by-id follow-ups for the rest");
  for (const body of searchBodies) {
    const custom = (body._fields.lead as string[]).filter(f =>
      f.startsWith("custom."),
    );
    assert.ok(
      custom.length <= CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
      `request named ${custom.length} custom selectors`,
    );
    assert.ok(
      !(body._fields.lead as string[]).includes("custom"),
      "deprecated custom blob must not be requested",
    );
  }
  // Follow-ups target exactly the ids of the page.
  for (const body of byIdRequests) {
    const or = body.query.queries.find((q: any) => q.type === "or");
    assert.deepEqual(
      or.queries.map((q: any) => q.value),
      ["lead_a", "lead_b"],
    );
    assert.equal(body._limit, 2);
  }

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  for (const record of batches[0]) {
    const id = record.id as string;
    assert.equal(record.name, `Lead ${id}`);
    for (const field of makeCustomFields(130)) {
      assert.equal(
        record[`custom_${field.id}`],
        `${id}:${field.id}`,
        `${id} is missing custom_${field.id}`,
      );
    }
    assert.ok(!Object.keys(record).some(k => k.startsWith("custom.")));
  }
}

// If Close's ceiling is lower than the configured budget, the connector must
// shrink the batch and retry the same page instead of failing the sync.
async function testLeadBackfillShrinksBatchWhenCloseRejectsSelection() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 70)];
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 70,
    maxFields: 40,
    pageRows: rows,
  });
  (connector as any).closeApi = api;
  const warnings: string[] = [];

  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onLog: (level: string, message: string) => {
      if (level === "warn") warnings.push(message);
    },
    rateLimitDelay: 1,
  } as any);

  const sizes = searchBodies.map(b => (b._fields.lead as string[]).length);
  assert.ok(sizes[0] > 40, "first attempt used the default budget");
  const rejected = sizes.filter(n => n > 40);
  assert.equal(
    rejected.length,
    2,
    `60 -> 30 -> 15: two attempts over the ceiling, got ${sizes.join(",")}`,
  );
  const lastRejected = sizes.lastIndexOf(rejected[rejected.length - 1]);
  assert.ok(
    sizes.slice(lastRejected + 1).every(n => n <= 40),
    `after the last 400 every request fits the ceiling, got ${sizes.join(",")}`,
  );
  assert.ok(
    searchBodies.some(b =>
      b.query?.queries?.some((q: any) => q?.type === "or"),
    ),
    "the remaining fields are fetched by id",
  );
  assert.ok(
    warnings.some(m => m.includes("fewer custom selectors")),
    "the shrink is logged to the sync log",
  );
  assert.equal((connector as any).customSelectorBatchSize, 15);

  assert.equal(batches.length, 1);
  const record = batches[0][0];
  for (const field of makeCustomFields(70)) {
    assert.equal(record[`custom_${field.id}`], `lead_a:${field.id}`);
  }
}

// Schema change mid-run: a custom field deleted in Close after the schema
// was cached leaves a dangling selector that Close rejects. The connector
// must re-read the schema, drop the selector, and carry on — not shrink the
// batch, and not fail the sync.
async function testLeadBackfillReplansWhenCustomFieldDeletedMidRun() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 3)];
  let schemaReads = 0;
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 3,
    maxFields: 1000,
    pageRows: rows,
  });
  const basePost = api.post;
  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/lead/") {
        schemaReads++;
        // First read: three fields. Later reads: cf_002 has been deleted.
        return {
          data: {
            fields: makeCustomFields(schemaReads === 1 ? 3 : 2),
          },
        };
      }
      return { data: { data: [] } };
    },
    post: async (url: string, body: any) => {
      const fields: string[] = body?._fields?.lead ?? [];
      if (fields.includes("custom.cf_002")) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          isAxiosError: true,
          response: {
            status: 400,
            headers: {},
            data: { "field-errors": { _fields: ["Unsupported field"] } },
          },
        });
      }
      return basePost(url, body);
    },
  };
  const warnings: string[] = [];

  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onLog: (level: string, message: string) => {
      if (level === "warn") warnings.push(message);
    },
    rateLimitDelay: 1,
  } as any);

  assert.equal(schemaReads, 2, "schema is re-read after the rejection");
  assert.ok(
    warnings.some(m => m.includes("schema changed during the run")),
    "the re-plan is logged to the sync log",
  );
  assert.equal(
    (connector as any).customSelectorBatchSize,
    CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
    "a schema change must not shrink the batch",
  );
  assert.ok(
    searchBodies.slice(1).every(b => !b._fields.lead.includes("custom.cf_002")),
    "the deleted field is no longer requested",
  );
  assert.equal(batches.length, 1);
  const record = batches[0][0];
  assert.equal(record.custom_cf_000, "lead_a:cf_000");
  assert.equal(record.custom_cf_001, "lead_a:cf_001");
  assert.ok(!("custom_cf_002" in record));
}

// A 400 that is not about the selection (and a selection-less entity) must
// still surface: shrinking is only for requests that carried selectors.
async function testUnrelatedSearch400StillThrows() {
  const connector = createConnector();
  (connector as any).closeApi = {
    get: async () => ({ data: { fields: [] } }),
    post: async () => {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400, headers: {}, data: { error: "Bad query" } },
      });
    },
  };

  await assert.rejects(
    connector.fetchEntityChunk({
      entity: "leads",
      state: {
        totalProcessed: 0,
        hasMore: true,
        iterationsInChunk: 0,
        metadata: {
          windowStart: "2026-01-01T00:00:00.000Z",
          windowEnd: "2026-01-08T00:00:00.000Z",
        },
      },
      onBatch: async () => {},
      maxIterations: 1,
      rateLimitDelay: 1,
    } as any),
    /status code 400/,
  );
}

// End-to-end contract for the opportunity backfill path with a stubbed Close
// client: the Search API request must enumerate `custom.cf_<id>` selectors,
// and records handed to onBatch must arrive with flattened `custom_cf_*` keys.
async function testOpportunitySearchBackfillRequestsAndFlattensCustomFields() {
  const connector = createConnector();

  const searchBodies: any[] = [];
  let servedPage = false;

  const opportunityRow = {
    id: "oppo_1",
    lead_id: "lead_1",
    status_label: "Active",
    date_created: "2026-01-01T00:00:01.000Z",
    date_updated: "2026-01-02T00:00:00.000Z",
    "custom.cf_renewal": "2027-01-01",
    custom: { cf_renewal: "2027-01-01", cf_amount: 42 },
  };

  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/opportunity/") {
        return {
          data: {
            fields: [
              { id: "cf_renewal", name: "Renewal Date", type: "date" },
              { id: "cf_amount", name: "Amount", type: "number" },
            ],
          },
        };
      }
      return { data: {} };
    },
    post: async (_url: string, body: any) => {
      if (body?.include_counts) {
        return { data: { count: { total: 1 }, data: [] } };
      }
      if (body?._limit === 1 && Array.isArray(body?.sort)) {
        // Oldest-record probe used to seed the date window
        return {
          data: {
            data: [{ id: "oppo_1", date_created: "2026-01-01T00:00:00.000Z" }],
          },
        };
      }
      if (body?._limit === 1) {
        // Gap probe after the window is exhausted — no more data
        return { data: { data: [] } };
      }
      searchBodies.push(body);
      if (!servedPage) {
        servedPage = true;
        return { data: { data: [opportunityRow], cursor: null } };
      }
      return { data: { data: [], cursor: null } };
    },
  };

  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "opportunities",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onProgress: () => {},
    rateLimitDelay: 1,
  } as any);

  assert.equal(state.hasMore, false);
  assert.ok(searchBodies.length >= 1, "should issue a paged search request");
  const requestedFields: string[] = searchBodies[0]?._fields?.opportunity ?? [];
  assert.ok(
    requestedFields.includes("custom.cf_renewal"),
    `_fields should include custom.cf_renewal, got: ${requestedFields.join(",")}`,
  );
  assert.ok(
    !requestedFields.includes("custom"),
    "_fields must not lean on the deprecated custom blob",
  );

  assert.equal(batches.length, 1);
  const record = batches[0][0];
  assert.equal(record.custom_cf_renewal, "2027-01-01");
  assert.equal(record.custom_cf_amount, 42);
  assert.ok(
    !("custom.cf_renewal" in record),
    "dotted key should be renamed in emitted records",
  );
}

async function testExpiredCursorRetriesWithNormalizedWindowStart() {
  const connector = createConnector();
  const searchBodies: Record<string, unknown>[] = [];
  let requestCount = 0;

  (connector as any).closeApi = {
    get: async () => ({ data: { fields: [] } }),
    post: async (_url: string, body: Record<string, unknown>) => {
      searchBodies.push(body);
      requestCount++;

      if (requestCount === 1) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          isAxiosError: true,
          response: {
            status: 400,
            headers: {},
            data: { "field-errors": { cursor: ["Invalid cursor"] } },
          },
        });
      }

      return {
        data: {
          data: [
            {
              id: "lead_1",
              name: "Lead 1",
              date_created: "2025-03-18T15:49:15.000000+00:00",
              date_updated: "2025-03-18T15:49:15.000000+00:00",
            },
          ],
          cursor: null,
        },
      };
    },
  };

  const state = await connector.fetchEntityChunk({
    entity: "leads",
    state: {
      totalProcessed: 40_117,
      hasMore: true,
      iterationsInChunk: 0,
      metadata: {
        pageCursor: "expired-close-cursor",
        lastSeenDateCreated: "2025-03-18T15:49:14.689000+00:00",
        windowStart: "2025-03-18T08:13:38.996Z",
        windowEnd: "2025-03-25T08:13:38.996Z",
      },
    },
    onBatch: async () => {},
    maxIterations: 1,
    rateLimitDelay: 1,
  });

  assert.equal(searchBodies.length, 2);
  assert.equal(searchBodies[0].cursor, "expired-close-cursor");
  assert.ok(!("cursor" in searchBodies[1]));
  const retriedQuery = searchBodies[1].query as {
    queries: Array<{
      condition?: { on_or_after?: { value?: string } };
    }>;
  };
  assert.equal(
    retriedQuery.queries[1].condition?.on_or_after?.value,
    "2025-03-18T15:49:14.689Z",
  );
  assert.equal(state.metadata?.pageCursor, null);
}

async function testCreateWebhookSubscriptionReturnsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";

  (connector as any).closeApi = {
    get: async () => ({ data: { data: [] } }),
    post: async (_url: string, body: Record<string, unknown>) => {
      assert.equal(body.url, endpointUrl);
      return {
        data: {
          id: "whsub_new",
          url: endpointUrl,
          signature_key: "aabbccddeeff00112233445566778899",
        },
      };
    },
  };

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["leads"],
  });

  assert.equal(result.providerWebhookId, "whsub_new");
  assert.equal(result.signingSecret, "aabbccddeeff00112233445566778899");
}

async function testExistingWebhookSubscriptionReturnsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";
  let putCalled = false;

  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/webhook/") {
        return {
          data: {
            data: [
              {
                id: "whsub_existing",
                url: endpointUrl,
                signature_key: "00112233445566778899aabbccddeeff",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async (url: string) => {
      putCalled = true;
      assert.equal(url, "/webhook/whsub_existing/");
      return { data: {} };
    },
  };

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["leads"],
  });

  assert.equal(putCalled, true);
  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "00112233445566778899aabbccddeeff");
}

async function testExistingWebhookFetchesDetailWhenListOmitsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";

  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/webhook/") {
        return {
          data: {
            data: [{ id: "whsub_existing", url: endpointUrl }],
          },
        };
      }
      if (url === "/webhook/whsub_existing/") {
        return {
          data: {
            id: "whsub_existing",
            url: endpointUrl,
            signature_key: "fedcba9876543210fedcba9876543210",
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async () => ({ data: {} }),
  };

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["contacts"],
  });

  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "fedcba9876543210fedcba9876543210");
}

// ---------------------------------------------------------------------------
// Activity Search API field selection
// ---------------------------------------------------------------------------

const ACTIVITY_CUSTOM_FIELDS = [
  { id: "cf_OnbStep9x", name: "Onboarding step", type: "text" },
  { id: "cf_VisScore7q", name: "Visibility score", type: "number" },
];

/**
 * Stub the Close client for one Search API activity run. Serves a single page
 * of `pageRows`, then reports the range as exhausted. Every paged request
 * body (not the probes) is recorded in `searchBodies`.
 */
function stubActivitySearchApi(params: {
  objectType: string;
  pageRows: Record<string, unknown>[];
  customFields?: () => typeof ACTIVITY_CUSTOM_FIELDS;
  rejectSelector?: string;
}) {
  const searchBodies: any[] = [];
  const getUrls: string[] = [];
  let servedPage = false;
  const api = {
    get: async (url: string) => {
      getUrls.push(url);
      if (url === "/custom_field/activity/") {
        return {
          data: {
            data: (params.customFields ?? (() => ACTIVITY_CUSTOM_FIELDS))(),
          },
        };
      }
      return { data: { data: [] } };
    },
    post: async (_url: string, body: any) => {
      if (body?.include_counts) {
        return { data: { count: { total: params.pageRows.length }, data: [] } };
      }
      if (body?._limit === 1 && Array.isArray(body?.sort)) {
        return {
          data: {
            data: [{ id: "probe", date_created: "2026-01-01T00:00:00.000Z" }],
          },
        };
      }
      if (body?._limit === 1) return { data: { data: [] } };
      const fields: string[] = body?._fields?.[params.objectType] ?? [];
      if (params.rejectSelector && fields.includes(params.rejectSelector)) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          isAxiosError: true,
          response: {
            status: 400,
            headers: {},
            data: { "field-errors": { _fields: ["Unsupported field"] } },
          },
        });
      }
      searchBodies.push(body);
      if (!servedPage) {
        servedPage = true;
        return { data: { data: params.pageRows, cursor: null } };
      }
      return { data: { data: [], cursor: null } };
    },
  };
  return { api, searchBodies, getUrls };
}

async function runActivityChunk(
  connector: CloseConnector,
  entity: string,
  since?: Date,
) {
  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity,
    since,
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    rateLimitDelay: 1,
  } as any);
  return batches;
}

const customActivityRow = {
  id: "acti_1",
  _type: "CustomActivity",
  lead_id: "lead_1",
  custom_activity_type_id: "actitype_5iJqCnAa7233npoHsoYDtH",
  status: "published",
  date_created: "2026-01-01T00:00:01.000Z",
  date_updated: "2026-01-02T00:00:00.000Z",
  "custom.cf_OnbStep9x": "kickoff",
  "custom.cf_VisScore7q": 7,
};

// The 2026-10-20 backfill loaded ~98% of custom activities with a NULL
// custom_activity_type_id and empty custom_cf_* columns: the Search API
// request named neither. Both must be requested and land as columns.
async function testCustomActivitySearchRequestsTypeAndCustomFields() {
  const connector = createConnector();
  const { api, searchBodies } = stubActivitySearchApi({
    objectType: "activity.custom_activity",
    pageRows: [customActivityRow],
  });
  (connector as any).closeApi = api;

  const batches = await runActivityChunk(
    connector,
    "activities:CustomActivity",
  );

  const requested: string[] =
    searchBodies[0]?._fields?.["activity.custom_activity"] ?? [];
  for (const field of [
    "custom_activity_type_id",
    "custom.cf_OnbStep9x",
    "custom.cf_VisScore7q",
  ]) {
    assert.ok(
      requested.includes(field),
      `_fields should include ${field}, got: ${requested.join(",")}`,
    );
  }

  assert.equal(batches.length, 1);
  const record = batches[0][0];
  assert.equal(
    record.custom_activity_type_id,
    "actitype_5iJqCnAa7233npoHsoYDtH",
  );
  assert.equal(record.custom_cf_OnbStep9x, "kickoff");
  assert.equal(record.custom_cf_VisScore7q, 7);
  assert.ok(
    !("custom.cf_OnbStep9x" in record),
    "dotted key should be renamed in emitted records",
  );
}

// Backfill and the webhook path must produce the same columns for the same
// custom activity, so a re-backfill overwrites webhook rows like-for-like.
function testCustomActivityBackfillAndWebhookShapesMatch() {
  const connector = createConnector();
  const backfill = connector.normalizeBackfillRecord(
    "activities:CustomActivity",
    { ...customActivityRow },
  );
  const [webhook] = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_acti_1",
        object_type: "activity.custom_activity",
        action: "updated",
        object_id: "acti_1",
        date_updated: "2026-01-02T00:00:00.000Z",
        data: { ...customActivityRow },
      },
    },
    "activity.custom_activity.updated",
  );

  assert.ok(backfill);
  assert.equal(webhook.entity, "activities:CustomActivity");
  const backfillPayload = backfill!.payload as Record<string, unknown>;
  const webhookPayload = webhook.payload as Record<string, unknown>;
  for (const key of [
    "custom_activity_type_id",
    "custom_cf_OnbStep9x",
    "custom_cf_VisScore7q",
  ]) {
    assert.deepEqual(backfillPayload[key], webhookPayload[key], key);
    assert.ok(backfillPayload[key] !== undefined, `${key} present`);
  }
}

// Anti-drift: for every activity subtype, the Search API request names every
// non-system column of the resolved schema (custom fields included), and the
// incremental poll requests exactly what the full backfill requests.
async function testActivitySearchRequestsEverySchemaColumn() {
  const systemFields = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of Object.keys(ACTIVITY_SCHEMA_MAP)) {
    const objectType = (createConnector() as any).getSearchObjectType(entity);

    const full = createConnector();
    const fullStub = stubActivitySearchApi({ objectType, pageRows: [] });
    (full as any).closeApi = fullStub.api;
    await runActivityChunk(full, entity);

    const incremental = createConnector();
    const incStub = stubActivitySearchApi({ objectType, pageRows: [] });
    (incremental as any).closeApi = incStub.api;
    await runActivityChunk(
      incremental,
      entity,
      new Date("2026-10-01T00:00:00.000Z"),
    );

    const fullFields: string[] =
      fullStub.searchBodies[0]?._fields?.[objectType] ?? [];
    const incFields: string[] =
      incStub.searchBodies[0]?._fields?.[objectType] ?? [];
    assert.ok(fullFields.length > 0, `${entity}: backfill requests fields`);
    assert.deepEqual(
      [...incFields].sort(),
      [...fullFields].sort(),
      `${entity}: incremental and backfill request the same fields`,
    );

    // Same connector (and stubbed custom fields) the backfill ran with.
    const schema = await full.resolveSchema(entity);
    const expected = Object.keys(schema!.fields)
      .filter(column => !systemFields.has(column))
      .map(column =>
        column.startsWith("custom_cf_")
          ? column.replace(/^custom_/, "custom.")
          : column,
      );
    if (entity === "activities:CustomActivity") {
      assert.ok(expected.includes("custom.cf_OnbStep9x"));
    }
    const missing = [...expected].filter(c => !fullFields.includes(c));
    assert.deepEqual(missing, [], `${entity}: schema columns not requested`);
    assert.deepEqual(
      fullFields.filter(f => !f.startsWith("custom.")),
      closeActivitySearchFields(entity),
      `${entity}: base fields come from closeActivitySearchFields`,
    );
  }
}

// A custom activity field deleted in Close mid-run makes the Search API
// reject its selector; the connector re-reads /custom_field/activity/ and
// re-plans instead of failing the sync.
async function testCustomActivityReplansWhenCustomFieldDeleted() {
  const connector = createConnector();
  let reads = 0;
  const { api, searchBodies, getUrls } = stubActivitySearchApi({
    objectType: "activity.custom_activity",
    pageRows: [customActivityRow],
    rejectSelector: "custom.cf_VisScore7q",
    customFields: () => {
      reads++;
      return reads === 1
        ? ACTIVITY_CUSTOM_FIELDS
        : ACTIVITY_CUSTOM_FIELDS.slice(0, 1);
    },
  });
  (connector as any).closeApi = api;

  const batches = await runActivityChunk(
    connector,
    "activities:CustomActivity",
  );

  assert.equal(
    getUrls.filter(u => u === "/custom_field/activity/").length,
    2,
    "activity custom fields are re-read after the rejection",
  );
  assert.ok(
    !getUrls.some(u => u.startsWith("/custom_field_schema/activity")),
    "custom activities never hit the lead/contact/opportunity schema endpoint",
  );
  assert.equal(batches.length, 1);
  assert.ok(
    searchBodies.every(
      b =>
        !b._fields["activity.custom_activity"].includes("custom.cf_VisScore7q"),
    ),
  );
  assert.equal(
    batches[0][0].custom_activity_type_id,
    "actitype_5iJqCnAa7233npoHsoYDtH",
  );
}

// ── Calls: transcripts, recordings, webhook re-reads ────────────────

const TRANSCRIPT = {
  utterances: [
    { speaker_side: "local", start: 0.4, end: 2.1, text: "Hello" },
    { speaker_side: "remote", start: 2.5, end: 3.0, text: "Hi" },
  ],
  summary_text: "Short greeting.",
};

function axios400(body: unknown) {
  return Object.assign(new Error("Request failed with status code 400"), {
    isAxiosError: true,
    response: { status: 400, headers: {}, data: body },
  });
}

/**
 * A Search API that serves one page of calls (no transcripts, like the real
 * one) and a REST `/activity/call/` list that serves the details.
 */
function stubCallApi(options: {
  rows: Record<string, unknown>[];
  details?: Record<string, unknown>[];
  restError?: unknown;
}) {
  const restCalls: Array<{ url: string; params: Record<string, unknown> }> = [];
  let pageServed = false;
  const api = {
    post: async (_url: string, body: any) => {
      const fields = body?._fields?.["activity.call"] as string[] | undefined;
      if (fields && fields.length === 2 && fields[1] === "date_created") {
        return { data: { data: [options.rows[0]] } };
      }
      if (fields?.includes("direction") && !pageServed) {
        pageServed = true;
        return { data: { data: options.rows, cursor: null } };
      }
      return { data: { data: [], cursor: null } };
    },
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      restCalls.push({ url, params: config?.params ?? {} });
      if (options.restError) throw options.restError;
      return { data: { data: options.details ?? [], has_more: false } };
    },
  };
  return { api, restCalls };
}

function callRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    _type: "Call",
    status: "completed",
    duration: 95,
    recording_url: `https://example.test/rec/${id}.mp3`,
    date_created: "2026-10-20T09:00:00.000000+00:00",
    date_updated: "2026-10-20T09:03:00.000000+00:00",
    ...extra,
  };
}

async function fetchCallBatches(connector: CloseConnector) {
  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity: "activities:Call",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    rateLimitDelay: 1,
  } as any);
  return batches;
}

async function testCallSearchPageIsHydratedWithTranscripts() {
  const connector = createConnector();
  const { api, restCalls } = stubCallApi({
    rows: [callRow("acti_a"), callRow("acti_b")],
    details: [
      {
        id: "acti_a",
        recording_duration: 94,
        has_recording: true,
        recording_transcript: TRANSCRIPT,
        voicemail_transcript: null,
      },
      { id: "acti_b", recording_transcript: null },
    ],
  });
  (connector as any).closeApi = api;

  const batches = await fetchCallBatches(connector);

  const hydration = restCalls.filter(c => c.url === "/activity/call/");
  assert.equal(hydration.length, 1, "one REST read for the page");
  assert.equal(hydration[0].params.id__in, "acti_a,acti_b");
  assert.equal(
    hydration[0].params._fields,
    CLOSE_CALL_HYDRATION_FIELDS.join(","),
  );
  for (const field of ["recording_transcript", "voicemail_transcript"]) {
    assert.ok(
      String(hydration[0].params._fields).split(",").includes(field),
      `${field} requested`,
    );
  }

  assert.equal(batches.length, 1);
  const [a, b] = batches[0];
  assert.deepEqual(a.recording_transcript, TRANSCRIPT);
  assert.equal(a.recording_duration, 94);
  assert.equal(a.has_recording, true);
  assert.equal(a.recording_url, "https://example.test/rec/acti_a.mp3");
  assert.equal(b.id, "acti_b");
  assert.equal(b.recording_transcript, null);
}

async function testCallHydrationSplitsLargePages() {
  const connector = createConnector();
  const rows = Array.from({ length: 150 }, (_, i) =>
    callRow(`acti_${String(i).padStart(3, "0")}`),
  );
  const { api, restCalls } = stubCallApi({ rows, details: [] });
  (connector as any).closeApi = api;

  await fetchCallBatches(connector);

  const sizes = restCalls
    .filter(c => c.url === "/activity/call/")
    .map(c => String(c.params.id__in).split(",").length);
  assert.deepEqual(sizes, [100, 50]);
}

// Close refusing the selection must not fail call syncs, and must not emit
// empty transcript keys that would blank what the destination already has.
async function testCallHydrationRefusedSelectionLeavesRowsUntouched() {
  const connector = createConnector();
  const { api } = stubCallApi({
    rows: [callRow("acti_a")],
    restError: axios400({ "field-errors": { _fields: ["Unknown field"] } }),
  });
  (connector as any).closeApi = api;

  const batches = await fetchCallBatches(connector);

  assert.equal(batches.length, 1);
  assert.ok(!("recording_transcript" in batches[0][0]));
  assert.ok(!("voicemail_transcript" in batches[0][0]));
}

async function testCallHydrationServerErrorFailsThePage() {
  const connector = createConnector();
  const { api } = stubCallApi({
    rows: [callRow("acti_a")],
    restError: Object.assign(new Error("Request failed with status code 502"), {
      isAxiosError: true,
      response: { status: 502, headers: {}, data: "Bad gateway" },
    }),
  });
  (connector as any).closeApi = api;

  const emitted: unknown[] = [];
  await assert.rejects(
    connector.fetchEntityChunk({
      entity: "activities:Call",
      onBatch: async (batch: unknown[]) => {
        emitted.push(...batch);
      },
      rateLimitDelay: 1,
    } as any),
  );
  assert.equal(emitted.length, 0, "no transcript-less rows were emitted");
}

async function testOnlyCallPagesAreHydrated() {
  const connector = createConnector();
  const restCalls: string[] = [];
  let served = false;
  (connector as any).closeApi = {
    post: async (_url: string, body: any) => {
      const fields = body?._fields?.["activity.email"] as string[] | undefined;
      if (fields && fields.length === 2) {
        return {
          data: {
            data: [{ id: "acti_e", date_created: "2026-10-20T09:00:00Z" }],
          },
        };
      }
      if (fields?.includes("subject") && !served) {
        served = true;
        return {
          data: {
            data: [{ id: "acti_e", date_created: "2026-10-20T09:00:00Z" }],
            cursor: null,
          },
        };
      }
      return { data: { data: [], cursor: null } };
    },
    get: async (url: string) => {
      restCalls.push(url);
      return { data: { data: [] } };
    },
  };

  await connector.fetchEntityChunk({
    entity: "activities:Email",
    onBatch: async () => {},
    rateLimitDelay: 1,
  } as any);
  assert.deepEqual(restCalls, []);
}

function testMergeCallDetailNeverBlanksTranscriptOrRecording() {
  const row: Record<string, unknown> = {
    id: "acti_a",
    status: "completed",
    recording_url: "https://example.test/rec.mp3",
    recording_transcript: TRANSCRIPT,
  };
  mergeCloseCallDetail(row, {
    id: "acti_a",
    status: "completed",
    recording_url: null,
    recording_transcript: {},
    voicemail_transcript: null,
    recording_duration: 40,
  });
  assert.equal(row.recording_url, "https://example.test/rec.mp3");
  assert.deepEqual(row.recording_transcript, TRANSCRIPT);
  assert.equal(row.voicemail_transcript, null, "new keys still land");
  assert.equal(row.recording_duration, 40);

  // A filled value replaces an empty one, and a newer filled one wins.
  const empty: Record<string, unknown> = { recording_transcript: null };
  mergeCloseCallDetail(empty, { recording_transcript: TRANSCRIPT });
  assert.deepEqual(empty.recording_transcript, TRANSCRIPT);
  // Non-preserved fields follow the fresh read even when empty.
  const noted: Record<string, unknown> = { note: "old" };
  mergeCloseCallDetail(noted, { note: "" });
  assert.equal(noted.note, "");
}

function testCloseCallNeedsDetail() {
  assert.equal(
    closeCallNeedsDetail({ status: "in-progress", duration: 0 }),
    false,
  );
  assert.equal(closeCallNeedsDetail({ status: "created" }), false);
  assert.equal(
    closeCallNeedsDetail({ status: "completed", duration: 95 }),
    true,
  );
  assert.equal(
    closeCallNeedsDetail({
      status: "no-answer",
      voicemail_url: "https://x.test/v",
    }),
    true,
  );
  assert.equal(
    closeCallNeedsDetail({ status: "completed", has_recording: true }),
    true,
  );
  // Already carries its transcript: nothing to re-read.
  assert.equal(
    closeCallNeedsDetail({
      status: "completed",
      duration: 95,
      recording_transcript: TRANSCRIPT,
    }),
    false,
  );
  // Ended without being connected: no recording to wait for.
  assert.equal(
    closeCallNeedsDetail({ status: "no-answer", duration: 0 }),
    false,
  );
}

function callWebhookEvent(
  action: string,
  data: Record<string, unknown>,
  dateUpdated = "2026-10-20T09:01:00.000000+00:00",
) {
  return {
    subscription_id: "whsub_test",
    event: {
      id: `ev_${action}`,
      object_type: "activity.call",
      action,
      object_id: "acti_call",
      date_updated: dateUpdated,
      data: { id: "acti_call", _type: "Call", ...data },
    },
  };
}

async function testCallWebhookReReadsEndedCall() {
  const connector = createConnector();
  const gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  (connector as any).closeApi = {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      gets.push({ url, params: config?.params ?? {} });
      return {
        data: {
          id: "acti_call",
          status: "completed",
          duration: 95,
          date_updated: "2026-10-20T09:05:00.000000+00:00",
          recording_url: "https://example.test/rec/acti_call.mp3",
          recording_duration: 94,
          has_recording: true,
          recording_transcript: TRANSCRIPT,
          voicemail_transcript: null,
        },
      };
    },
  };

  const extracted = connector.extractWebhookCdcRecords(
    callWebhookEvent("completed", {
      status: "completed",
      duration: 95,
      recording_url: null,
      lead_id: "lead_1",
    }),
    "activity.call.completed",
  );
  const records = await connector.enrichWebhookCdcRecords(extracted, {
    isEntityEnabled: () => true,
  });

  assert.equal(gets.length, 1);
  assert.equal(gets[0].url, "/activity/call/acti_call/");
  assert.equal(gets[0].params._fields, CLOSE_CALL_DETAIL_FIELDS.join(","));
  assert.equal(records.length, 1);
  const payload = records[0].payload as Record<string, unknown>;
  assert.deepEqual(payload.recording_transcript, TRANSCRIPT);
  assert.equal(payload.recording_url, "https://example.test/rec/acti_call.mp3");
  assert.equal(payload.lead_id, "lead_1", "event fields are kept");
  assert.equal(
    records[0].sourceTs?.toISOString(),
    "2026-10-20T09:05:00.000Z",
    "source time moves to the re-read",
  );
  assert.equal(records[0].changeId, "ev_completed");
}

async function testCallWebhookSkipsLiveCallsAndDisabledEntity() {
  const connector = createConnector();
  let gets = 0;
  (connector as any).closeApi = {
    get: async () => {
      gets++;
      return { data: {} };
    },
  };

  const created = connector.extractWebhookCdcRecords(
    callWebhookEvent("created", { status: "in-progress", duration: 0 }),
    "activity.call.created",
  );
  const kept = await connector.enrichWebhookCdcRecords(created, {
    isEntityEnabled: () => true,
  });
  assert.equal(gets, 0, "a call still ringing is not re-read");
  assert.deepEqual(kept, created);

  const ended = connector.extractWebhookCdcRecords(
    callWebhookEvent("updated", { status: "completed", duration: 95 }),
    "activity.call.updated",
  );
  await connector.enrichWebhookCdcRecords(ended, {
    isEntityEnabled: entity => entity !== "activities:Call",
  });
  assert.equal(gets, 0, "a flow that does not sync calls costs no reads");

  const deleted = connector.extractWebhookCdcRecords(
    callWebhookEvent("deleted", { status: "completed", duration: 95 }),
    "activity.call.deleted",
  );
  await connector.enrichWebhookCdcRecords(deleted, {
    isEntityEnabled: () => true,
  });
  assert.equal(gets, 0, "deletes are not re-read");
}

async function testCallWebhookReadFailureKeepsEventRecord() {
  const connector = createConnector();
  (connector as any).closeApi = {
    get: async () => {
      throw Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        response: { status: 404, headers: {}, data: {} },
      });
    },
  };

  const extracted = connector.extractWebhookCdcRecords(
    callWebhookEvent("updated", { status: "completed", duration: 95 }),
    "activity.call.updated",
  );
  const records = await connector.enrichWebhookCdcRecords(extracted, {
    isEntityEnabled: () => true,
  });
  assert.deepEqual(records, extracted);
}

function testCallAndEmailWebhookEventsForEveryOrg() {
  const connector = createConnector();
  const events = connector.getWebhookEventsForEntities([
    "activities:Call",
    "activities:Email",
    "activities:EmailThread",
  ]);
  for (const event of [
    "activity.call.created",
    "activity.call.updated",
    "activity.call.completed",
    "activity.call.answered",
    "activity.call.deleted",
    "activity.email.created",
    "activity.email.updated",
    "activity.email.sent",
    "activity.email_thread.created",
    "activity.email_thread.updated",
  ]) {
    assert.ok(events.includes(event), `${event} is subscribed`);
  }
}

async function testUpdateWebhookSubscriptionRetargetsEvents() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";
  const puts: Array<{ url: string; body: any }> = [];
  const listParams: unknown[] = [];

  (connector as any).closeApi = {
    get: async (url: string, config?: { params?: unknown }) => {
      assert.equal(url, "/webhook/");
      listParams.push(config?.params);
      // Two pages: the flow's subscription is on the second one.
      if (listParams.length === 1) {
        return {
          data: {
            data: [{ id: "whsub_other", url: "https://elsewhere.test/hook" }],
            has_more: true,
          },
        };
      }
      return {
        data: {
          data: [
            {
              id: "whsub_flow",
              url: endpointUrl,
              status: "paused",
              // Created before call updates were subscribed.
              events: [{ object_type: "activity.call", action: "created" }],
            },
          ],
          has_more: false,
        },
      };
    },
    put: async (url: string, body: any) => {
      puts.push({ url, body });
      return { data: {} };
    },
  };

  assert.equal(connector.supportsWebhookSubscriptionUpdate(), true);
  const result = await connector.updateWebhookSubscription({
    endpointUrl,
    enabledEntities: ["activities:Call", "activities:Email"],
  });

  assert.equal(result?.providerWebhookId, "whsub_flow");
  assert.equal(
    result?.signingSecret,
    undefined,
    "the key is kept, not rotated",
  );
  assert.equal(listParams.length, 2, "the subscription list is paged");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, "/webhook/whsub_flow/");
  assert.equal(puts[0].body.status, "active", "a paused subscription resumes");
  const keys = (puts[0].body.events as any[]).map(
    e => `${e.object_type}.${e.action}`,
  );
  for (const event of [
    "activity.call.created",
    "activity.call.updated",
    "activity.call.completed",
    "activity.email.created",
    "activity.email.sent",
  ]) {
    assert.ok(keys.includes(event), `${event} is set on the subscription`);
  }
  assert.ok(!keys.some(k => k.startsWith("lead.")), "only enabled entities");
}

async function testUpdateWebhookSubscriptionReturnsNullWithoutMatch() {
  const connector = createConnector();
  let putCalled = false;
  (connector as any).closeApi = {
    get: async () => ({
      data: { data: [{ id: "whsub_other", url: "https://elsewhere.test" }] },
    }),
    put: async () => {
      putCalled = true;
      return { data: {} };
    },
  };

  const result = await connector.updateWebhookSubscription({
    endpointUrl: "https://app.mako.ai/api/webhooks/ws/flow",
    enabledEntities: ["activities:Call"],
  });
  assert.equal(result, null);
  assert.equal(putCalled, false);
}

async function main() {
  testCloseApiErrorResponseIsFormattedForLogs();
  testUserWebhookEventsAreSupported();
  testUserWebhookEventsAreMapped();
  testUserWebhookPayloadIsExtractedForProcessing();
  testUserWebhookCdcRecordUsesUsersEntity();
  testWebhookChangeIdUsesNestedEventId();
  testWebhookChangeIdFallbackIncludesSourceTs();
  testGroupsEntityIsAvailable();
  testCallWebhookEventsIncludeUpdated();
  testTaskCompletedWebhookEventsIncludeUpdated();
  testGroupWebhookEventsAreScopedToGroups();
  testGroupWebhookEventsAreMapped();
  await testGroupSchemaResolves();
  testOpportunityBackfillFlattensCustomFields();
  testOpportunityWebhookFlattensCustomFields();
  testContactBackfillFlattensCustomFields();
  testLeadBackfillPreservesLegacyCustomFields();
  testLeadWebhookPreservesLegacyCustomFields();
  testSearchFieldSelectionIncludesCustomFieldSelectors();
  await testOpportunitySearchBackfillRequestsAndFlattensCustomFields();
  testSplitFieldSelectionRespectsBudget();
  await testLeadBackfillSplitsCustomFieldsAcrossRequests();
  await testLeadBackfillShrinksBatchWhenCloseRejectsSelection();
  await testLeadBackfillReplansWhenCustomFieldDeletedMidRun();
  await testUnrelatedSearch400StillThrows();
  await testExpiredCursorRetriesWithNormalizedWindowStart();
  await testCreateWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookFetchesDetailWhenListOmitsSignatureKey();
  await testCustomActivitySearchRequestsTypeAndCustomFields();
  testCustomActivityBackfillAndWebhookShapesMatch();
  await testActivitySearchRequestsEverySchemaColumn();
  await testCustomActivityReplansWhenCustomFieldDeleted();
  await testCallSearchPageIsHydratedWithTranscripts();
  await testCallHydrationSplitsLargePages();
  await testCallHydrationRefusedSelectionLeavesRowsUntouched();
  await testCallHydrationServerErrorFailsThePage();
  await testOnlyCallPagesAreHydrated();
  testMergeCallDetailNeverBlanksTranscriptOrRecording();
  testCloseCallNeedsDetail();
  await testCallWebhookReReadsEndedCall();
  await testCallWebhookSkipsLiveCallsAndDisabledEntity();
  await testCallWebhookReadFailureKeepsEventRecord();
  testCallAndEmailWebhookEventsForEveryOrg();
  await testUpdateWebhookSubscriptionRetargetsEvents();
  await testUpdateWebhookSubscriptionReturnsNullWithoutMatch();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
