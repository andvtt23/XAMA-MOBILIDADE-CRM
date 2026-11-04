import assert from "node:assert/strict";
import test from "node:test";
import { createAIAnalyzer, getAIConfiguration } from "./aiAnalysis.js";

const apiEnv = {
  GROQ_API_KEY: "test-key",
  GROQ_MODEL: "openai/gpt-oss-20b",
};

function groqResponse(result, status = 200) {
  return new Response(JSON.stringify({
    id: "test-completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(result) },
      finish_reason: "stop",
    }],
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const emptyResult = { rides: [], unresolved: [], unclassified: [] };

function sampleMessage(overrides = {}) {
  return {
    index: 0,
    date: "2026-10-25",
    time: "09:00",
    sender: "Ana Souza",
    body: "Passageiro João Silva, pegar na Rua das Flores, 123, telefone 11 98765-4321; R$ 18,00",
    ...overrides,
  };
}

test("configuration requires the Groq API key and uses the default model", () => {
  const missing = getAIConfiguration({});
  assert.deepEqual(missing.missing, ["GROQ_API_KEY"]);
  assert.equal(missing.model, "openai/gpt-oss-20b");

  const configured = getAIConfiguration(apiEnv);
  assert.deepEqual(configured.missing, []);
  assert.equal(configured.model, "openai/gpt-oss-20b");
  assert.equal(configured.apiKey, "test-key");
});

test("an unconfigured Groq key reports requirements and cannot analyze", async () => {
  const analyzer = createAIAnalyzer({});
  assert.equal(analyzer.status().ready, false);
  assert.deepEqual(analyzer.status().missing, ["GROQ_API_KEY"]);
  assert.equal(analyzer.status().provider, "Groq API");

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [],
  }), error => error.code === "AI_NOT_CONFIGURED");
});

test("Groq receives minimized messages and requests JSON output", async () => {
  let requestUrl;
  let requestPayload;
  let authorization;

  const analyzer = createAIAnalyzer(apiEnv, async (url, options) => {
    requestUrl = String(url);
    authorization = new Headers(options.headers).get("authorization");
    requestPayload = JSON.parse(options.body);

    return groqResponse({
      rides: [{
        anchorIndex: 0,
        messageIndices: [0],
        tripNumber: null,
        date: null,
        time: null,
        amountCents: 1800,
        status: "confirmed",
        routeSummary: "Origem [LOCAL_1] para [LOCAL_2]",
        reason: "Tarifa indicada pela central e aceita pelo motorista.",
        confidence: 0.96,
      }],
      unresolved: [],
      unclassified: [],
    });
  });

  const result = await analyzer.analyze({
    driverName: "Ana Souza",
    periodStart: "2026-10-25",
    periodEnd: "2026-10-31",
    messages: [sampleMessage()],
  });

  const serializedRequest = JSON.stringify(requestPayload);

  assert.equal(requestUrl, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(authorization, "Bearer test-key");
  assert.equal(requestPayload.model, "openai/gpt-oss-20b");
  assert.deepEqual(requestPayload.response_format, { type: "json_object" });
  assert.equal(requestPayload.messages[0].role, "system");
  assert.equal(requestPayload.messages[1].role, "user");
  assert.match(serializedRequest, /mensagensAnonimizadas/);
  assert.doesNotMatch(serializedRequest, /Ana Souza|João Silva|Rua das Flores|98765-4321/);
  assert.equal(result.rides[0].amountCents, 1800);
  assert.equal(result.summary.confirmedRevenueCents, 1800);
  assert.equal(result.provider, "Groq API");
});

test("Groq JSON completion is mapped into the CRM result format", async () => {
  const expected = {
    rides: [],
    unresolved: [],
    unclassified: [{
      messageIndices: [0],
      reason: "Sem evidência operacional de corrida.",
    }],
  };

  const analyzer = createAIAnalyzer(apiEnv, async () => groqResponse(expected));

  const result = await analyzer.analyze({
    driverName: "Ana Souza",
    messages: [sampleMessage({
      body: "João Silva, telefone 11 98765-4321, apenas consultando horário",
    })],
  });

  assert.deepEqual(result.unclassified, expected.unclassified);
  assert.equal(result.provider, "Groq API");
  assert.equal(result.model, "openai/gpt-oss-20b");
});

test("empty Groq response fails without inventing results", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => new Response(
    JSON.stringify({
      id: "empty-completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [sampleMessage({ body: "Texto para análise" })],
  }), error => (
    error.code === "GROQ_INVALID_RESPONSE"
    && error.statusCode === 502
  ));
});

test("messages outside the period are sent only as non-classifiable boundary context", async () => {
  let requestPayload;

  const analyzer = createAIAnalyzer(apiEnv, async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return groqResponse(emptyResult);
  });

  const result = await analyzer.analyze({
    driverName: "Motorista",
    periodStart: "2026-10-25",
    periodEnd: "2026-10-25",
    messages: [
      sampleMessage({
        index: 0,
        date: "2026-10-24",
        time: "23:59",
        sender: "Motorista",
        body: "Corrida anterior",
      }),
      sampleMessage({
        index: 1,
        date: "2026-10-25",
        time: "00:01",
        sender: "Central",
        body: "Corrida 18 reais",
      }),
      sampleMessage({
        index: 2,
        date: "2026-10-26",
        time: "00:01",
        sender: "Motorista",
        body: "Livre",
      }),
    ],
  });

  const sentMessages = JSON.parse(
    requestPayload.messages[1].content,
  ).mensagensAnonimizadas;

  assert.equal(sentMessages.length, 3);
  assert.equal(sentMessages[0].contextOnly, true);
  assert.equal(sentMessages[1].contextOnly, false);
  assert.equal(sentMessages[2].contextOnly, true);
  assert.equal(result.summary.messagesAnalyzed, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].anchorIndex, 1);
});

test("messages omitted by Groq are returned for human review", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => groqResponse(emptyResult));

  const result = await analyzer.analyze({
    driverName: "Ana",
    messages: [
      sampleMessage({
        index: 4,
        sender: "Central",
        body: "Texto não classificado",
      }),
    ],
  });

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].anchorIndex, 4);
  assert.match(result.unresolved[0].reason, /não classificou esta mensagem/);
});

test("Groq authentication failures stay explicit without exposing credentials", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => new Response(
    JSON.stringify({
      error: { message: "Invalid API key test-key" },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [sampleMessage({ body: "Corrida 18 reais" })],
  }), error => (
    error.code === "GROQ_AUTH_ERROR"
    && error.message.includes("GROQ_API_KEY")
    && !error.message.includes("test-key")
  ));
});

test("Groq retries HTTP 503 with progressive delays using only the configured model", async () => {
  let attempts = 0;
  const delays = [];

  const analyzer = createAIAnalyzer(
    apiEnv,
    async (_url, options) => {
      attempts += 1;
      assert.equal(JSON.parse(options.body).model, "openai/gpt-oss-20b");

      if (attempts < 3) {
        return new Response(
          JSON.stringify({ error: { message: "temporarily unavailable" } }),
          { status: 503 },
        );
      }

      return groqResponse(emptyResult);
    },
    {
      retryDelaysMs: [1000, 2000],
      sleep: async delay => delays.push(delay),
    },
  );

  const result = await analyzer.analyze({
    driverName: "Ana",
    messages: [sampleMessage({ body: "Texto para análise" })],
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(result.model, "openai/gpt-oss-20b");
});

test("Groq reports the final HTTP 503 after bounded retries", async () => {
  let attempts = 0;

  const analyzer = createAIAnalyzer(
    apiEnv,
    async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { message: "service overloaded" } }),
        { status: 503 },
      );
    },
    {
      retryDelaysMs: [1, 2],
      sleep: async () => {},
    },
  );

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [sampleMessage({ body: "Texto para análise" })],
  }), error => (
    error.statusCode === 503
    && error.code === "GROQ_PROVIDER_ERROR"
    && error.message.includes("service overloaded")
  ));

  assert.equal(attempts, 3);
});