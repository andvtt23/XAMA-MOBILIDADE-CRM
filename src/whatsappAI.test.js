import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWhatsAppExport } from "./whatsappAI.js";

const conversation = [
  "25/10/2026 10:00 - Central Xama: Corrida Centro para Vila Nova",
  "25/10/2026 10:01 - Central Xama: 17 reais",
  "25/10/2026 10:02 - Motorista: Ok",
  "26/10/2026 08:00 - Motorista: Livre",
].join("\n");

function fetchResponse(result) {
  return async (_url, options) => {
    JSON.parse(options.body);
    return new Response(`${JSON.stringify({ type: "result", result })}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
}

test("AI results retain original-message evidence and exact cents", async () => {
  const { candidates, summary, unclassified } = await analyzeWhatsAppExport({
    text: conversation,
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
    periodStart: "2026-10-25",
    periodEnd: "2026-10-31",
  }, fetchResponse({
    rides: [{
      anchorIndex: 0,
      messageIndices: [0, 1, 2],
      amountCents: 1700,
      status: "confirmed",
      reason: "A central solicitou a corrida, informou o valor e o motorista aceitou.",
      confidence: 0.96,
      routeSummary: "Centro para Vila Nova",
    }],
    unresolved: [],
    unclassified: [{ messageIndices: [3], reason: "Mensagem de disponibilidade, sem corrida." }],
    summary: {},
    model: "local-test",
  }));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confirmed, true);
  assert.equal(candidates[0].amountCents, 1700);
  assert.equal(candidates[0].driverId, 8);
  assert.match(candidates[0].text, /17 reais/);
  assert.match(candidates[0].text, /Mensagens de origem: 0, 1, 2/);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.confirmedRevenueCents, 1700);
  assert.equal(unclassified[0].messages[0].body, "Livre");
});

test("decimal fare evidence is preserved as 1650 cents", async () => {
  const { candidates } = await analyzeWhatsAppExport({
    text: [
      "25/10/2026 09:00 - Central Xama: Corrida Centro para Vila Nova",
      "25/10/2026 09:01 - Central Xama: 16,50",
      "25/10/2026 09:02 - Motorista: Blz",
    ].join("\n"),
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
  }, fetchResponse({
    rides: [{
      anchorIndex: 0,
      messageIndices: [0, 1, 2],
      amountCents: 1650,
      status: "confirmed",
      reason: "Tarifa indicada pela central e aceita pelo motorista.",
      confidence: 0.96,
    }],
    unresolved: [],
    unclassified: [],
    summary: {},
    model: "local-test",
  }));

  assert.equal(candidates[0].confirmed, true);
  assert.equal(candidates[0].amountCents, 1650);
});

test("written Portuguese fare amounts are verified against the source messages", async () => {
  const { candidates } = await analyzeWhatsAppExport({
    text: [
      "25/10/2026 09:00 - Central Xama: Corrida para Vila Nova",
      "25/10/2026 09:01 - Central Xama: Dezoito reais",
      "25/10/2026 09:02 - Motorista: Ok",
    ].join("\n"),
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
  }, fetchResponse({
    rides: [{
      anchorIndex: 0,
      messageIndices: [0, 1, 2],
      amountCents: 1800,
      status: "confirmed",
      reason: "Tarifa informada por extenso e aceita pelo motorista.",
      confidence: 0.96,
    }],
    unresolved: [],
    unclassified: [],
    summary: {},
    model: "local-test",
  }));

  assert.equal(candidates[0].confirmed, true);
  assert.equal(candidates[0].amountCents, 1800);
});

test("cancelled trips never contribute to confirmed revenue", async () => {
  const { candidates, summary } = await analyzeWhatsAppExport({
    text: [
      "25/10/2026 09:00 - Central Xama: Corrida Centro para Vila Nova",
      "25/10/2026 09:01 - Central Xama: R$ 18,00",
      "25/10/2026 09:02 - Motorista: Cancelada, passageiro desistiu",
    ].join("\n"),
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
  }, fetchResponse({
    rides: [{
      anchorIndex: 0,
      messageIndices: [0, 1, 2],
      amountCents: 1800,
      status: "cancelled",
      reason: "O motorista informou o cancelamento.",
      confidence: 0.98,
    }],
    unresolved: [],
    unclassified: [],
    summary: {},
    model: "local-test",
  }));

  assert.equal(candidates[0].classification, "cancelamento");
  assert.equal(candidates[0].confirmed, false);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.confirmedRevenueCents, 0);
});

test("the complete conversation is sent only to the backend with the selected period", async () => {
  let requestBody;
  const result = await analyzeWhatsAppExport({
    text: conversation,
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
    periodStart: "2026-10-25",
    periodEnd: "2026-10-25",
  }, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(`${JSON.stringify({
      type: "result",
      result: {
        rides: [],
        unresolved: [],
        unclassified: [],
        summary: {},
        model: "local-test",
      },
    })}\n`, { status: 200 });
  });

  assert.equal(requestBody.messages.length, 4);
  assert.equal(requestBody.periodStart, "2026-10-25");
  assert.equal(requestBody.periodEnd, "2026-10-25");
  assert.deepEqual(result.candidates, []);
});

test("duplicate AI anchors and unsupported fares remain pending", async () => {
  const { candidates, summary } = await analyzeWhatsAppExport({
    text: conversation,
    driverName: "Motorista",
    driver: { id: 8, nome: "Motorista" },
  }, fetchResponse({
    rides: [
      {
        anchorIndex: 0,
        messageIndices: [0, 1, 2],
        amountCents: 1800,
        status: "confirmed",
        reason: "Corrida confirmada.",
        confidence: 0.97,
      },
      {
        anchorIndex: 0,
        messageIndices: [0, 1, 2],
        amountCents: 1700,
        status: "confirmed",
        reason: "Repetição.",
        confidence: 0.98,
      },
    ],
    unresolved: [],
    unclassified: [],
    summary: {},
    model: "local-test",
  }));

  assert.equal(candidates[0].confirmed, false);
  assert.match(candidates[0].reviewReason, /Valor não confirmado/);
  assert.equal(candidates[1].confirmed, false);
  assert.match(candidates[1].reviewReason, /mais de uma corrida/);
  assert.equal(summary.confirmed, 0);
  assert.equal(summary.pending, 2);
});

test("API failures are explicit and invalid message references are rejected", async () => {
  await assert.rejects(
    analyzeWhatsAppExport({
      text: conversation,
      driverName: "Motorista",
      driver: { id: 8, nome: "Motorista" },
    }, async () => new Response(
      JSON.stringify({ error: "Configure GEMINI_API_KEY." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )),
    /Configure GEMINI_API_KEY/,
  );

  await assert.rejects(
    analyzeWhatsAppExport({
      text: conversation,
      driverName: "Motorista",
      driver: { id: 8, nome: "Motorista" },
    }, fetchResponse({
      rides: [{
        anchorIndex: 99,
        messageIndices: [99],
        amountCents: 1700,
        status: "confirmed",
        reason: "Sem evidência.",
        confidence: 0.99,
      }],
      unresolved: [],
      unclassified: [],
      summary: {},
      model: "local-test",
    })),
    /mensagens que não existem/,
  );
});
