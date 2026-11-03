import assert from "node:assert/strict";
import test from "node:test";
import { anonymizeWhatsAppMessages } from "./anonymizeWhatsApp.js";

test("anonymization removes sender identities and common personal/contact details", () => {
  const messages = anonymizeWhatsAppMessages([
    {
      index: 0,
      date: "2026-10-25",
      time: "09:00",
      sender: "Central Xama",
      body: "Passageiro João Silva, buscar na Rua das Flores, 123; telefone 11 98765-4321; R$ 18,00",
    },
    {
      index: 1,
      date: "2026-10-25",
      time: "09:01",
      sender: "Ana Souza",
      body: "Ok, pode anotar dezoito reais. Meu email ana@example.com e CPF 123.456.789-09",
    },
  ], "Ana Souza");
  const serialized = JSON.stringify(messages);

  assert.equal(messages[0].sender, "CENTRAL");
  assert.equal(messages[1].sender, "MOTORISTA");
  assert.match(serialized, /R\$ 18,00/);
  assert.match(serialized, /dezoito reais/);
  assert.match(serialized, /Passageiro \[PESSOA_/);
  assert.doesNotMatch(serialized, /João Silva|Ana Souza|Rua das Flores|98765-4321|ana@example\.com|123\.456\.789-09/);
});

test("anonymization keeps timestamps, message identity, context markers, and sender roles", () => {
  const anonymized = anonymizeWhatsAppMessages([
    {
      index: 12,
      date: "2026-10-25",
      time: "10:30",
      sender: "Xama Mobilidade Urbana",
      body: "A caminho R$ 20,00",
      contextOnly: true,
    },
  ], "Motorista");

  assert.deepEqual(anonymized, [{
    index: 12,
    date: "2026-10-25",
    time: "10:30",
    sender: "CENTRAL",
    body: "A caminho R$ 20,00",
    contextOnly: true,
  }]);
});

test("person redaction preserves cancellation and completion signals", () => {
  const [message] = anonymizeWhatsAppMessages([{
    index: 0,
    date: "2026-10-25",
    time: "10:30",
    sender: "Central Xama",
    body: "Passageiro João Silva não compareceu; corrida cancelada.",
  }]);

  assert.doesNotMatch(message.body, /João Silva/);
  assert.match(message.body, /não compareceu/);
  assert.match(message.body, /corrida cancelada/);
});

test("driver role fallback is assigned to one sender only", () => {
  const messages = anonymizeWhatsAppMessages([
    { index: 0, date: "2026-10-25", time: "09:00", sender: "Central Xama", body: "A caminho" },
    { index: 1, date: "2026-10-25", time: "09:01", sender: "Pessoa Um", body: "Ok" },
    { index: 2, date: "2026-10-25", time: "09:02", sender: "Pessoa Dois", body: "Livre" },
  ], "Motorista cadastrado");

  assert.deepEqual(messages.map(message => message.sender), [
    "CENTRAL",
    "MOTORISTA",
    "PARTICIPANTE_2",
  ]);
});
