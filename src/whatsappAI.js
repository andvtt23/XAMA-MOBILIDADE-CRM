import {
  fingerprintFile,
  fingerprintRide,
  parseAmount,
  parseWhatsAppMessages,
  parseWhatsAppExport,
} from "./whatsappImport.js";

const MIN_CONFIDENCE_FOR_AUTO_APPROVAL = 0.85;

export function analyzeWhatsAppExportLocally({
  text,
  drivers,
  driverId = null,
  periodStart,
  periodEnd,
}) {
  const messages = parseWhatsAppMessages(text);
  const parsedCandidates = parseWhatsAppExport(text, drivers, driverId);
  const candidates = parsedCandidates
    .filter(candidate => (
      (!periodStart || candidate.date >= periodStart)
      && (!periodEnd || candidate.date <= periodEnd)
    ))
    .map(candidate => ({
      ...candidate,
      confirmed: false,
      analysisStatus: "pending",
      analysisSource: "manual",
      confirmationSignal: null,
      reviewReason: [
        "Modo manual: confirme motorista, valor e realização antes de aprovar",
        candidate.reviewReason,
      ].filter(Boolean).join(" — "),
    }));

  return {
    messages,
    candidates,
    outsidePeriod: parsedCandidates.length - candidates.length,
  };
}

function findFareEvidence(messages, amountCents) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return false;
  return messages.some(message => {
    const parsed = parseAmount(message.body);
    if (parsed.amountCents === amountCents) return true;
    if (!parsed.ambiguous || !/\b(anota|valor|total)\b/i.test(message.body)) return false;

    const numericTokens = message.body.match(/\d{1,3}(?:\.\d{3})*(?:[,.]\d{1,2})?|\d+/g) ?? [];
    return numericTokens.some(token => parseAmount(`R$ ${token}`).amountCents === amountCents);
  });
}

function makeCandidate(item, messages, driver, source) {
  const evidence = item.messageIndices
    .map(index => messages.get(index))
    .filter(Boolean);
  const anchor = messages.get(item.anchorIndex);
  const amountCents = Number.isSafeInteger(item.amountCents) && item.amountCents > 0
    ? item.amountCents
    : null;
  const confidence = Number.isFinite(item.confidence) ? item.confidence : 0;
  const status = item.status ?? "pending";
  const cancellation = status === "cancelled";
  const amountIsSupported = amountCents !== null && findFareEvidence(evidence, amountCents);
  const rationale = String(item.reason ?? "A IA não forneceu uma justificativa.");
  let reviewReason = null;

  if (cancellation) {
    reviewReason = `Cancelamento identificado pela IA: ${rationale}`;
  } else if (status === "pending") {
    reviewReason = `Aguardando validação: ${rationale}`;
  } else if (confidence < MIN_CONFIDENCE_FOR_AUTO_APPROVAL) {
    reviewReason = `Confiança da IA abaixo de 85% (${Math.round(confidence * 100)}%): ${rationale}`;
  } else if (!driver) {
    reviewReason = "Motorista não identificado no cadastro.";
  } else if (!amountIsSupported) {
    reviewReason = "Valor não confirmado nas mensagens de origem; corrigir manualmente.";
  }

  const date = anchor?.date ?? item.date;
  const time = anchor?.time ?? item.time;
  const sourceMessageIndexes = item.messageIndices;
  const tripNumber = String(item.tripNumber ?? "1");
  const sourceText = evidence.map(message => (
    `[${message.date} ${message.time} · ${message.sender}] ${message.body}`
  )).join("\n");
  const identity = `ai:${date}:${time}:${fingerprintFile(
    `${anchor?.sender ?? ""}:${anchor?.body ?? ""}:${tripNumber}`,
  )}`;
  const text = [
    item.routeSummary ? `Trecho: ${item.routeSummary}` : "",
    `Justificativa da IA: ${rationale}`,
    `Confiança: ${Math.round(confidence * 100)}%`,
    `Mensagens de origem: ${sourceMessageIndexes.join(", ")}`,
    sourceText,
  ].filter(Boolean).join("\n");
  const candidate = {
    date,
    time,
    sender: anchor?.sender ?? "",
    text,
    driverId: driver?.id ?? null,
    driverName: driver?.nome ?? null,
    amount: amountCents === null ? null : amountCents / 100,
    amountCents,
    identity,
    hasTripId: true,
    hasRideContext: true,
    analysisStatus: cancellation ? "cancelled" : reviewReason ? "pending" : "confirmed",
    confirmed: !reviewReason && status === "confirmed",
    confirmationSignal: "análise contextual pela OpenAI Luna",
    classification: cancellation ? "cancelamento" : "corrida",
    analysisSource: source,
    analysisConfidence: confidence,
    sourceMessageIndexes,
    fingerprint: fingerprintRide({
      date,
      identity,
      classification: cancellation ? "cancelamento" : "corrida",
      amountCents,
    }, driver?.id),
    reviewReason,
  };
  return candidate;
}

export async function analyzeWhatsAppExport({
  text,
  driverName,
  driver,
  periodStart,
  periodEnd,
}, options = {}) {
  const fetchImpl = typeof options === "function" ? options : options.fetchImpl ?? fetch;
  const onProgress = typeof options === "function" ? () => {} : options.onProgress ?? (() => {});
  const messages = parseWhatsAppMessages(text);
  const indexedMessages = messages.map((message, index) => ({ index, ...message }));
  onProgress({ stage: "sending", completedChunks: 0, totalChunks: 0, messagesAnalyzed: indexedMessages.length });
  const response = await fetchImpl("/api/whatsapp/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({
      driverName,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      messages: indexedMessages,
    }),
  });
  if (!response.ok) {
    let errorPayload;
    try {
      errorPayload = await response.json();
    } catch {
      throw new Error(`O backend respondeu HTTP ${response.status} sem uma mensagem de erro válida.`);
    }
    throw new Error(errorPayload.error || `O backend respondeu HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error("O backend não disponibilizou o fluxo de progresso da análise.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resultPayload = null;
  async function processLines(final = false) {
    const lines = buffer.split("\n");
    buffer = final ? "" : lines.pop() ?? "";
    if (final && lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("O backend enviou um evento de progresso inválido.");
      }
      if (event.type === "progress") {
        onProgress(event);
      } else if (event.type === "error") {
      throw new Error(event.error || "A análise do Gemini falhou.");
      } else if (event.type === "result") {
        resultPayload = event.result;
      } else {
        throw new Error("O backend enviou um tipo de evento desconhecido.");
      }
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      await processLines(done);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  const payload = resultPayload;
  if (
    !payload
    || !Array.isArray(payload.rides)
    || !Array.isArray(payload.unresolved)
    || !Array.isArray(payload.unclassified)
  ) {
 throw new Error("A API da Luna retornou uma análise incompleta.");
  }

  const sourceByIndex = new Map(indexedMessages.map(message => [message.index, message]));
  const items = [
    ...payload.rides,
    ...payload.unresolved.map(item => ({ ...item, status: "pending" })),
  ];
  const seenAnchors = new Set();
  const candidates = items.map(item => {
    if (
      !item
      || typeof item !== "object"
      || !Array.isArray(item.messageIndices)
      || item.messageIndices.length === 0
      || item.messageIndices.some(messageIndex => !sourceByIndex.has(messageIndex))
      || !Number.isSafeInteger(item.anchorIndex)
      || !item.messageIndices.includes(item.anchorIndex)
    ) {
      throw new Error("A IA referenciou mensagens que não existem no arquivo selecionado.");
    }
    if (!["confirmed", "cancelled", "pending"].includes(item.status)) {
      throw new Error("A IA retornou uma situação de corrida desconhecida.");
    }
    if (
      item.amountCents !== null
      && item.amountCents !== undefined
      && (!Number.isSafeInteger(item.amountCents) || item.amountCents <= 0)
    ) {
      throw new Error("A IA retornou um valor monetário inválido.");
    }
    const anchor = sourceByIndex.get(item.anchorIndex);
    if (
      (periodStart && anchor.date < periodStart)
      || (periodEnd && anchor.date > periodEnd)
    ) {
      throw new Error("A IA atribuiu uma corrida fora do período selecionado.");
    }
    const anchorKey = `${item.anchorIndex}|${item.tripNumber ?? "1"}`;
    const duplicatedAnchor = seenAnchors.has(anchorKey);
    seenAnchors.add(anchorKey);
    const evidence = item.messageIndices.map(messageIndex => sourceByIndex.get(messageIndex));
    const candidate = makeCandidate(item, sourceByIndex, driver, "ia-local");
    if (duplicatedAnchor) {
      candidate.confirmed = false;
      candidate.analysisStatus = "pending";
      candidate.reviewReason = "A mesma mensagem foi atribuída a mais de uma corrida pela IA.";
    }
    if (candidate.amountCents !== null && !findFareEvidence(evidence, candidate.amountCents)) {
      candidate.confirmed = false;
      candidate.analysisStatus = "pending";
      candidate.reviewReason = "Valor não confirmado nas mensagens de origem; corrigir manualmente.";
    }
    return candidate;
  });

  const unclassified = payload.unclassified.map(item => {
    if (
      !item
      || !Array.isArray(item.messageIndices)
      || item.messageIndices.length === 0
      || item.messageIndices.some(messageIndex => !sourceByIndex.has(messageIndex))
      || typeof item.reason !== "string"
      || !item.reason.trim()
    ) {
      throw new Error("A IA retornou mensagens sem uma justificativa válida.");
    }
    return {
      reason: item.reason,
      messages: item.messageIndices.map(messageIndex => sourceByIndex.get(messageIndex)),
    };
  });

  const summary = {
    ...payload.summary,
    confirmed: candidates.filter(candidate => candidate.confirmed).length,
    cancelled: candidates.filter(candidate => candidate.classification === "cancelamento").length,
    unclassified: unclassified.length,
    pending: candidates.filter(candidate => (
      candidate.classification !== "cancelamento" && candidate.reviewReason !== null
    )).length,
    confirmedRevenueCents: candidates
      .filter(candidate => candidate.confirmed)
      .reduce((sum, candidate) => sum + (candidate.amountCents ?? 0), 0),
    model: payload.model,
  };
  return { candidates, summary, unclassified };
}
