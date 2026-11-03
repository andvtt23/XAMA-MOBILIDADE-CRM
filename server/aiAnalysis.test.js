import assert from "node:assert/strict";
import test from "node:test";
import { createAIAnalyzer, getAIConfiguration } from "./aiAnalysis.js";

const apiEnv = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.8-flash",
  GEMINI_API_MODE: "interactions",
};

function geminiResponse(result, status = 200) {
  return new Response(JSON.stringify({
    id: "test-interaction",
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify(result) }],
    }],
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("configuration requires the Gemini API key and configured model", () => {
  const missing = getAIConfiguration({});
  assert.deepEqual(missing.missing, ["GEMINI_API_KEY", "GEMINI_MODEL"]);
  assert.equal(missing.model, "");
  const configured = getAIConfiguration(apiEnv);
  assert.deepEqual(configured.missing, []);
  assert.equal(configured.model, "gemini-3.8-flash");
  assert.equal(configured.apiMode, "interactions");
  assert.equal(getAIConfiguration({
    GEMINI_API_KEY: "test-key",
    GEMINI_MODEL: "gemini-3.8-flash",
  }).apiMode, "generateContent");
});

test("an unconfigured Gemini key reports requirements and cannot analyze", async () => {
  const analyzer = createAIAnalyzer({});
  assert.equal(analyzer.status().ready, false);
  assert.deepEqual(analyzer.status().missing, ["GEMINI_API_KEY", "GEMINI_MODEL"]);
  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [],
  }), error => error.code === "AI_NOT_CONFIGURED");
});

test("official Gemini API receives only minimized messages and structured output config", async () => {
  let requestUrl;
  let requestPayload;
  let apiKeyHeader;
  const analyzer = createAIAnalyzer(apiEnv, async (url, options) => {
    requestUrl = String(url);
    apiKeyHeader = new Headers(options.headers).get("x-goog-api-key");
    requestPayload = JSON.parse(options.body);
    return geminiResponse({
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
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Ana Souza",
      body: "Passageiro João Silva, pegar na Rua das Flores, 123, telefone 11 98765-4321; R$ 18,00",
    }],
  });
  const serializedRequest = JSON.stringify(requestPayload);

  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(apiKeyHeader, "test-key");
  assert.equal(requestPayload.model, "gemini-3.8-flash");
  assert.equal(requestPayload.store, false);
  assert.equal(requestPayload.generation_config.thinking_level, "low");
  assert.equal(requestPayload.response_format.mime_type, "application/json");
  assert.equal(requestPayload.response_format.schema.type, "object");
  assert.match(serializedRequest, /R\$ 18,00/);
  assert.doesNotMatch(serializedRequest, /Ana Souza|João Silva|Rua das Flores|98765-4321/);
  assert.equal(result.rides[0].amountCents, 1800);
  assert.equal(result.summary.confirmedRevenueCents, 1800);
});

test("generateContent mode uses the configured model and maps JSON output into CRM format", async () => {
  let requestUrl;
  let requestBody;
  const expected = {
    rides: [],
    unresolved: [],
    unclassified: [{ messageIndices: [0], reason: "Sem evidência operacional de corrida." }],
  };
  const analyzer = createAIAnalyzer(
    { ...apiEnv, GEMINI_API_MODE: "generateContent" },
    async (url, options) => {
      requestUrl = String(url);
      requestBody = JSON.parse(options.body);
      assert.equal(new Headers(options.headers).get("x-goog-api-key"), "test-key");
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{ text: JSON.stringify(expected) }],
          },
          finishReason: "STOP",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  const result = await analyzer.analyze({
    driverName: "Ana Souza",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Ana Souza",
      body: "João Silva, telefone 11 98765-4321, apenas consultando horário",
    }],
  });

  assert.equal(
    requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.deepEqual(requestBody.generationConfig.responseMimeType, "application/json");
  assert.equal(requestBody.generationConfig.responseSchema.type, "OBJECT");
  assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.doesNotMatch(JSON.stringify(requestBody), /Ana Souza|João Silva|98765-4321/);
  assert.deepEqual(result.unclassified, [{
    ...expected.unclassified[0],
    messageIndices: [0],
  }]);
  assert.equal(result.provider, "Google Gemini generateContent");
});

test("Gemini extracts JSON text from the model_output step", async () => {
  const expected = { rides: [], unresolved: [], unclassified: [] };
  const analyzer = createAIAnalyzer(apiEnv, async () => new Response(JSON.stringify({
    id: "interaction-with-steps",
    status: "completed",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      { type: "model_thought", summary: "internal step" },
      { type: "model_output", content: [{ type: "text", text: JSON.stringify(expected) }] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const result = await analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Texto para análise",
    }],
  });

  assert.deepEqual(result.rides, []);
  assert.equal(result.summary.messagesAnalyzed, 1);
});

test("completed Gemini response without model_output text fails without inventing results", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => new Response(JSON.stringify({
    id: "empty-interaction",
    status: "completed",
    steps: [{ type: "model_thought", summary: "No output step" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Texto para análise",
    }],
  }), error => (
    error.code === "GEMINI_INVALID_RESPONSE"
    && error.statusCode === 502
    && error.message.includes("Resposta vazia")
  ));
});

test("messages outside the period are sent only as non-classifiable boundary context", async () => {
  let requestPayload;
  const analyzer = createAIAnalyzer(apiEnv, async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return geminiResponse({ rides: [], unresolved: [], unclassified: [] });
  });
  const result = await analyzer.analyze({
    driverName: "Motorista",
    periodStart: "2026-10-25",
    periodEnd: "2026-10-25",
    messages: [
      { index: 0, date: "2026-10-24", time: "23:59", sender: "Motorista", body: "Corrida anterior" },
      { index: 1, date: "2026-10-25", time: "00:01", sender: "Central", body: "Corrida 18 reais" },
      { index: 2, date: "2026-10-26", time: "00:01", sender: "Motorista", body: "Livre" },
    ],
  });
  const prompt = requestPayload.input;
  const sentMessages = JSON.parse(prompt).mensagensAnonimizadas;

  assert.equal(sentMessages.length, 3);
  assert.equal(sentMessages[0].contextOnly, true);
  assert.equal(sentMessages[1].contextOnly, false);
  assert.equal(sentMessages[2].contextOnly, true);
  assert.equal(result.summary.messagesAnalyzed, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].anchorIndex, 1);
});

test("messages omitted by Gemini are returned for human review", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => (
    geminiResponse({ rides: [], unresolved: [], unclassified: [] })
  ));
  const result = await analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 4,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Texto não classificado",
    }],
  });

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].anchorIndex, 4);
  assert.match(result.unresolved[0].reason, /não classificou esta mensagem/);
});

test("Gemini authentication failures stay explicit without exposing credentials", async () => {
  const analyzer = createAIAnalyzer(apiEnv, async () => new Response(
    JSON.stringify({ error: { message: "Invalid API key test-key" } }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Corrida 18 reais",
    }],
  }), error => (
    error.code === "GEMINI_AUTH_ERROR"
    && error.message.includes("GEMINI_API_KEY")
    && !error.message.includes("test-key")
  ));
});

test("Gemini retries HTTP 503 with progressive delays using only the configured model", async () => {
  let attempts = 0;
  const delays = [];
  const analyzer = createAIAnalyzer(
    apiEnv,
    async (_url, options) => {
      attempts += 1;
      assert.equal(JSON.parse(options.body).model, "gemini-3.8-flash");
      if (attempts < 3) {
        return new Response(JSON.stringify({
          error: { message: "temporarily unavailable" },
        }), { status: 503 });
      }
      return geminiResponse({ rides: [], unresolved: [], unclassified: [] });
    },
    {
      retryDelaysMs: [1000, 2000],
      sleep: async delay => delays.push(delay),
    },
  );
  const result = await analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Texto para análise",
    }],
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(result.model, "gemini-3.8-flash");
});

test("Gemini reports the final HTTP 503 after bounded retries", async () => {
  let attempts = 0;
  const analyzer = createAIAnalyzer(
    apiEnv,
    async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        error: { message: "service overloaded" },
      }), { status: 503 });
    },
    { retryDelaysMs: [1, 2], sleep: async () => {} },
  );

  await assert.rejects(analyzer.analyze({
    driverName: "Ana",
    messages: [{
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central",
      body: "Texto para análise",
    }],
  }), error => (
    error.statusCode === 503
    && error.code === "GEMINI_PROVIDER_ERROR"
    && error.message.includes("service overloaded")
  ));
  assert.equal(attempts, 3);
});
