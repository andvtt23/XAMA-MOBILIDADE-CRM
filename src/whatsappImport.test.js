import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  countWhatsAppMessages,
  extractWhatsAppTextFiles,
  identifyDriverForConversation,
  identifyDriversInExport,
  filterBulkApprovableReviews,
  isBulkApprovableReview,
  automaticCommission,
  calculateWeeklyRideTotals,
  allocateCommissionCents,
  createWeeklyDriverCalculation,
  extractWhatsAppBatch,
  parseAmount,
  parseWhatsAppMessages,
  parseWhatsAppExport,
} from "./whatsappImport.js";
import {
  INITIAL_DRIVER_NAMES,
  mergeInitialDrivers,
} from "./driverSetup.js";
import { calculateDriverPeriodTotals } from "./driverPeriod.js";

const drivers = [
  { id: 1, nome: "Ana Souza", generoRegra: "mulher" },
  { id: 2, nome: "Lizandra", generoRegra: "mulher" },
  { id: 3, nome: "Ricardo", generoRegra: "outro", telefone: "+55 11 99999-1234" },
];

const anaConversation = [
  "27/10/2026 10:00 - Ana Souza: Corrida #A-12 R$ 35,00",
  "27/10/2026 10:01 - Ana Souza: Corrida #A-12 R$ 35,00",
].join("\n");

function zipFile(name, contents) {
  const bytes = zipSync(contents);
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}

test("reads a direct TXT conversation and parses its message and driver", async () => {
  const files = await extractWhatsAppTextFiles({
    name: "conversa.txt",
    text: async () => anaConversation,
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "conversa.txt");
  assert.equal(countWhatsAppMessages(files[0].text), 2);
  assert.deepEqual(identifyDriversInExport(files[0].text, drivers), ["Ana Souza"]);
  assert.equal(parseWhatsAppExport(files[0].text, drivers).length, 1);
  assert.equal(parseWhatsAppExport(files[0].text, drivers)[0].time, "10:00");
  assert.equal(countWhatsAppMessages("texto qualquer, sem cabeçalhos do WhatsApp"), 0);
});

test("decodes UTF-16 and Windows-1252 conversation text", async () => {
  const utf16 = Buffer.from("\uFEFF27/10/2026 10:00 - Ana Souza: Corrida #A-14 20 reais", "utf16le");
  const [utf16Conversation] = await extractWhatsAppTextFiles({
    name: "utf16.txt",
    arrayBuffer: async () => utf16.buffer.slice(
      utf16.byteOffset,
      utf16.byteOffset + utf16.byteLength,
    ),
  });
  assert.equal(parseWhatsAppExport(utf16Conversation.text, drivers)[0].amountCents, 2000);

  const windows1252 = Buffer.from("27/10/2026 10:00 - José: Corrida #J-1 35 reais", "latin1");
  const [legacyConversation] = await extractWhatsAppTextFiles({
    name: "legacy.txt",
    arrayBuffer: async () => windows1252.buffer.slice(
      windows1252.byteOffset,
      windows1252.byteOffset + windows1252.byteLength,
    ),
  });
  const jose = { id: 9, nome: "José", generoRegra: "outro" };
  assert.equal(parseWhatsAppExport(legacyConversation.text, [jose])[0].driverId, 9);
});

test("parses timestamps from Android and iPhone WhatsApp export headers", () => {
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00:15 - Ana Souza: Corrida #A-12 R$ 35,00",
    "[27/10/2026, 10:00:15] Ana Souza: Corrida #A-12 R$ 35,00",
    "27/10/2026, 11:05 - Ana Souza: Corrida #A-13 R$ 40,00",
  ].join("\n"), drivers);

  assert.deepEqual(parsed.map(item => item.time), ["10:00:15", "11:05"]);
  const messages = parseWhatsAppMessages("16/10/2026 12:23 - Xama Mobilidade Urbana: 16 reais");
  assert.equal(messages[0].sender, "Xama Mobilidade Urbana");
  assert.equal(messages[0].body, "16 reais");
  const systemMessage = parseWhatsAppMessages("16/10/2026 12:24 - As mensagens são protegidas com criptografia de ponta a ponta");
  assert.equal(systemMessage[0].sender, "Sistema");
  assert.equal(systemMessage[0].isSystem, true);
  assert.equal(parseWhatsAppExport(
    "16/10/2026 12:24 - As mensagens são protegidas com criptografia de ponta a ponta",
    drivers,
  ).length, 0);
});

test("keeps multiline message content and reads messages through the end of the export", () => {
  const text = [
    "27/10/2026 10:00 - Ana Souza: Corrida #A-15",
    "Valor confirmado em mensagem complementar: 21 reais",
    ...Array.from({ length: 150 }, (_, index) => `linha de continuação ${index + 1}`),
    "27/10/2026 11:00 - Ana Souza: Corrida #A-16 22 reais",
  ].join("\n");
  const parsed = parseWhatsAppExport(text, drivers);

  assert.equal(countWhatsAppMessages(text), 2);
  assert.equal(parsed.length, 2);
  assert.match(parsed[0].text, /Valor confirmado em mensagem complementar: 21 reais/);
  assert.equal(parsed[1].amountCents, 2200);
});

test("parses BRL values with thousand separators and cents", () => {
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Ana Souza: Corrida #A-12 valor: 1.200,00",
    "27/10/2026 10:01 - Ana Souza: Corrida #A-13 R$ 1.200",
  ].join("\n"), drivers);

  assert.deepEqual(parsed.map(item => item.amount), [1200, 1200]);
  assert.equal(parsed[0].amountCents, 120000);
});

test("parses BRL values with and without currency or decimal markers", () => {
  assert.deepEqual(
    ["18 reais", "17 reais", "R$ 18,00", "16,50", "18.00", "18"]
      .map(value => parseAmount(value).amountCents),
    [1800, 1700, 1800, 1650, 1800, 1800],
  );
});

test("parses BRL values written in Portuguese words without rounding away cents", () => {
  const amounts = [
    "dezoito reais",
    "vinte e cinco reais",
    "cento e vinte reais",
    "dezoito reais e cinquenta centavos",
    "anota dezessete reais",
  ].map(value => parseAmount(value).amountCents);

  assert.deepEqual(amounts, [1800, 2500, 12000, 1850, 1700]);
  assert.equal(parseAmount("Corrida com destino ao Jardim das Flores").amountCents, null);
});

test("does not interpret address or trip numbers as fares", () => {
  assert.equal(parseAmount("Embarque rua Bento Gonçalves número 700").value, null);
  assert.equal(parseAmount("Corrida #A700").value, null);
  assert.equal(parseAmount("Anota 17").amountCents, 1700);
});

test("groups A caminho, central fare, and Livre into one driver ride", () => {
  const driver = {
    id: 3,
    nome: "Ricardo",
    generoRegra: "outro",
    comissaoEspecial: true,
    comissao: 10,
  };
  const conversations = [
    [
      "27/10/2026 10:00 - Ricardo: A caminho",
      "27/10/2026 10:01 - Xama Mobilidade Urbana: Centro para Vila Nova",
      "27/10/2026 10:02 - Xama Mobilidade Urbana: 18 reais",
      "27/10/2026 10:20 - Ricardo: Livre",
    ].join("\n"),
    [
      "27/10/2026 11:00 - Ricardo: A caminho",
      "27/10/2026 11:01 - Xama Mobilidade Urbana: Rua A para Rua B",
      "27/10/2026 11:20 - Ricardo: Livre",
      "27/10/2026 11:21 - Xama Mobilidade Urbana: 16,50",
    ].join("\n"),
  ];

  for (const [index, text] of conversations.entries()) {
    const ride = parseWhatsAppExport(text, [driver], driver.id)[0];
    const expectedCents = index === 0 ? 1800 : 1650;
    const totals = calculateWeeklyRideTotals([{
      motoristaId: driver.id,
      data: "2026-10-27",
      valorCentavos: ride.amountCents,
    }], driver, "2026-10-26", "2026-11-01");

    assert.equal(ride.driverId, driver.id);
    assert.equal(ride.amountCents, expectedCents);
    assert.equal(ride.reviewReason, null);
    assert.equal(totals.count, 1);
    assert.equal(totals.revenueCents, expectedCents);
    assert.equal(totals.rate, 10);
    assert.equal(totals.commissionCents, Math.round(expectedCents * 10 / 100));
  }

  assert.equal(parseWhatsAppExport(
    "27/10/2026 12:00 - Ricardo: Livre",
    [driver],
    driver.id,
  ).length, 0);
});

test("requires ride context or a driver confirmation and does not count the reply twice", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const contextual = parseWhatsAppExport([
    "27/10/2026 10:00 - Camila: A caminho",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 18 reais",
    "27/10/2026 10:02 - Camila: Ok",
  ].join("\n"), [driver], driver.id);
  const directConfirmation = parseWhatsAppExport([
    "27/10/2026 11:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 11:02 - Camila: Blz",
    "27/10/2026 11:03 - Camila: Ok",
  ].join("\n"), [driver], driver.id);
  const unconfirmed = parseWhatsAppExport([
    "27/10/2026 12:00 - Xama Mobilidade Urbana: 16 reais",
  ].join("\n"), [driver], driver.id);

  assert.equal(contextual.length, 1);
  assert.equal(contextual[0].amountCents, 1800);
  assert.equal(contextual[0].confirmed, true);
  assert.equal(contextual[0].confirmationSignal, "resposta do motorista");
  assert.equal(directConfirmation.length, 1);
  assert.equal(directConfirmation[0].amountCents, 1700);
  assert.equal(directConfirmation[0].reviewReason, null);
  assert.equal(directConfirmation[0].confirmed, true);
  assert.equal(unconfirmed.length, 1);
  assert.match(unconfirmed[0].reviewReason, /sem referência explícita a corrida/);
});

test("groups repeated central fares and delayed acknowledgements into one ride", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: Estou em frente ao estacionamento",
    "27/10/2026 10:02 - Camila: Tá bom",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1700);
  assert.equal(parsed[0].reviewReason, null);
});

test("uses a nearby Livre signal as completion but keeps distant bare amounts pending", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const completed = parseWhatsAppExport([
    "27/10/2026 09:59 - Xama Mobilidade Urbana: Corrida da rua A para o centro",
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);
  const noRideContext = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);
  const distant = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 780",
    "27/10/2026 11:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].reviewReason, null);
  assert.equal(noRideContext.length, 1);
  assert.match(noRideContext[0].reviewReason, /sem contexto suficiente/);
  assert.equal(distant.length, 1);
  assert.equal(distant[0].amountCents, 78000);
  assert.match(distant[0].reviewReason, /sem referência explícita/);
});

test("includes a driver's prior ride note when associating the next fare and Livre", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Camila: Foram duas corridas, a outra é 16",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 16 reais",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1600);
  assert.equal(parsed[0].reviewReason, null);
  assert.match(parsed[0].text, /Foram duas corridas/);
});

test("requires ride context before approving a bare numeric fare", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const isolated = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 18",
    "27/10/2026 10:01 - Camila: Ok",
  ].join("\n"), [driver], driver.id);
  const contextual = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Embarque na rua A, destino centro",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 18",
    "27/10/2026 10:02 - Camila: Ok",
  ].join("\n"), [driver], driver.id);

  assert.equal(isolated.length, 1);
  assert.equal(isolated[0].amountCents, 1800);
  assert.match(isolated[0].reviewReason, /sem contexto de corrida/);
  assert.equal(contextual.length, 1);
  assert.equal(contextual[0].amountCents, 1800);
  assert.equal(contextual[0].reviewReason, null);
});

test("recognizes central fare notes such as Anota 17 followed by a driver acknowledgement", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Anota 17",
    "27/10/2026 10:01 - Camila: Blz",
  ].join("\n"), [driver], driver.id);

  assert.equal(parseAmount("Anota 17").amountCents, 1700);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1700);
  assert.equal(parsed[0].confirmed, true);
  assert.equal(parsed[0].confirmationSignal, "resposta do motorista");
  assert.equal(parsed[0].reviewReason, null);
});

test("links a driver's Anota fare to the matching central message without duplicating it", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:01 - Camila: Anota 17 pra mim corrida de volta",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 17 reais",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].driverId, driver.id);
  assert.equal(parsed[0].amountCents, 1700);
  assert.equal(parsed[0].reviewReason, null);
  assert.match(parsed[0].text, /Mensagens relacionadas: 17 reais/);
});

test("links a matching Anota note shortly after the completed ride", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:30 - Camila: Livre",
    "27/10/2026 10:35 - Camila: Anota 17",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1700);
  assert.equal(parsed[0].reviewReason, null);
  assert.match(parsed[0].text, /Anota 17/);
});

test("splits explicit multi-fare Anota notes into separate pending items", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 16 reais",
    "27/10/2026 10:00 - Camila: Anota 16$ + 16$ pra mim",
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 16 reais",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(item => item.amountCents), [1600, 1600]);
  assert.equal(new Set(parsed.map(item => item.fingerprint)).size, 2);
  assert.ok(parsed.every(item => /várias tarifas/.test(item.reviewReason)));
});

test("keeps scheduled trips pending until the ride is completed", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Quero deixar agendado para amanhã",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:02 - Camila: Ok",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1700);
  assert.match(parsed[0].reviewReason, /agendada sem confirmação de realização/);
});

test("confirms a scheduled ride only after a later Livre signal", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Quero deixar agendado para amanhã",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:02 - Camila: Ok",
    "27/10/2026 10:15 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1700);
  assert.equal(parsed[0].reviewReason, null);
});

test("keeps brief central clarification in context until the driver's Livre signal", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Posso deixar agendado para 10:15?",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 16 reais",
    "27/10/2026 10:02 - Camila: Ok",
    "27/10/2026 10:03 - Xama Mobilidade Urbana: <Mídia oculta>",
    "27/10/2026 10:04 - Xama Mobilidade Urbana: Não falou destino",
    "27/10/2026 10:05 - Camila: Ok",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].amountCents, 1600);
  assert.equal(parsed[0].reviewReason, null);
});

test("a cancellation immediately after a fare acknowledgement prevents auto-approval", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:01 - Camila: Ok",
    "27/10/2026 10:02 - Xama Mobilidade Urbana: Corrida cancelada",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].classification, "cancelamento");
  assert.match(parsed[0].reviewReason, /Cancelamento/);
});

test("a scheduled passenger no-show is excluded even if the driver later becomes Livre", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Xama Mobilidade Urbana: Quero deixar agendado",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:02 - Camila: Ok",
    "27/10/2026 10:10 - Camila: Cheguei, buzinei e não saiu ninguém",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].classification, "cancelamento");
  assert.match(parsed[0].reviewReason, /Cancelamento/);
});

test("keeps different same-fare rides separate while collapsing repeated fare values in one ride", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const rides = parseWhatsAppExport([
    "27/10/2026 10:00 - Camila: A caminho",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: Rua A para Centro",
    "27/10/2026 10:02 - Xama Mobilidade Urbana: 18 reais",
    "27/10/2026 10:03 - Camila: 18 reais Ok",
    "27/10/2026 10:20 - Camila: Livre",
    "27/10/2026 11:00 - Camila: A caminho",
    "27/10/2026 11:01 - Xama Mobilidade Urbana: Bairro Novo para Vila Sul",
    "27/10/2026 11:02 - Xama Mobilidade Urbana: 18 reais",
    "27/10/2026 11:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(rides.length, 2);
  assert.deepEqual(rides.map(ride => ride.amountCents), [1800, 1800]);
  assert.equal(new Set(rides.map(ride => ride.fingerprint)).size, 2);
  assert.ok(rides.every(ride => ride.reviewReason === null));
});

test("keeps contextual cancelled rides out of approved totals", () => {
  const cancelled = parseWhatsAppExport([
    "27/10/2026 10:00 - Ana Souza: A caminho corrida #C-18",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 18 reais",
    "27/10/2026 10:02 - Ana Souza: Corrida #C-18 cancelada",
    "27/10/2026 10:20 - Ana Souza: Livre",
  ].join("\n"), drivers, drivers[0].id);

  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].classification, "cancelamento");
  assert.match(cancelled[0].reviewReason, /Cancelamento/);
  assert.equal(cancelled[0].amountCents, 1800);
});

test("keeps corrections for a trip identifier pending instead of counting another ride", () => {
  const driver = { id: 8, nome: "Camila", generoRegra: "mulher" };
  const correction = parseWhatsAppExport([
    "27/10/2026 10:00 - Camila: A caminho corrida #R-20",
    "27/10/2026 10:01 - Xama Mobilidade Urbana: 17 reais",
    "27/10/2026 10:02 - Camila: Corrigindo corrida #R-20 para 18 reais",
    "27/10/2026 10:20 - Camila: Livre",
  ].join("\n"), [driver], driver.id);

  assert.equal(correction.length, 1);
  assert.equal(correction[0].classification, "correção");
  assert.equal(correction[0].amountCents, null);
  assert.match(correction[0].reviewReason, /Correção de corrida/);
  assert.equal(correction[0].confirmed, false);
});

test("calculates independent driver periods and arbitrary summary date ranges", () => {
  const ana = { id: 41, nome: "Ana", generoRegra: "mulher" };
  const ricardo = { id: 42, nome: "Ricardo", generoRegra: "outro" };
  const rides = [
    { motoristaId: 41, data: "2026-10-25", amountCents: 1600 },
    { motoristaId: 41, data: "2026-10-31", amountCents: 1800 },
    { motoristaId: 41, data: "2026-11-01", amountCents: 2000 },
    { motoristaId: 42, data: "2026-10-26", amountCents: 3000 },
    { motoristaId: 42, data: "2026-11-02", amountCents: 4000 },
  ];
  const anaTotals = calculateDriverPeriodTotals(rides, ana, "2026-10-25", "2026-10-31");
  const ricardoTotals = calculateDriverPeriodTotals(rides, ricardo, "2026-11-01", "2026-11-02");
  const summaryTotals = [
    calculateDriverPeriodTotals(rides, ana, "2026-10-26", "2026-11-01"),
    calculateDriverPeriodTotals(rides, ricardo, "2026-10-26", "2026-11-01"),
  ];

  assert.deepEqual(
    [anaTotals.count, anaTotals.revenueCents, anaTotals.commissionCents, anaTotals.netCents],
    [2, 3400, 510, 2890],
  );
  assert.deepEqual(
    [ricardoTotals.count, ricardoTotals.revenueCents, ricardoTotals.commissionCents, ricardoTotals.netCents],
    [1, 4000, 600, 3400],
  );
  assert.equal(summaryTotals.reduce((sum, totals) => sum + totals.count, 0), 3);
  assert.equal(summaryTotals.reduce((sum, totals) => sum + totals.revenueCents, 0), 6800);
  assert.equal(calculateDriverPeriodTotals(rides, ana, "2026-11-02", "2026-10-26").count, 0);
});

test("imports separate ZIP files into the selected drivers and keeps their periods isolated", async () => {
  const ana = { id: 41, nome: "Ana Souza", generoRegra: "mulher" };
  const ricardo = { id: 42, nome: "Ricardo", generoRegra: "outro" };
  const batches = await extractWhatsAppBatch([
    zipFile("ana.zip", {
      "_chat.txt": strToU8([
        "25/10/2026 10:00 - Ana Souza: A caminho",
        "25/10/2026 10:01 - Xama Mobilidade Urbana: Rua A para Rua B",
        "25/10/2026 10:02 - Xama Mobilidade Urbana: 18 reais",
        "25/10/2026 10:20 - Ana Souza: Livre",
      ].join("\n")),
    }),
    zipFile("ricardo.zip", {
      "_chat.txt": strToU8([
        "02/11/2026 11:00 - Ricardo: A caminho",
        "02/11/2026 11:01 - Xama Mobilidade Urbana: Rua C para Rua D",
        "02/11/2026 11:02 - Xama Mobilidade Urbana: 20 reais",
        "02/11/2026 11:20 - Ricardo: Livre",
      ].join("\n")),
    }),
  ]);
  const rides = batches.flatMap((batch, index) => {
    const assignedDriver = index === 0 ? ana : ricardo;
    return batch.conversations.flatMap(conversation => parseWhatsAppExport(
      conversation.text,
      [ana, ricardo],
      assignedDriver.id,
    ));
  });
  const anaTotals = calculateDriverPeriodTotals(
    rides,
    ana,
    "2026-10-25",
    "2026-10-25",
  );
  const ricardoTotals = calculateDriverPeriodTotals(
    rides,
    ricardo,
    "2026-11-02",
    "2026-11-02",
  );

  assert.equal(rides.length, 2);
  assert.deepEqual(rides.map(ride => ride.driverId), [ana.id, ricardo.id]);
  assert.deepEqual(
    [anaTotals.count, anaTotals.revenueCents, ricardoTotals.count, ricardoTotals.revenueCents],
    [1, 1800, 1, 2000],
  );
});

test("uses the full week's ride count for commission when a custom range selects part of that week", () => {
  const ana = { id: 43, nome: "Ana", generoRegra: "mulher" };
  const weeklyRides = Array.from({ length: 81 }, (_, index) => ({
    driverId: ana.id,
    date: index === 0 ? "2026-10-27" : "2026-10-31",
    amountCents: 1000,
  }));
  const totals = calculateDriverPeriodTotals(
    weeklyRides,
    ana,
    "2026-10-27",
    "2026-10-27",
  );

  assert.equal(totals.count, 1);
  assert.equal(totals.revenueCents, 1000);
  assert.equal(totals.rate, 13);
  assert.equal(totals.commissionCents, 130);
});

test("closes multiple imported fares once, per driver, across files and Monday-to-Sunday", () => {
  const ana = drivers[0];
  const fares = ["18 reais", "17 reais", "16,50", "R$ 20,00"];
  const rides = fares.map((fare, index) => [
    `27/10/2026 10:${String(index * 10).padStart(2, "0")} - Ana Souza: A caminho`,
    `27/10/2026 10:${String(index * 10 + 1).padStart(2, "0")} - Xama Mobilidade Urbana: Origem ${index + 1} para destino ${index + 1}`,
    `27/10/2026 10:${String(index * 10 + 2).padStart(2, "0")} - Xama Mobilidade Urbana: ${fare}`,
    `27/10/2026 10:${String(index * 10 + 3).padStart(2, "0")} - Ana Souza: Livre`,
  ].join("\n"));
  const firstFile = rides.slice(0, 2).join("\n");
  const nextFile = rides.slice(2).join("\n");
  const ricardoFile = [
    "27/10/2026 12:00 - Ricardo: A caminho",
    "27/10/2026 12:01 - Xama Mobilidade Urbana: Rua C para Rua D",
    "27/10/2026 12:02 - Xama Mobilidade Urbana: 30 reais",
    "27/10/2026 12:20 - Ricardo: Livre",
  ].join("\n");
  const firstImport = parseWhatsAppExport(firstFile, drivers);
  const secondImport = parseWhatsAppExport(`${nextFile}\n${ricardoFile}`, drivers);
  const repeatedImport = parseWhatsAppExport(firstFile, drivers);
  const importedRides = [...firstImport, ...secondImport, ...repeatedImport]
    .filter((ride, index, allRides) => (
      allRides.findIndex(item => item.fingerprint === ride.fingerprint) === index
    ));
  const anaRides = importedRides.filter(ride => String(ride.driverId) === String(ana.id));
  const totals = calculateWeeklyRideTotals(anaRides, ana, "2026-10-26", "2026-11-01");
  const snapshot = createWeeklyDriverCalculation(
    ana,
    anaRides,
    "2026-10-26",
    "2026-11-01",
  );
  const ricardoTotals = calculateWeeklyRideTotals(
    importedRides,
    drivers[2],
    "2026-10-26",
    "2026-11-01",
  );

  assert.equal(anaRides.length, 4);
  assert.equal(totals.count, 4);
  assert.equal(totals.revenueCents, 7150);
  assert.equal(totals.rate, 15);
  assert.equal(totals.commissionCents, 1073);
  assert.equal(totals.netCents, 6077);
  assert.equal(snapshot.count, 4);
  assert.equal(snapshot.revenueCents, 7150);
  assert.equal(snapshot.commissionCents, 1073);
  assert.equal(snapshot.netCents, 6077);
  assert.equal(ricardoTotals.count, 1);
  assert.equal(ricardoTotals.revenueCents, 3000);
  assert.equal(ricardoTotals.commissionCents, 450);

  const boundaryTotals = calculateWeeklyRideTotals([
    ...anaRides,
    { driverId: ana.id, date: "2026-11-01", amountCents: 1000 },
    { driverId: ana.id, date: "2026-11-02", amountCents: 2000 },
  ], ana, "2026-10-26", "2026-11-01");
  assert.equal(boundaryTotals.count, 5);
  assert.equal(boundaryTotals.revenueCents, 8150);
  assert.equal(calculateWeeklyRideTotals(
    [{ driverId: ana.id, date: "2026-11-02", amountCents: 2000 }],
    ana,
    "2026-11-02",
    "2026-11-08",
  ).count, 1);
});

test("sends amount messages without an explicit trip reference to manual review", () => {
  const parsed = parseWhatsAppExport(
    "27/10/2026 10:00 - Xama Mobilidade Urbana: 16 reais",
    drivers,
    1,
  );

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].driverId, 1);
  assert.equal(parsed[0].amount, 16);
  assert.equal(parsed[0].amountCents, 1600);
  assert.equal(parsed[0].reviewReason, "Mensagem com valor, mas sem referência explícita a corrida");
});

test("recognizes conversation-name motorist while ignoring emojis and uses saved exact links", () => {
  const conversation = "27/10/2026 10:00 - Xama Mobilidade Urbana: 16 reais";
  const messages = parseWhatsAppMessages(conversation);
  const matched = identifyDriverForConversation(
    "Conversa do WhatsApp com 🟢🟢MOt. Ricardo.zip",
    messages,
    drivers,
  );
  assert.equal(matched.driverId, 3);
  assert.equal(matched.method, "nome da conversa");
  assert.equal(identifyDriverForConversation(
    "contato-11999991234.zip",
    messages,
    drivers,
  ).driverId, 3);
  const phoneMessage = parseWhatsAppMessages(
    "27/10/2026 10:00 - +55 11 99999-1234: Livre",
  );
  assert.equal(identifyDriverForConversation(
    "export-unknown.zip",
    phoneMessage,
    drivers,
  ).method, "telefone");
  assert.equal(identifyDriverForConversation(
    "export-unknown.zip",
    messages,
    drivers,
    [{ label: "export-unknown.zip", driverId: 3 }],
  ).driverId, 3);
  assert.equal(identifyDriverForConversation(
    "Conversa Ricardo.zip",
    messages,
    [...drivers, { id: 4, nome: "Ricardo" }],
  ).method, "nome ambíguo");
});

test("keeps the Mot. Ricardo amount message for review instead of inventing a trip", async () => {
  const zip = zipFile("Conversa do WhatsApp com 🟢🟢MOt. Ricardo.zip", {
    "_chat.txt": strToU8([
      "16/10/2026 12:23 - Xama Mobilidade Urbana: 16 reais",
      "16/10/2026 13:41 - 🟢🟢MOt. Ricardo: Livre",
    ].join("\n")),
  });
  const [conversation] = await extractWhatsAppTextFiles(zip);
  const messages = parseWhatsAppMessages(conversation.text);
  const driver = identifyDriverForConversation(
    `${zip.name} ${conversation.name}`,
    messages,
    drivers,
  );
  const rides = parseWhatsAppExport(conversation.text, drivers, driver.driverId);

  assert.equal(driver.driverId, 3);
  assert.equal(messages.length, 2);
  assert.deepEqual(identifyDriversInExport(conversation.text, drivers), ["Ricardo"]);
  assert.equal(rides.length, 1);
  assert.equal(rides[0].amountCents, 1600);
  assert.equal(rides[0].reviewReason, "Mensagem com valor, mas sem referência explícita a corrida");
});

test("recognizes dynamic reais values and keeps confirmations/corrections out of automatic rides", () => {
  assert.equal(parseAmount("20 Reais").amountCents, 2000);
  assert.equal(parseAmount("15,75 reais").amountCents, 1575);
  const parsed = parseWhatsAppExport([
    "27/10/2026 10:00 - Ana Souza: Corrida #A-20 20 reais",
    "27/10/2026 10:01 - Ana Souza: Corrida #A-20 confirmada 20 reais",
    "27/10/2026 10:02 - Ana Souza: Corrigindo corrida #A-20 para 18 reais",
  ].join("\n"), drivers);

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].reviewReason, null);
  assert.equal(parsed[1].classification, "confirmação");
  assert.notEqual(parsed[1].reviewReason, null);
  assert.equal(parsed[2].classification, "correção");
  assert.notEqual(parsed[2].reviewReason, null);
});

test("applies the above-80 weekly threshold and protects custom rates and Lizandra", () => {
  const woman = { nome: "Ana Souza", generoRegra: "mulher" };
  assert.equal(automaticCommission(woman, 79), 15);
  assert.equal(automaticCommission(woman, 80), 15);
  assert.equal(automaticCommission(woman, 81), 13);
  assert.equal(automaticCommission({ ...woman, comissaoEspecial: true, comissao: 12 }, 81), 12);
  assert.equal(automaticCommission({ nome: "Lizandra", generoRegra: "mulher" }, 81), 10);
  assert.equal(automaticCommission({
    nome: "Lizandra",
    generoRegra: "mulher",
    comissaoEspecial: true,
    comissao: 12,
  }, 81), 12);
  assert.equal(automaticCommission({ nome: "Ricardo", generoRegra: "outro" }, 79), 15);
});

test("seeds the 61 initial drivers once, preserving existing records and sorting names", () => {
  const existingDriver = {
    id: 700,
    nome: "leticia",
    comissao: 12,
    comissaoEspecial: true,
    generoRegra: "mulher",
    aliases: ["Lê"],
  };
  const seeded = mergeInitialDrivers([existingDriver]);
  const seededAgain = mergeInitialDrivers(seeded);
  const leticia = seeded.find(driver => driver.id === 700);
  const lyzandra = seeded.find(driver => driver.nome === "Lyzandra");
  const abraao = seeded.find(driver => driver.nome === "Abraão");
  const luciana = seeded.find(driver => driver.nome === "Luciana");
  const other = seeded.find(driver => driver.nome === "Luiz Gabriel");

  assert.equal(INITIAL_DRIVER_NAMES.length, 61);
  assert.equal(seeded.length, 61);
  assert.equal(seededAgain.length, 61);
  assert.deepEqual(leticia, existingDriver);
  assert.deepEqual(seeded.map(driver => driver.nome), [...seeded]
    .map(driver => driver.nome)
    .sort((left, right) => left.localeCompare(right, "pt-BR", { sensitivity: "base" })));
  assert.equal(lyzandra.comissao, 10);
  assert.equal(lyzandra.comissaoEspecial, true);
  assert.equal(automaticCommission(lyzandra, 81), 10);
  assert.equal(automaticCommission({ ...lyzandra, comissao: 12 }, 81), 12);
  assert.equal(abraao.comissao, 10);
  assert.equal(abraao.comissaoEspecial, true);
  assert.equal(automaticCommission(abraao, 81), 10);
  assert.equal(luciana.generoRegra, "mulher");
  assert.equal(luciana.comissao, 15);
  assert.equal(luciana.comissaoEspecial, false);
  assert.equal(automaticCommission(luciana, 80), 15);
  assert.equal(automaticCommission(luciana, 81), 13);
  assert.equal(other.generoRegra, "outro");
  assert.equal(other.comissao, 15);
});

test("calculates weekly totals in integer cents using Monday-to-Sunday boundaries", () => {
  const driver = { id: 8, nome: "Ana Souza", generoRegra: "mulher" };
  const rides = Array.from({ length: 81 }, () => ({
    driverId: 8,
    date: "2026-10-27",
    amountCents: 1001,
  }));
  const at79 = calculateWeeklyRideTotals(rides.slice(0, 79), driver, "2026-10-26", "2026-11-01");
  const at80 = calculateWeeklyRideTotals(rides.slice(0, 80), driver, "2026-10-26", "2026-11-01");
  const at81 = calculateWeeklyRideTotals(rides, driver, "2026-10-26", "2026-11-01");
  const centSafe = calculateWeeklyRideTotals([
    { driverId: 8, date: "2026-10-27", amountCents: 1001 },
    { driverId: 8, date: "2026-10-28", amountCents: 502 },
  ], driver, "2026-10-26", "2026-11-01");

  assert.equal(at79.count, 79);
  assert.equal(at79.rate, 15);
  assert.equal(at80.count, 80);
  assert.equal(at80.rate, 15);
  assert.equal(at81.count, 81);
  assert.equal(at81.rate, 13);
  assert.equal(centSafe.revenueCents, 1503);
  assert.equal(centSafe.commissionCents, 225);
  assert.equal(centSafe.netCents, 1278);
});

test("keeps excluded historical quotes out of period, weekly, and saved totals", () => {
  const driver = { id: 8, nome: "Bryan", generoRegra: "outro" };
  const rides = [
    { id: "confirmed", driverId: 8, date: "2026-10-27", amountCents: 1800 },
    {
      id: "quote",
      driverId: 8,
      date: "2026-10-27",
      amountCents: 33000,
      excludedFromTotals: true,
    },
  ];
  const weekly = calculateWeeklyRideTotals(rides, driver, "2026-10-26", "2026-11-01");
  const period = calculateDriverPeriodTotals(rides, driver, "2026-10-25", "2026-10-31");
  const saved = createWeeklyDriverCalculation(
    driver,
    rides,
    "2026-10-26",
    "2026-11-01",
  );

  for (const totals of [weekly, period, saved]) {
    assert.equal(totals.count, 1);
    assert.equal(totals.revenueCents, 1800);
    assert.equal(totals.commissionCents, 270);
    assert.equal(totals.netCents, 1530);
  }
});

test("keeps the selected weekly close separate from archived and other-driver rides", () => {
  const driver = {
    id: 21,
    nome: "Marina",
    generoRegra: "mulher",
    comissaoEspecial: true,
    comissao: 12,
  };
  const otherDriver = { id: 22, nome: "Carlos", generoRegra: "outro" };
  const rides = [
    { id: "monday", driverId: 21, date: "2026-10-26", amountCents: 1800 },
    { id: "sunday", driverId: 21, date: "2026-11-01", amountCents: 1700 },
    { id: "previous-week", driverId: 21, date: "2026-10-25", amountCents: 5000 },
    { id: "other-driver", driverId: 22, date: "2026-10-27", amountCents: 4000 },
  ];
  const start = "2026-10-26";
  const end = "2026-11-01";
  const selectedWeekRides = rides.filter(ride => ride.date >= start && ride.date <= end);
  const driverTotals = calculateWeeklyRideTotals(selectedWeekRides, driver, start, end);
  const archived = createWeeklyDriverCalculation(driver, selectedWeekRides, start, end);
  const archivedOtherDriver = createWeeklyDriverCalculation(
    otherDriver,
    selectedWeekRides,
    start,
    end,
  );
  const remainingRides = rides.filter(ride => ride.date < start || ride.date > end);
  const clearedTotals = calculateWeeklyRideTotals(remainingRides, driver, start, end);
  const clearedOtherDriverTotals = calculateWeeklyRideTotals(
    remainingRides,
    otherDriver,
    start,
    end,
  );
  const otherDriverTotals = calculateWeeklyRideTotals(selectedWeekRides, otherDriver, start, end);

  assert.equal(driverTotals.count, 2);
  assert.equal(driverTotals.revenueCents, 3500);
  assert.equal(driverTotals.rate, 12);
  assert.equal(driverTotals.commissionCents, 420);
  assert.equal(driverTotals.netCents, 3080);
  assert.equal(archived.count, 2);
  assert.equal(archived.revenueCents, 3500);
  assert.equal(archivedOtherDriver.count, 1);
  assert.equal(archivedOtherDriver.revenueCents, 4000);
  assert.equal(remainingRides.length, 1);
  assert.deepEqual(remainingRides.map(ride => ride.id), ["previous-week"]);
  assert.equal(clearedTotals.count, 0);
  assert.equal(clearedTotals.revenueCents, 0);
  assert.equal(clearedTotals.commissionCents, 0);
  assert.equal(clearedTotals.netCents, 0);
  assert.equal(clearedOtherDriverTotals.count, 0);
  assert.equal(clearedOtherDriverTotals.revenueCents, 0);
  assert.equal(otherDriverTotals.count, 1);
  assert.equal(otherDriverTotals.revenueCents, 4000);
});

test("creates per-driver weekly calculation snapshots with cent precision and history version", () => {
  const snapshot = createWeeklyDriverCalculation(
    { id: 8, nome: "Carlos", comissao: 15, comissaoEspecial: false, generoRegra: "outro" },
    [
      { id: "approved-1", driverId: 8, date: "2026-10-26", time: "09:00", amountCents: 5, arquivo: "carlos.zip" },
      { id: "approved-2", driverId: 8, date: "2026-10-27", time: "10:00", amountCents: 5, arquivo: "carlos.zip" },
      { id: "manual", motoristaId: 9, data: "2026-10-27", valorCentavos: 10000 },
      { id: "outside-week", driverId: 8, date: "2026-11-02", amountCents: 5000 },
    ],
    "2026-10-26",
    "2026-11-01",
    2,
    "2026-10-31T12:00:00.000Z",
  );

  assert.equal(snapshot.driverId, 8);
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.revenueCents, 10);
  assert.equal(snapshot.rate, 15);
  assert.equal(snapshot.commissionCents, 2);
  assert.equal(snapshot.netCents, 8);
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(snapshot.rides.map(ride => ride.id), ["approved-1", "approved-2"]);
  assert.equal(snapshot.rides[0].source, "WhatsApp");
});

test("applies the percentage to the weekly base and allocates detail cents without changing the total", () => {
  const driver = { id: 8, nome: "Carlos", comissao: 15, comissaoEspecial: false, generoRegra: "outro" };
  const rides = [
    { driverId: 8, date: "2026-10-26", amountCents: 5 },
    { driverId: 8, date: "2026-10-27", amountCents: 5 },
    { driverId: 8, date: "2026-10-28", amountCents: 5 },
  ];
  const totals = calculateWeeklyRideTotals(rides, driver, "2026-10-26", "2026-11-01");
  const detailCommissions = allocateCommissionCents(rides, 15);

  assert.equal(totals.revenueCents, 15);
  assert.equal(totals.commissionCents, 2);
  assert.equal(detailCommissions.reduce((sum, cents) => sum + cents, 0), 2);
});

test("allows only fully identified, contextual, nonduplicate ride reviews in bulk", () => {
  const driver = { id: 3, nome: "Ricardo" };
  const review = {
    id: "review-1",
    classification: "corrida",
    hasRideContext: true,
    date: "2026-10-27",
    driverIdRevisao: "3",
    amountCents: 1600,
    valorRevisao: "16",
    identity: "trip:12",
    hasTripId: true,
    fingerprint: "candidate-1",
    reviewReason: null,
  };

  assert.equal(isBulkApprovableReview(review, [driver], []), true);
  assert.equal(isBulkApprovableReview(
    { ...review, reviewReason: "Mensagem com valor, mas sem referência explícita a corrida" },
    [driver],
    [],
  ), false);
  assert.equal(isBulkApprovableReview({ ...review, hasRideContext: false }, [driver], []), false);
  assert.equal(isBulkApprovableReview({ ...review, date: "2026-02-30" }, [driver], []), false);
  assert.equal(isBulkApprovableReview({ ...review, valorRevisao: "" }, [driver], []), false);
  assert.equal(isBulkApprovableReview({ ...review, driverIdRevisao: "" }, [driver], []), false);
  assert.equal(isBulkApprovableReview({
    ...review,
    reviewReason: "Motorista não identificado",
  }, [driver], []), false);
  assert.equal(isBulkApprovableReview({
    ...review,
    reviewReason: "Motorista não identificado",
    motoristaConfirmadoManualmente: true,
  }, [driver], []), true);
  assert.equal(isBulkApprovableReview(
    review,
    [driver],
    [{ identity: review.identity, date: review.date, driverId: driver.id }],
  ), false);
  assert.equal(filterBulkApprovableReviews([
    review,
    { ...review, id: "review-duplicate", valorRevisao: "17", amountCents: 1700 },
  ], [driver], []).length, 1);
});

test("extracts all TXT conversations in a ZIP and ignores media files", async () => {
  const bytes = zipFile("export.zip", {
    "Ana/_chat.txt": strToU8(anaConversation),
    "Lyzandra.txt": strToU8("[27/10/2026, 11:00] Lyzandra: Corrida #B-2 R$ 48,90"),
    "photo.jpg": strToU8("ignored media"),
  });

  const files = await extractWhatsAppTextFiles(bytes);

  assert.equal(files.length, 2);
  assert.deepEqual(files.map(file => file.name), ["Ana/_chat.txt", "Lyzandra.txt"]);
  assert.equal(countWhatsAppMessages(files[0].text), 2);
  assert.equal(parseWhatsAppExport(files[1].text, drivers)[0].amount, 48.9);
});

test("processes multiple ZIPs independently and continues after one invalid file", async () => {
  const result = await extractWhatsAppBatch([
    zipFile("ricardo.zip", {
      "_chat.txt": strToU8("27/10/2026 10:00 - Xama Mobilidade Urbana: 16 reais"),
    }),
    {
      name: "invalido.zip",
      arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer,
    },
    zipFile("ana.zip", {
      "_chat.txt": strToU8(anaConversation),
    }),
  ]);

  assert.equal(result.length, 3);
  assert.equal(result[0].conversations.length, 1);
  assert.match(result[1].error, /ZIP válido|danificado/);
  assert.equal(result[2].conversations.length, 1);
});

test("rejects invalid archives, ZIPs without TXT, and password-protected TXT entries", async () => {
  await assert.rejects(
    extractWhatsAppTextFiles({
      name: "danificado.zip",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
    /ZIP válido|danificado/,
  );

  await assert.rejects(
    extractWhatsAppTextFiles(zipFile("sem-conversa.zip", {
      "foto.jpg": strToU8("ignored"),
    })),
    /não contém arquivos TXT/,
  );

  await assert.rejects(
    extractWhatsAppTextFiles({
      name: "vazio.txt",
      text: async () => " \n ",
    }),
    /TXT está vazio/,
  );

  await assert.rejects(
    extractWhatsAppTextFiles(zipFile("conversa-vazia.zip", {
      "conversa.txt": strToU8(" \n "),
    })),
    /TXT encontrados no ZIP estão vazios/,
  );

  const encrypted = zipSync({ "conversa.txt": strToU8(anaConversation) });
  const centralOffset = encrypted.findIndex((value, index) => (
    value === 0x50
    && encrypted[index + 1] === 0x4b
    && encrypted[index + 2] === 0x01
    && encrypted[index + 3] === 0x02
  ));
  assert.notEqual(centralOffset, -1);
  encrypted[centralOffset + 8] |= 1;
  await assert.rejects(
    extractWhatsAppTextFiles({
      name: "protegido.zip",
      arrayBuffer: async () => encrypted.buffer.slice(
        encrypted.byteOffset,
        encrypted.byteOffset + encrypted.byteLength,
      ),
    }),
    /protegido por senha/,
  );
});
