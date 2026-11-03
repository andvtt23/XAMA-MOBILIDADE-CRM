function normalizeIdentity(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteral(text, value, replacement) {
  const escaped = escapeRegex(value.trim());
  if (!escaped) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), replacement);
}

function replaceStable(text, pattern, prefix, replacements) {
  return text.replace(pattern, match => {
    const key = normalizeIdentity(match);
    if (!replacements.has(key)) replacements.set(key, `${prefix}_${replacements.size + 1}`);
    return `[${replacements.get(key)}]`;
  });
}

function redactAddress(text, addressTokens) {
  let result = replaceStable(
    text,
    /\b(?:rua|r\.|avenida|av\.|alameda|travessa|estrada|rodovia|praça|praca|largo|viela|quadra|q\.d\.)\s+[^,\n;]+(?:,\s*(?:n[ºo.]?\s*)?\d{1,6})?(?:,\s*(?:bairro\s+)?(?:centro|jardim|vila|parque|bairro|zona\s+(?:norte|sul|leste|oeste))(?:\s+[\p{L}\d.-]+){0,3})?(?:\s*[-–]\s*(?:apto?\.?|apartamento|bloco|casa|fundos)\s*[\w-]+)?/giu,
    "LOCAL",
    addressTokens,
  );
  result = result.replace(/\b(?:cep\s*)?\d{5}-?\d{3}\b/giu, "[CEP]");
  result = result.replace(/\b(?:n[ºo.]?|número|casa|apto?\.?|apartamento|bloco)\s*\d{1,6}\b/giu, "[NUMERO]");
  result = result.replace(
    /(?<![\d.])-?\d{1,2}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}(?![\d.])/gu,
    "[COORDENADAS]",
  );
  return result;
}

function redactPersonNames(text, nameTokens) {
  const operationalPhrases = new Set([
    "a caminho",
    "cancelada",
    "cancelado",
    "cancelada corrida",
    "cancelado corrida",
    "corrida cancelada",
    "corrida cancelado",
    "corrida confirmada",
    "corrida realizada",
    "corrida concluida",
    "corridas canceladas",
    "cancelamento solicitado",
    "nao apareceu",
    "nao compareceu",
    "nao veio",
    "nao saiu",
    "nao saiu ninguem",
    "passageiro ausente",
    "passageiro desistiu",
    "cancelou",
    "cancelar",
    "desmarcou",
    "desmarcada",
    "desmarcado",
    "livre",
  ]);
  const nonNameWords = "nao|não|apareceu|compareceu|veio|saiu|desistiu|cancelou|cancelar|cancelada|cancelado|desmarcou|desmarcada|desmarcado";
  const personToken = name => {
    const key = normalizeIdentity(name);
    if (!nameTokens.has(key)) nameTokens.set(key, `PESSOA_${nameTokens.size + 1}`);
    return `[${nameTokens.get(key)}]`;
  };
  let result = text.replace(
    new RegExp(
      `\\b((?:passageiro(?:a)?|cliente|nome|sr\\.?|sra\\.?|senhor|senhora|buscar|pegar|chamar|chama|falar com|deixar com|com|para|origem|destino|endereço|endereco|local)\\s+(?:(?:o|a|os|as|do|da|dos|das)\\s+)?)(?!\\b(?:${nonNameWords})\\b)([A-ZÀ-ÖØ-Þ][\\p{L}'’-]*(?:\\s+(?!\\b(?:${nonNameWords})\\b)[A-ZÀ-ÖØ-Þ][\\p{L}'’-]*){0,2})`,
      "giu",
    ),
    (_match, cue, name) => (
      operationalPhrases.has(normalizeIdentity(name))
        ? `${cue}${name}`
        : `${cue}${personToken(name)}`
    ),
  );
  result = result.replace(
    /\b[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,}(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{2,})?\b/gu,
    match => operationalPhrases.has(normalizeIdentity(match)) ? match : personToken(match),
  );
  return result;
}

export function anonymizeWhatsAppMessages(messages, driverName = "") {
  const addressTokens = new Map();
  const nameTokens = new Map();
  const senders = [...new Set(messages.map(message => message.sender.trim()).filter(Boolean))];
  const driverKey = normalizeIdentity(driverName);
  const senderLabels = new Map();
  let otherParticipant = 0;
  let driverSenderFound = false;

  for (const sender of senders) {
    const normalized = normalizeIdentity(sender);
    if (
      normalized.includes("xama mobilidade urbana")
      || normalized === "xama"
      || normalized.includes("central xama")
      || normalized === "central"
      || normalized.startsWith("central ")
    ) {
      senderLabels.set(sender, "CENTRAL");
    } else if (driverKey && normalized === driverKey) {
      senderLabels.set(sender, "MOTORISTA");
      driverSenderFound = true;
    } else {
      otherParticipant += 1;
      senderLabels.set(sender, `PARTICIPANTE_${otherParticipant}`);
    }
  }
  if (driverKey && !driverSenderFound) {
    const firstUnassigned = senders.find(item => senderLabels.get(item) !== "CENTRAL");
    if (firstUnassigned) senderLabels.set(firstUnassigned, "MOTORISTA");
  }
  if (!driverKey && otherParticipant === 1) {
    const [sender] = senders.filter(item => senderLabels.get(item) !== "CENTRAL");
    if (sender) senderLabels.set(sender, "MOTORISTA");
  }

  const privateNames = [...new Set([...senders, driverName].filter(Boolean))]
    .sort((left, right) => right.length - left.length);

  return messages.map(message => {
    let body = String(message.body ?? "");
    for (const [index, name] of privateNames.entries()) {
      body = replaceLiteral(body, name, `[PARTICIPANTE_${index + 1}]`);
    }
    body = body
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[EMAIL]")
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/gu, "[CPF]")
      .replace(/\b\d{2}\.?\d{3}\.?\d{3}[/-]?\d{4}-?\d{2}\b/gu, "[CNPJ]")
      .replace(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-.\s]?\d{4}\b/gu, "[TELEFONE]")
      .replace(/\b(?:https?:\/\/|www\.)\S+/giu, "[LINK]");
    body = redactAddress(body, addressTokens);
    body = redactPersonNames(body, nameTokens);

    return {
      index: message.index,
      date: message.date,
      time: message.time,
      sender: senderLabels.get(message.sender) ?? "PARTICIPANTE",
      body,
      ...(message.contextOnly ? { contextOnly: true } : {}),
    };
  });
}
