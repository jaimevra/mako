import assert from "node:assert/strict";
import {
  ClaapConnector,
  parseClaapTranscriptSegments,
  renderClaapTranscriptText,
} from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new ClaapConnector({
    id: "ds_claap",
    name: "Claap",
    type: "claap",
    config: {
      api_key: "cla_test_key",
      api_base_url: "https://api.claap.io",
      ...config,
    },
  } as any);
}

function testConfigValidationRequiresApiKey() {
  const connector = createConnector({ api_key: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("API key")));
}

function testRecordingWebhookEventsAreSupported() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventsForEntities(["recordings"]), [
    "recording_added",
    "recording_updated",
  ]);
}

function testRecordingWebhookEventsAreMapped() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("recording_added"), {
    entity: "recordings",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("recording_updated"), {
    entity: "recordings",
    operation: "upsert",
  });
}

function testWebhookVerificationAcceptsMatchingSecret() {
  const connector = createConnector();
  const payload = JSON.stringify({
    eventId: "evt_123",
    event: {
      type: "recording_added",
      recording: {
        id: "rec_1",
        title: "Demo",
        createdAt: "2026-05-20T07:00:00.000Z",
      },
    },
  });

  return connector
    .verifyWebhook({
      payload,
      headers: { "x-claap-webhook-secret": "whsec_test" },
      secret: "whsec_test",
    })
    .then(result => {
      assert.equal(result.valid, true);
      assert.equal(result.event?.type, "recording_added");
      assert.equal(result.event?.id, "evt_123");
    });
}

function testWebhookVerificationRejectsInvalidSecret() {
  const connector = createConnector();
  return connector
    .verifyWebhook({
      payload: "{}",
      headers: { "x-claap-webhook-secret": "wrong" },
      secret: "whsec_test",
    })
    .then(result => {
      assert.equal(result.valid, false);
      assert.match(result.error || "", /Invalid webhook secret/);
    });
}

function testWebhookPayloadIsExtractedForProcessing() {
  const connector = createConnector();
  assert.deepEqual(
    connector.extractWebhookData({
      eventId: "evt_123",
      event: {
        type: "recording_added",
        recording: {
          id: "rec_1",
          title: "Demo call",
          createdAt: "2026-05-20T07:00:00.000Z",
        },
      },
    }),
    {
      id: "rec_1",
      data: {
        id: "rec_1",
        title: "Demo call",
        createdAt: "2026-05-20T07:00:00.000Z",
      },
    },
  );
}

function testWebhookCdcRecordUsesRecordingsEntity() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    {
      eventId: "evt_123",
      event: {
        type: "recording_updated",
        recording: {
          id: "rec_1",
          title: "Updated",
          createdAt: "2026-05-20T07:00:00.000Z",
        },
      },
    },
    "recording_updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "recordings");
  assert.equal(records[0].recordId, "rec_1");
  assert.equal(records[0].operation, "upsert");
  assert.equal(records[0].payload?.title, "Updated");
  assert.ok(records[0].sourceTs instanceof Date);
}

function testResolveSchemaForRecordings() {
  const connector = createConnector();
  return connector.resolveSchema("recordings").then(schema => {
    assert.ok(schema);
    assert.equal(schema?.entity, "recordings");
    assert.equal(schema?.unknownFieldPolicy, "string");
    assert.ok(schema?.fields.id);
    assert.ok(schema?.fields.createdAt);
    assert.ok(
      schema?.fields.aiFields,
      "aiFields should be in recordings schema",
    );
    assert.ok(
      schema?.fields.insightTemplates,
      "legacy insightTemplates retained for historical rows",
    );
  });
}

type FakeResponse = {
  data?: unknown;
  headers?: Record<string, string>;
};

function listResponse(
  recordings: Record<string, unknown>[],
  options: { nextCursor?: string; dailyRemaining?: number } = {},
): FakeResponse {
  return {
    headers:
      options.dailyRemaining === undefined
        ? {}
        : { "x-ratelimit-daily-remaining": String(options.dailyRemaining) },
    data: {
      result: {
        recordings,
        pagination: { nextCursor: options.nextCursor, totalCount: 3 },
      },
    },
  };
}

function detailRecording(id: string) {
  return {
    id,
    title: `Call ${id}`,
    createdAt: "2026-10-01T09:00:00.000Z",
    aiFields: [{ title: "Next steps", description: "Send the proposal" }],
    keyTakeaways: ["Wants a demo next week"],
    outlines: [{ title: "Intro", startedAt: 0 }],
    actionItems: [{ text: "Send the proposal" }],
    companies: [{ name: "Example Co" }],
  };
}

function createRecordingsConnector(
  get: (path: string, params: Record<string, unknown>) => Promise<FakeResponse>,
  config: Record<string, unknown> = {},
) {
  const connector = createConnector(config);
  (connector as any).claapApi = {
    get: (path: string, options?: { params?: Record<string, unknown> }) =>
      get(path, options?.params ?? {}),
  };
  (connector as any).sleep = () => Promise.resolve();
  return connector;
}

async function testRecordingsAreHydratedFromTheDetailEndpoint() {
  const detailParams: Record<string, unknown>[] = [];
  const listParams: Record<string, unknown>[] = [];
  const connector = createRecordingsConnector((path, params) => {
    if (path === "/v1/recordings") {
      listParams.push(params);
      // List items carry no AI output.
      return Promise.resolve(
        listResponse([{ id: "rec_1", title: "Call rec_1" }]),
      );
    }
    assert.equal(path, "/v1/recordings/rec_1");
    detailParams.push(params);
    return Promise.resolve({
      data: { result: { recording: detailRecording("rec_1") } },
    });
  });

  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "recordings",
    maxIterations: 1,
    onBatch: async records => {
      batches.push(records);
    },
  });

  assert.equal(listParams.length, 1);
  assert.equal(listParams[0].createdAfter, undefined);
  assert.equal(detailParams[0].returnAiFields, true);
  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0][0], detailRecording("rec_1"));
}

async function testRecordingsSkipWhenDetailFails() {
  const connector = createRecordingsConnector(path => {
    if (path === "/v1/recordings") {
      return Promise.resolve(
        listResponse([{ id: "rec_1" }, { id: "rec_2" }, { id: "rec_3" }]),
      );
    }
    if (path === "/v1/recordings/rec_1") {
      return Promise.reject(
        Object.assign(new Error("Request failed"), {
          isAxiosError: true,
          response: { status: 404, data: { message: "Recording not found" } },
        }),
      );
    }
    if (path === "/v1/recordings/rec_2") {
      // A response without the recording must not become a blank row.
      return Promise.resolve({ data: { result: {} } });
    }
    return Promise.resolve({ data: { result: detailRecording("rec_3") } });
  });

  const rows: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const state = await connector.fetchEntityChunk({
    entity: "recordings",
    onBatch: async records => {
      rows.push(...records);
    },
    onLog: (_level, message) => {
      logs.push(message);
    },
  });

  assert.deepEqual(
    rows.map(row => row.id),
    ["rec_3"],
  );
  assert.equal(state.totalProcessed, 1);
  assert.equal(state.hasMore, false);
  assert.ok(logs.some(message => /Skipped 2 Claap recording/.test(message)));
}

async function testRecordingsStopAtDailyQuotaReserveAndResume() {
  // 501 left: rec_1 (→500) and rec_2 (→499) are read, then 499 is below the
  // 500-call reserve and the chunk stops before rec_3.
  let remaining = 501;
  const detailCalls: string[] = [];
  const listCursors: unknown[] = [];
  const get = (path: string, params: Record<string, unknown>) => {
    if (path === "/v1/recordings") {
      listCursors.push(params.cursor);
      return Promise.resolve(
        listResponse([{ id: "rec_1" }, { id: "rec_2" }, { id: "rec_3" }], {
          dailyRemaining: remaining,
        }),
      );
    }
    const id = path.split("/").pop() as string;
    detailCalls.push(id);
    remaining--;
    return Promise.resolve({
      headers: { "x-ratelimit-daily-remaining": String(remaining) },
      data: { result: detailRecording(id) },
    });
  };
  const connector = createRecordingsConnector(get);

  const rows: Record<string, unknown>[] = [];
  const onBatch = async (records: Record<string, unknown>[]) => {
    rows.push(...records);
  };
  const first = await connector.fetchEntityChunk({
    entity: "recordings",
    onBatch,
  });
  assert.deepEqual(detailCalls, ["rec_1", "rec_2"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.totalProcessed, 2);
  assert.equal(first.metadata?.pageOffset, 2);
  assert.equal(first.metadata?.cursor, null);

  // Quota still below the reserve and nothing read yet: the chunk fails
  // without spending any detail call.
  await assert.rejects(
    connector.fetchEntityChunk({ entity: "recordings", onBatch, state: first }),
    /daily API quota/,
  );
  assert.equal(detailCalls.length, 2);

  // Once the window refills, the run resumes at the first unread recording.
  remaining = 2500;
  const resumed = await connector.fetchEntityChunk({
    entity: "recordings",
    onBatch,
    state: first,
  });
  assert.deepEqual(detailCalls, ["rec_1", "rec_2", "rec_3"]);
  assert.equal(resumed.hasMore, false);
  assert.equal(resumed.totalProcessed, 3);
  assert.deepEqual(
    rows.map(row => row.id),
    ["rec_1", "rec_2", "rec_3"],
  );
}

async function testRecordingsLookbackWindowMovesTheAnchorBack() {
  const listParams: Record<string, unknown>[] = [];
  const get = (path: string, params: Record<string, unknown>) => {
    if (path === "/v1/recordings") {
      listParams.push(params);
      return Promise.resolve(listResponse([]));
    }
    return Promise.reject(new Error("no detail call expected"));
  };
  const since = new Date("2026-10-20T00:00:00.000Z");

  await createRecordingsConnector(get, {
    recordings_lookback_days: 14,
  }).fetchEntityChunk({
    entity: "recordings",
    since,
    onBatch: async () => undefined,
  });
  // Default (0): only recordings created after the last sync.
  await createRecordingsConnector(get).fetchEntityChunk({
    entity: "recordings",
    since,
    onBatch: async () => undefined,
  });

  assert.equal(listParams[0].createdAfter, "2026-10-06T00:00:00.000Z");
  assert.equal(listParams[1].createdAfter, "2026-10-20T00:00:00.000Z");
  assert.ok(
    ClaapConnector.getConfigSchema().fields.some(
      field => field.name === "recordings_lookback_days",
    ),
  );
}

function testTranscriptSegmentsParseEveryShape() {
  const segment = {
    startedAt: 136.1,
    endedAt: 137.5,
    speaker: "speaker_1",
    text: "Hello there!",
    languageCode: "en",
    words: [{ word: "Hello", startedAt: 136.1, endedAt: 136.8 }],
  };
  const expected = [
    {
      startedAt: 136.1,
      endedAt: 137.5,
      text: "Hello there!",
      speaker: "speaker_1",
      languageCode: "en",
    },
  ];

  assert.deepEqual(
    parseClaapTranscriptSegments({
      result: { transcript: { segments: [segment] }, languageCode: "en" },
    }),
    expected,
  );
  assert.deepEqual(
    parseClaapTranscriptSegments({ transcript: { segments: [segment] } }),
    expected,
  );
  assert.deepEqual(
    parseClaapTranscriptSegments({ segments: [segment] }),
    expected,
  );
  assert.deepEqual(parseClaapTranscriptSegments([segment]), expected);
  assert.equal(parseClaapTranscriptSegments({ result: {} }), null);
}

function testTranscriptTextMatchesClaapTextFormat() {
  assert.equal(
    renderClaapTranscriptText([
      { startedAt: 137, endedAt: 138, speaker: "speaker_1", text: "Hello" },
      { startedAt: 3725.9, endedAt: 3727, text: "No speaker" },
    ]),
    "02:17 speaker_1: Hello\n1:02:05 No speaker",
  );
}

type FakeGet = (
  path: string,
  options?: { params?: Record<string, unknown> },
) => Promise<unknown>;

function createTranscriptConnector(
  get: FakeGet,
  downloadSignedUrl: (url: string) => Promise<string>,
) {
  const connector = createConnector();
  (connector as any).claapApi = { get };
  (connector as any).downloadSignedUrl = downloadSignedUrl;
  (connector as any).sleep = () => Promise.resolve();
  return connector;
}

async function testTranscriptsDownloadedWithinTheChunk() {
  const listParams: Record<string, unknown>[] = [];
  const endpointCalls: { path: string; params?: Record<string, unknown> }[] =
    [];
  const segment = (text: string) => ({
    result: {
      transcript: {
        segments: [{ startedAt: 1, endedAt: 2, speaker: "speaker_0", text }],
      },
    },
  });

  const connector = createTranscriptConnector(
    (path, options) => {
      if (path === "/v1/recordings") {
        listParams.push(options?.params ?? {});
        return Promise.resolve({
          headers: { "x-ratelimit-daily-remaining": "2500" },
          data: {
            result: {
              recordings: [
                {
                  id: "rec_1",
                  createdAt: "2026-10-01T09:00:00.000Z",
                  transcripts: [
                    {
                      langIso2: "FR",
                      isTranscript: true,
                      isActive: true,
                      url: "https://files.example.test/fr.json",
                    },
                    {
                      langIso2: "en",
                      isTranscript: false,
                      isActive: false,
                      url: "https://files.example.test/expired.json",
                    },
                    {
                      langIso2: "es",
                      isTranscript: false,
                      isActive: false,
                    },
                  ],
                },
                { id: "rec_2", createdAt: "2026-10-01T10:00:00.000Z" },
              ],
              pagination: { totalCount: 2 },
            },
          },
        });
      }
      endpointCalls.push({ path, params: options?.params });
      if (options?.params?.lang === "es") {
        return Promise.reject(new Error("Transcript not found"));
      }
      return Promise.resolve({ data: segment("Hello from the endpoint") });
    },
    url => {
      if (url.endsWith("expired.json")) {
        return Promise.reject(new Error("HTTP 403 downloading transcript"));
      }
      return Promise.resolve(JSON.stringify(segment("Bonjour")));
    },
  );

  const since = new Date("2026-10-10T00:00:00.000Z");
  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "recording_transcripts",
    since,
    maxIterations: 5,
    onBatch: async (records: Record<string, unknown>[]) => {
      batches.push(records);
    },
  });

  assert.equal(listParams.length, 1);
  assert.equal(listParams[0].limit, 50);
  assert.equal(listParams[0].returnAiFields, undefined);
  assert.equal(listParams[0].createdAfter, "2026-10-08T00:00:00.000Z");
  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 3);

  const rows = batches.flat();
  assert.deepEqual(
    rows.map(row => [row.id, row.fetchStatus]),
    [
      ["rec_1:fr", "ok"],
      ["rec_1:en", "ok"],
      ["rec_1:es", "failed"],
    ],
  );
  const french = rows[0];
  assert.equal(french.recordingId, "rec_1");
  assert.equal(french.langIso2, "fr");
  assert.equal(french.isTranscript, true);
  assert.equal(french.transcriptText, "00:01 speaker_0: Bonjour");
  assert.equal(french.charCount, "00:01 speaker_0: Bonjour".length);
  assert.equal(french.segmentCount, 1);
  assert.equal(french.recordingCreatedAt, "2026-10-01T09:00:00.000Z");
  assert.equal(
    rows[1].transcriptText,
    "00:01 speaker_0: Hello from the endpoint",
  );
  assert.equal(rows[2].transcriptText, null);
  assert.match(String(rows[2].fetchError), /Transcript not found/);

  // The expired link and the missing link fall back to the endpoint; the
  // working link does not cost an API call.
  assert.deepEqual(
    endpointCalls.map(call => [
      call.path,
      call.params?.lang,
      call.params?.format,
    ]),
    [
      ["/v1/recordings/rec_1/transcript", "en", "json"],
      ["/v1/recordings/rec_1/transcript", "es", "json"],
    ],
  );
}

async function testTranscriptsStopBeforeDailyQuotaRunsOut() {
  let downloads = 0;
  const connector = createTranscriptConnector(
    () =>
      Promise.resolve({
        headers: { "X-RateLimit-Daily-Remaining": "120" },
        data: {
          result: {
            recordings: [
              {
                id: "rec_1",
                transcripts: [{ langIso2: "fr", url: "https://x.test/a" }],
              },
            ],
            pagination: { nextCursor: "next" },
          },
        },
      }),
    () => {
      downloads++;
      return Promise.resolve("{}");
    },
  );

  await assert.rejects(
    connector.fetchEntityChunk({
      entity: "recording_transcripts",
      onBatch: async () => undefined,
    }),
    /daily API quota/,
  );
  assert.equal(downloads, 0);
}

function testTranscriptEntityIsDeclared() {
  const connector = createConnector();
  assert.ok(connector.getAvailableEntities().includes("recording_transcripts"));
  const metadata = connector
    .getEntityMetadata()
    .find(entry => entry.name === "recording_transcripts");
  assert.equal(
    metadata?.layoutSuggestion?.partitionField,
    "recordingCreatedAt",
  );
  assert.deepEqual(
    connector.getIncrementalCapabilities().perEntity?.recording_transcripts,
    { mode: "created-anchor", anchorField: "createdAfter" },
  );
  // Transcripts ride on the recording webhooks.
  assert.deepEqual(
    connector.getWebhookEventsForEntities(["recording_transcripts"]),
    ["recording_added", "recording_updated"],
  );
  return connector.resolveSchema("recording_transcripts").then(schema => {
    assert.deepEqual(schema?.keyColumns, ["id"]);
    assert.equal(schema?.fields.isTranscript?.type, "boolean");
    assert.equal(schema?.fields.segments?.type, "json");
    assert.equal(schema?.fields.fetchedAt?.type, "timestamp");
  });
}

async function testWebhookRecordingGetsItsTranscripts() {
  const connector = createTranscriptConnector(
    () => Promise.reject(new Error("no API call expected")),
    url => {
      assert.equal(url, "https://files.example.test/fr.json");
      return Promise.resolve(
        JSON.stringify({
          segments: [
            { startedAt: 3, endedAt: 4, speaker: "speaker_1", text: "Salut" },
          ],
        }),
      );
    },
  );
  const event = {
    eventId: "evt_9",
    event: {
      type: "recording_added",
      recording: {
        id: "rec_9",
        createdAt: "2026-10-19T08:00:00.000Z",
        transcripts: [
          {
            langIso2: "fr",
            isTranscript: true,
            isActive: true,
            url: "https://files.example.test/fr.json",
          },
        ],
      },
    },
  };
  const extracted = connector.extractWebhookCdcRecords(
    event,
    "recording_added",
  );

  const enriched = await connector.enrichWebhookCdcRecords(extracted, {
    isEntityEnabled: () => true,
  });
  assert.equal(enriched.length, 2);
  assert.equal(enriched[0].entity, "recordings");
  const transcript = enriched[1];
  assert.equal(transcript.entity, "recording_transcripts");
  assert.equal(transcript.recordId, "rec_9:fr");
  assert.equal(transcript.operation, "upsert");
  assert.equal(transcript.payload?.transcriptText, "00:03 speaker_1: Salut");
  assert.equal(transcript.changeId, "evt_9:recording_transcripts:rec_9:fr");

  // A flow that does not sync transcripts downloads nothing.
  const untouched = await connector.enrichWebhookCdcRecords(extracted, {
    isEntityEnabled: entity => entity !== "recording_transcripts",
  });
  assert.equal(untouched, extracted);
}

function testSupportsResumableFetching() {
  const connector = createConnector();
  assert.equal(connector.supportsResumableFetching(), true);
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), true);
}

function testEntityMetadataIncludesLayoutSuggestion() {
  const connector = createConnector();
  const metadata = connector.getEntityMetadata();
  const recordings = metadata.find(entry => entry.name === "recordings");
  assert.ok(recordings?.layoutSuggestion?.partitionField);
  assert.equal(recordings?.layoutSuggestion?.partitionField, "createdAt");
}

async function main() {
  testConfigValidationRequiresApiKey();
  testRecordingWebhookEventsAreSupported();
  testRecordingWebhookEventsAreMapped();
  await testWebhookVerificationAcceptsMatchingSecret();
  await testWebhookVerificationRejectsInvalidSecret();
  testWebhookPayloadIsExtractedForProcessing();
  testWebhookCdcRecordUsesRecordingsEntity();
  await testResolveSchemaForRecordings();
  await testRecordingsAreHydratedFromTheDetailEndpoint();
  await testRecordingsSkipWhenDetailFails();
  await testRecordingsStopAtDailyQuotaReserveAndResume();
  await testRecordingsLookbackWindowMovesTheAnchorBack();
  testSupportsResumableFetching();
  testEntityMetadataIncludesLayoutSuggestion();
  testTranscriptSegmentsParseEveryShape();
  testTranscriptTextMatchesClaapTextFormat();
  await testTranscriptsDownloadedWithinTheChunk();
  await testTranscriptsStopBeforeDailyQuotaRunsOut();
  await testTranscriptEntityIsDeclared();
  await testWebhookRecordingGetsItsTranscripts();
}

main().catch((error: unknown) => {
  throw error;
});
