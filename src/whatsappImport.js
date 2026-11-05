import { unzip } from "fflate";

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getZipCentralDirectory(bytes) {
  const searchStart = Math.max(0, bytes.length - 22 - 65535);
  let endOffset = -1;

  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) {
      endOffset = offset;
      break;
    }
  }

  if (endOffset < 0) {
    throw new Error("O arquivo não é um ZIP válido ou está danificado.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || offset === 0xffffffff) {
    throw new Error("Este ZIP usa o formato ZIP64, que não é suportado. Reexporte a conversa pelo WhatsApp.");
  }
  const decoder = new TextDecoder();
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > bytes.length
      || bytes[offset] !== 0x50
      || bytes[offset + 1] !== 0x4b
      || bytes[offset + 2] !== 0x01
      || bytes[offset + 3] !== 0x02
    ) {
      throw new Error("O diretório interno do ZIP está inválido ou incompleto.");
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > bytes.length) {
      throw new Error("O diretório interno do ZIP está incompleto.");
    }

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameEnd)),
      encrypted: Boolean(view.getUint16(offset + 8, true) & 1),
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export async function extractWhatsAppTextFiles(file) {
  const fileName = file.name ?? "arquivo";
  const extension = fileName.split(".").pop()?.toLocaleLowerCase("pt-BR");

  if (extension === "txt") {
    const text = typeof file.arrayBuffer === "function"
      ? decodeWhatsAppText(new Uint8Array(await file.arrayBuffer()), new TextDecoder("utf-8"))
      : await file.text();
    if (!text.trim()) {
      throw new Error("O arquivo TXT está vazio.");
    }
    return [{
      name: fileName,
      text,
    }];
  }

  if (extension !== "zip") {
    throw new Error("Formato não aceito. Selecione uma exportação .txt ou um arquivo .zip do WhatsApp.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = getZipCentralDirectory(bytes);
  const textEntries = entries.filter(entry => entry.name.toLocaleLowerCase("pt-BR").endsWith(".txt"));

  if (textEntries.length === 0) {
    throw new Error("O ZIP não contém arquivos TXT para importar.");
  }

  const encryptedText = textEntries.find(entry => entry.encrypted);
  if (encryptedText) {
    throw new Error(`O arquivo "${encryptedText.name}" está protegido por senha. Exporte uma cópia do WhatsApp sem senha.`);
  }

  const extracted = await new Promise((resolve, reject) => {
    unzip(bytes, {
      filter: entry => entry.name.toLocaleLowerCase("pt-BR").endsWith(".txt"),
    }, (error, files) => {
      if (error) {
        reject(new Error("Não foi possível descompactar o ZIP. Verifique se o arquivo está íntegro e não exige senha."));
        return;
      }
      resolve(files);
    });
  });

  const decoder = new TextDecoder("utf-8");
  const textFiles = Object.entries(extracted)
    .map(([name, content]) => ({
      name,
      text: decodeWhatsAppText(content, decoder),
    }));
  if (!textFiles.some(textFile => textFile.text.trim())) {
    throw new Error("Os arquivos TXT encontrados no ZIP estão vazios.");
  }
  return textFiles;
}

export async function extractWhatsAppBatch(files, onProgress = () => {}) {
  const results = [];
  for (const [index, file] of Array.from(files).entries()) {
    await onProgress(file, index, files.length);
    try {
      results.push({
        fileName: file.name ?? `arquivo-${index + 1}`,
        conversations: await extractWhatsAppTextFiles(file),
        error: null,
      });
    } catch (error) {
      results.push({
        fileName: file.name ?? `arquivo-${index + 1}`,
        conversations: [],
        error: error instanceof Error ? error.message : "Erro desconhecido ao extrair o arquivo.",
      });
    }
  }
  return results;
}

function decodeWhatsAppText(content, utf8Decoder) {
  if (content[0] === 0xff && content[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(content);
  }
  if (content[0] === 0xfe && content[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(content);
  }
  const decoded = utf8Decoder.decode(content);
  if (decoded.includes("\uFFFD")) {
    return new TextDecoder("windows-1252").decode(content);
  }
  return decoded;
}

export function automaticCommission(driver, rideCount) {
  if (driver.comissaoEspecial === true && Number.isFinite(Number(driver.comissao))) {
    return Number(driver.comissao);
  }
  const normalizedName = normalizeText(driver.nome).trim();
  if (normalizedName === "lizandra" || normalizedName === "lyzandra"
    || normalizedName.startsWith("lizandra ") || normalizedName.startsWith("lyzandra ")) {
    return 10;
  }
  return driver.generoRegra === "mulher"
    ? (rideCount > 80 ? 13 : 15)
    : 15;
}

export function calculateWeeklyRideTotals(rides, driver, start, end) {
  const driverRides = rides.filter(ride => (
    ride.excludedFromTotals !== true
    && String(ride.driverId ?? ride.motoristaId) === String(driver.id)
    && (ride.date ?? ride.data) >= start
    && (ride.date ?? ride.data) <= end
  ));
  const revenueCents = driverRides.reduce((sum, ride) => (
    sum + Number(
      ride.amountCents
      ?? ride.valorCentavos
      ?? Math.round(Number(ride.amount ?? ride.valor ?? 0) * 100),
    )
  ), 0);
  const rate = automaticCommission(driver, driverRides.length);
  const commissionCents = Math.round(revenueCents * rate / 100);
  return {
    count: driverRides.length,
    revenueCents,
    commissionCents,
    netCents: revenueCents - commissionCents,
    rate,
  };
}

export function allocateCommissionCents(rides, rate) {
  const amounts = rides.map(ride => Number(
    ride.amountCents
    ?? ride.valorCentavos
    ?? Math.round(Number(ride.amount ?? ride.valor ?? 0) * 100),
  ));
  const totalCommissionCents = Math.round(
    amounts.reduce((sum, amount) => sum + amount, 0) * rate / 100,
  );
  const allocations = amounts.map((amount, index) => {
    const exact = amount * rate / 100;
    const base = Math.floor(exact);
    return { index, cents: base, fraction: exact - base };
  });
  let remainder = totalCommissionCents - allocations.reduce((sum, item) => sum + item.cents, 0);
  const priority = [...allocations].sort(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  );
  for (const item of priority) {
    if (remainder <= 0) break;
    allocations[item.index].cents += 1;
    remainder -= 1;
  }
  return allocations.map(item => item.cents);
}

export function createWeeklyDriverCalculation(
  driver,
  rides,
  start,
  end,
  revision = 1,
  calculatedAt = "",
) {
  const driverRides = rides
    .filter(ride => (
      ride.excludedFromTotals !== true
      && String(ride.driverId ?? ride.motoristaId) === String(driver.id)
      && (ride.date ?? ride.data) >= start
      && (ride.date ?? ride.data) <= end
    ))
    .map(ride => {
      const amountCents = Number(
        ride.amountCents
        ?? ride.valorCentavos
        ?? Math.round(Number(ride.amount ?? ride.valor ?? 0) * 100),
      );
      return {
        id: ride.id,
        date: ride.date ?? ride.data,
        time: ride.time ?? ride.horario ?? "",
        amountCents,
        fingerprint: ride.fingerprint
          ?? `${ride.id ?? "ride"}|${ride.date ?? ride.data}|${ride.time ?? ride.horario ?? ""}|${amountCents}`,
        source: ride.arquivo ? "WhatsApp" : "Manual",
        arquivo: ride.arquivo ?? "",
      };
    })
    .filter(ride => Number.isSafeInteger(ride.amountCents) && ride.amountCents > 0)
    .sort((left, right) => (
      left.date.localeCompare(right.date)
      || left.time.localeCompare(right.time)
      || left.fingerprint.localeCompare(right.fingerprint)
    ));
  const revenueCents = driverRides.reduce((sum, ride) => sum + ride.amountCents, 0);
  const rate = automaticCommission(driver, driverRides.length);
  const commissionCents = Math.round(revenueCents * rate / 100);
  const sourceFingerprint = JSON.stringify({
    rate,
    rides: driverRides.map(ride => [ride.fingerprint, ride.amountCents]),
  });

  return {
    driverId: driver.id,
    driverName: driver.nome,
    start,
    end,
    revision,
    calculatedAt,
    count: driverRides.length,
    revenueCents,
    rate,
    commissionCents,
    netCents: revenueCents - commissionCents,
    sourceFingerprint,
    rides: driverRides,
  };
}

function toISODate(day, month, year) {
  const fullYear = Number(year.length === 2 ? `20${year}` : year);
  const date = new Date(fullYear, Number(month) - 1, Number(day), 12);

  if (
    date.getFullYear() !== fullYear
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
  ) {
    return null;
  }

  return `${fullYear}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseMessageHeader(line) {
  const whatsappAndroid = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(?:(.+?):\s*(.*)|(.*))$/);
  const android = line.match(/^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]+):\s*(.*)$/);
  const ios = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*([^:]+):\s*(.*)$/);
  if (whatsappAndroid) {
    const [, day, month, year, time, sender, body, systemBody] = whatsappAndroid;
    const date = toISODate(day, month, year);
    return date ? {
      date,
      time,
      sender: sender?.trim() || "Sistema",
      body: (body ?? systemBody ?? "").trim(),
      isSystem: !sender,
    } : null;
  }

  const match = android ?? ios;
  if (!match) return null;
  const [, day, month, year, time, sender, body] = match;
  const date = toISODate(day, month, year);
  return date ? { date, time, sender: sender.trim(), body: body.trim(), isSystem: false } : null;
}

function normalizeCurrencyValue(raw) {
  const value = String(raw).trim();
  if (!value) {
    return NaN;
  }

  if (value.includes(",") && !value.includes(".")) {
    return Number(value.replace(",", "."));
  }

  if (value.includes(",")) {
    return Number(value.replace(/\./g, "").replace(",", "."));
  }

  if (value.includes(".")) {
    const groups = value.split(".");
    if (groups.length > 1 && groups[groups.length - 1].length === 3) {
      return Number(groups.join(""));
    }
    return Number(value);
  }

  return Number(value);
}

const PORTUGUESE_NUMBER_WORDS = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};
const PORTUGUESE_NUMBER_WORD_PATTERN = `${Object.keys(PORTUGUESE_NUMBER_WORDS).join("|")}|mil|e`;

function parsePortugueseIntegerWords(value) {
  const words = normalizeText(value).split(/\s+/);
  let total = 0;
  let group = 0;
  for (const word of words) {
    if (word === "e" || !word) continue;
    if (word === "mil") {
      total += (group || 1) * 1000;
      group = 0;
      continue;
    }
    if (!(word in PORTUGUESE_NUMBER_WORDS)) return null;
    group += PORTUGUESE_NUMBER_WORDS[word];
  }
  const result = total + group;
  return Number.isSafeInteger(result) ? result : null;
}

function writtenCurrencyAmounts(text) {
  const normalized = normalizeText(text);
  const word = `(?:${PORTUGUESE_NUMBER_WORD_PATTERN})`;
  const pattern = new RegExp(
    `\\b(${word}(?:\\s+${word}){0,12})\\s+reais?(?:\\s+e\\s+(${word}(?:\\s+${word}){0,5})\\s+centavos?)?\\b`,
    "g",
  );
  const amounts = [];
  for (const match of normalized.matchAll(pattern)) {
    const reais = parsePortugueseIntegerWords(match[1]);
    const cents = match[2] ? parsePortugueseIntegerWords(match[2]) : 0;
    if (reais === null || cents === null || cents > 99) continue;
    amounts.push(reais + cents / 100);
  }
  return amounts;
}

export function parseAmount(text) {
  const currencyPattern = /R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[,.]\d{1,2})?)/gi;
  const contextPattern = /(?:valor(?:\s+da\s+corrida)?|total(?:\s+da\s+corrida)?|pagou|recebeu|anota|lan[cç]a(?:r)?)\s*(?:e|é|:|-)?\s*(?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[,.]\d{1,2})?)/gi;
  const suffixPattern = /((?:\d{1,3}(?:\.\d{3})+|\d+)(?:[,.]\d{1,2})?)\s*(?:real|reais|BRL)\b/gi;
  const matches = [];

  const numericPattern = "(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:[,.]\\d{1,2})?";
  for (const pattern of [currencyPattern, contextPattern, suffixPattern]) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeCurrencyValue(match[1]);

      if (Number.isFinite(value) && value > 0) {
        matches.push(value);
      }
    }
    matches.push(...writtenCurrencyAmounts(text));
  }

  const trimmedText = String(text).trim();
  const standaloneMatch = trimmedText.match(new RegExp(`^(?:R\\$\\s*)?(${numericPattern})$`, "i"));
  if (standaloneMatch) {
    const value = normalizeCurrencyValue(standaloneMatch[1]);
    if (Number.isFinite(value) && value > 0) {
      matches.push(value);
    }
  }

  const unique = [...new Set(matches)];
  const value = unique.length === 1 ? unique[0] : null;
  return unique.length === 1 ? {
    value,
    amountCents: Math.round(value * 100),
    ambiguous: false,
  } : {
    value: null,
    amountCents: null,
    ambiguous: unique.length > 1,
  };
}

function driverMatches(text, drivers) {
  const normalized = normalizeText(text);
  const padded = ` ${normalized} `;
  return drivers.filter(driver => {
    if (isCentralName(driver.nome)) return false;
    const names = [driver.nome, ...(Array.isArray(driver.aliases) ? driver.aliases : [])]
      .map(normalizeText)
      .filter(Boolean);
    return names.some(name => padded.includes(` ${name} `));
  });
}

function isCentralName(name) {
  const normalized = normalizeText(name);
  return normalized.includes("xama mobilidade urbana")
    || normalized === "xama"
    || normalized.includes("central xama");
}

export function identifyDriverForConversation(source, messages, drivers, savedLinks = []) {
  const normalizedSource = normalizeText(
    `${source} ${messages.filter(message => !isCentralName(message.sender)).map(message => message.sender).join(" ")}`,
  );
  const linked = savedLinks.filter(link => {
    const label = normalizeText(link.label);
    return label && (` ${normalizedSource} `).includes(` ${label} `);
  });
  const linkedDriverIds = [...new Set(linked.map(link => String(link.driverId)))];
  if (linkedDriverIds.length > 1) {
    return { driverId: null, driverName: "", method: "vínculo ambíguo" };
  }
  if (linkedDriverIds.length === 1) {
    const driver = drivers.find(item => String(item.id) === linkedDriverIds[0]);
    if (driver) return { driverId: driver.id, driverName: driver.nome, method: "vinculo salvo" };
  }

  const fileMatches = driverMatches(source, drivers);
  if (fileMatches.length === 1) {
    return { driverId: fileMatches[0].id, driverName: fileMatches[0].nome, method: "nome da conversa" };
  }
  if (fileMatches.length > 1) {
    return { driverId: null, driverName: "", method: "nome ambíguo" };
  }

  const phoneSource = `${source} ${messages.map(message => `${message.sender} ${message.body}`).join(" ")}`;
  const detectedPhones = (String(phoneSource).match(/\+?\d[\d\s().-]{6,}\d/g) ?? [])
    .map(phone => phone.replace(/\D/g, ""))
    .filter(phone => phone.length >= 8);
  if (detectedPhones.length > 0) {
    const phoneMatches = drivers.filter(driver => {
      const phone = String(driver.telefone ?? driver.whatsapp ?? driver.celular ?? "").replace(/\D/g, "");
      return phone.length >= 8 && detectedPhones.some(digits => (
        digits.endsWith(phone) || phone.endsWith(digits)
      ));
    });
    if (phoneMatches.length === 1) {
      return { driverId: phoneMatches[0].id, driverName: phoneMatches[0].nome, method: "telefone" };
    }
    if (phoneMatches.length > 1) {
      return { driverId: null, driverName: "", method: "telefone ambíguo" };
    }
  }

  const senderNames = [...new Set(messages
    .filter(message => !isCentralName(message.sender))
    .map(message => message.sender.trim()))];
  const senderMatches = [...new Map(senderNames
    .flatMap(sender => driverMatches(sender, drivers))
    .map(driver => [driver.id, driver])).values()];
  if (senderMatches.length === 1) {
    return { driverId: senderMatches[0].id, driverName: senderMatches[0].nome, method: "remetente" };
  }
  if (senderMatches.length > 1) {
    return { driverId: null, driverName: "", method: "remetentes ambíguos" };
  }
  return { driverId: null, driverName: "", method: "não identificado" };
}

function identifyTripId(text) {
  const normalized = text.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  const match = normalized.match(/(?:corrida|viagem|trip)\s*(?:#|n[ºo.]?\s+)([a-z0-9-]+)/i)
    ?? normalized.match(/(?:id|identificador)\s*(?:da\s+)?(?:corrida|viagem)?\s*[:#-]\s*([a-z0-9-]+)/i);
  return match?.[1] ?? null;
}

export function fingerprintFile(text) {
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code;
    second = Math.imul(second, 2246822519);
  }
  return `wa-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function fingerprintRide(candidate, driverId = candidate.driverId) {
  return [
    candidate.date,
    driverId ?? "unknown",
    candidate.identity,
    candidate.classification ?? "corrida",
    candidate.amountCents ?? "sem-valor",
  ].join("|");
}

export function isBulkApprovableReview(review, drivers, approvedRides, batchRides = []) {
  const manualDriverReasons = new Set([
    "Motorista não identificado",
    "Mais de um motorista identificado",
  ]);
  const reasonIsManuallyResolvable = manualDriverReasons.has(review.reviewReason)
    && review.motoristaConfirmadoManualmente === true;
  if (
    review.classification !== "corrida"
    || review.hasRideContext !== true
    || (review.reviewReason != null
      && review.reviewReason !== ""
      && !reasonIsManuallyResolvable)
  ) {
    return false;
  }

  const date = String(review.date ?? "");
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return false;
  const [, year, month, day] = dateMatch;
  const parsedDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsedDate.getUTCFullYear() !== Number(year)
    || parsedDate.getUTCMonth() !== Number(month) - 1
    || parsedDate.getUTCDate() !== Number(day)
  ) {
    return false;
  }

  const driverId = review.driverIdRevisao || review.driverId;
  if (!drivers.some(driver => String(driver.id) === String(driverId))) return false;
  const amount = Number(review.valorRevisao);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const amountCents = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return false;
  const fingerprint = fingerprintRide({ ...review, amountCents }, driverId);
  const duplicate = [...approvedRides, ...batchRides].some(ride => (
    (ride.fingerprint && ride.fingerprint === fingerprint)
    || (review.hasTripId
      && ride.identity === review.identity
      && ride.date === review.date
      && String(ride.driverId) === String(driverId))
  ));
  return !duplicate;
}

export function filterBulkApprovableReviews(reviews, drivers, approvedRides) {
  const eligible = [];
  for (const review of reviews) {
    if (isBulkApprovableReview(review, drivers, approvedRides, eligible)) {
      const driverId = review.driverIdRevisao || review.driverId;
      const amountCents = Math.round(Number(review.valorRevisao) * 100);
      eligible.push({
        ...review,
        driverId,
        amountCents,
        fingerprint: fingerprintRide({ ...review, amountCents }, driverId),
      });
    }
  }
  return eligible;
}

export function parseWhatsAppMessages(text) {
  const messages = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const header = parseMessageHeader(line.replace(/^[\u200e\u200f]+/, ""));
    if (header) {
      messages.push(header);
    } else if (messages.length > 0) {
      messages[messages.length - 1].body += `\n${line}`;
    }
  }
  return messages;
}

function isDriverRideConfirmation(message) {
  if (isCentralName(message.sender)) return false;
  const body = normalizeText(message.body).replace(/\s+/g, " ").trim();
  if (/\b(cancelad[oa]|cancelamento|cancelar|desmarcad[oa]|nao)\b/.test(body)) {
    return false;
  }
  return /\b(ok(?:ay)?|blz|beleza|certo|sim|ta bom|confirmad[oa]|confirmo|fechado|combinado|show|top|pode ser|pode deixar|pode lancar|lanca pra mim|lanca para mim|pode passar|pode fazer|manda)\b/.test(body);
}

function isScheduledRide(text) {
  return /\b(agendad[oa]s?|agendar|agendamento|marcad[oa]s?|marcar)\b/.test(text);
}

function isRideCancellation(text) {
  return /\b(cancelad[oa]|cancelamento|cancelar|desmarcad[oa])\b/.test(text)
    || /\bnao\s+(?:saiu|apareceu)\s+ninguem\b|\bpassageiro\s+nao\s+(?:apareceu|veio)\b/.test(normalizeText(text));
}

function isCentralClarification(message) {
  const body = normalizeText(message.body).replace(/\s+/g, " ").trim();
  return isCentralName(message.sender)
    && body.length > 0
    && body.length <= 120
    && !/\b(uber|carro|corrida|embarque|buscar|pegar|levar|agendar|passageiro|preciso|poderia)\b/.test(body);
}

function isBareNumericAmount(message) {
  return /^\s*\d+(?:[,.]\d{1,2})?\s*$/.test(message.body);
}

function hasRideEvidence(text) {
  return /\b(a caminho|corridas?|viagens?|trips?|rides?|passageiros?|embarque|destino|uber|carro|buscar|pegar|levar|local|anota)\b/.test(text);
}

function annotatedFareAmounts(text) {
  const numericPattern = "(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:[,.]\\d{1,2})?";
  const listPattern = new RegExp(
    `\\banota\\b[^\\n]*?(${numericPattern}(?:\\s*\\$?\\s*\\+\\s*${numericPattern}\\s*\\$?)+)`,
    "i",
  );
  const listMatch = String(text).match(listPattern);
  if (listMatch) {
    return [...listMatch[1].matchAll(new RegExp(numericPattern, "g"))]
      .map(match => normalizeCurrencyValue(match[0]))
      .filter(value => Number.isFinite(value) && value > 0);
  }

  if (!/\banota\b/i.test(normalizeText(text))) return [];
  const amount = parseAmount(text);
  return amount.value === null ? [] : [amount.value];
}

function timeInMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
}

export function parseWhatsAppExport(text, drivers, conversationDriverId = null) {
  const messages = parseWhatsAppMessages(text);
  const contexts = [];
  const contextualMessageIndexes = new Set();
  let activeContext = null;
  let completedContext = null;
  messages.forEach((message, index) => {
    const normalizedBody = normalizeText(message.body);
    const isApproaching = /\ba caminho\b/.test(normalizedBody) && !isCentralName(message.sender);
    const isAvailable = /^\s*livre\b/.test(normalizedBody) && !isCentralName(message.sender);

    if (isApproaching) {
      if (activeContext) contexts.push(activeContext);
      completedContext = null;
      activeContext = { start: message, messages: [message], complete: false };
      contextualMessageIndexes.add(index);
      return;
    }

    if (activeContext) {
      activeContext.messages.push(message);
      contextualMessageIndexes.add(index);
      if (isAvailable) {
        activeContext.complete = true;
        contexts.push(activeContext);
        const hasFare = activeContext.messages.some(item => (
          parseAmount(item.body).value !== null
        ));
        completedContext = hasFare ? null : activeContext;
        activeContext = null;
      }
      return;
    }

    if (!completedContext) return;
    const fare = parseAmount(message.body);
    if (isCentralName(message.sender) && fare.value !== null) {
      completedContext.messages.push(message);
      contextualMessageIndexes.add(index);
      completedContext = null;
    } else {
      completedContext = null;
    }
  });
  if (activeContext) contexts.push(activeContext);

  const annotatedMessages = new Map();
  for (const [index, message] of messages.entries()) {
    if (isCentralName(message.sender) || contextualMessageIndexes.has(index)) continue;
    const amounts = annotatedFareAmounts(message.body);
    if (!amounts.length) continue;

    const amountCents = new Set(amounts.map(amount => Math.round(amount * 100)));
    const relatedIndexes = [];
    for (let candidateIndex = Math.max(0, index - 3); candidateIndex <= Math.min(messages.length - 1, index + 3); candidateIndex += 1) {
      if (
        candidateIndex === index
        || contextualMessageIndexes.has(candidateIndex)
        || !isCentralName(messages[candidateIndex].sender)
        || messages[candidateIndex].date !== message.date
        || Math.abs(timeInMinutes(messages[candidateIndex].time) - timeInMinutes(message.time)) > 5
      ) {
        continue;
      }

      const fare = parseAmount(messages[candidateIndex].body);
      if (fare.value !== null && amountCents.has(fare.amountCents)) {
        relatedIndexes.push(candidateIndex);
      }
    }

    relatedIndexes.forEach(relatedIndex => contextualMessageIndexes.add(relatedIndex));
    annotatedMessages.set(index, {
      amounts,
      relatedMessages: relatedIndexes.map(relatedIndex => messages[relatedIndex]),
    });
  }

  for (let index = 0; index < messages.length - 1; index += 1) {
    const fareMessage = messages[index];
    if (
      contextualMessageIndexes.has(index)
      || !isCentralName(fareMessage.sender)
    ) {
      continue;
    }
    const fare = parseAmount(fareMessage.body);
    if (fare.value === null || fare.ambiguous) continue;

    let responseIndex = null;
    let confirmation = null;
    let completionMessage = null;
    const interveningMessages = [];
    for (let candidateIndex = index + 1; candidateIndex < messages.length; candidateIndex += 1) {
      const candidate = messages[candidateIndex];
      if (candidate.isSystem) continue;
      if (
        candidate.date !== fareMessage.date
        || timeInMinutes(candidate.time) - timeInMinutes(fareMessage.time) > 60
        || contextualMessageIndexes.has(candidateIndex)
      ) {
        break;
      }

      const candidateText = normalizeText(candidate.body);
      const elapsedMinutes = timeInMinutes(candidate.time) - timeInMinutes(fareMessage.time);
      if (isRideCancellation(candidateText) || /\b(corrig\w*|correcao|retific\w*|errad[oa]|ajust\w*|na verdade|valor errado)\b/.test(candidateText)) {
        break;
      }
      if (isCentralName(candidate.sender)) {
        const repeatedFare = parseAmount(candidate.body);
        if (repeatedFare.value !== null) {
          if (repeatedFare.amountCents !== fare.amountCents || elapsedMinutes > 5) break;
          interveningMessages.push(candidate);
          continue;
        }
        if (!isCentralClarification(candidate)) break;
        interveningMessages.push(candidate);
        continue;
      }
      if (/^\s*a caminho\b/.test(candidateText)) break;
      if (/^\s*livre\b/.test(candidateText)) {
        completionMessage = candidate;
        responseIndex = candidateIndex;
        break;
      }
      if (isDriverRideConfirmation(candidate) && elapsedMinutes <= 5) {
        confirmation = candidate;
        responseIndex = candidateIndex;
        break;
      }
      if (candidate.body.trim().length <= 30) {
        interveningMessages.push(candidate);
        continue;
      }
      break;
    }
    if (responseIndex === null) continue;

    const relatedMessages = [];
    for (let relatedIndex = index - 1; relatedIndex >= 0; relatedIndex -= 1) {
      const related = messages[relatedIndex];
      if (
        related.isSystem
        || related.date !== fareMessage.date
        || timeInMinutes(fareMessage.time) - timeInMinutes(related.time) > 5
        || contextualMessageIndexes.has(relatedIndex)
      ) {
        break;
      }
      if (isCentralName(related.sender)) {
        if (parseAmount(related.body).value !== null) break;
      } else {
        const senderMatches = driverMatches(related.sender, drivers);
        const isConversationDriver = conversationDriverId === null
          ? senderMatches.length === 1
          : senderMatches.some(driver => String(driver.id) === String(conversationDriverId));
        if (
          !isConversationDriver
          || !/\b(corridas?|viagens?|trips?|rides?|anota|embarque|passageiros?)\b/.test(normalizeText(related.body))
        ) {
          break;
        }
      }
      relatedMessages.unshift(related);
      contextualMessageIndexes.add(relatedIndex);
      if (!isCentralName(related.sender)) break;
    }
    const followUpMessages = [];
    let completedAfterConfirmation = false;
    let followUpCount = 0;
    if (confirmation) {
      for (let relatedIndex = responseIndex + 1; relatedIndex < messages.length; relatedIndex += 1) {
        const related = messages[relatedIndex];
        if (related.isSystem) continue;
        if (related.date !== fareMessage.date) break;
        if (timeInMinutes(related.time) - timeInMinutes(confirmation.time) > 120) break;

        const followUpText = normalizeText(related.body);
        if (isRideCancellation(followUpText)) {
          followUpMessages.push(related);
          contextualMessageIndexes.add(relatedIndex);
          break;
        }
        if (/\b(corrig\w*|correcao|retific\w*|errad[oa]|ajust\w*|na verdade|valor errado)\b/.test(followUpText)) {
          followUpMessages.push(related);
          contextualMessageIndexes.add(relatedIndex);
          break;
        }
        if (
          !isCentralName(related.sender)
          && normalizeText(related.sender) === normalizeText(confirmation.sender)
          && /^\s*livre\b/.test(followUpText)
          && timeInMinutes(related.time) - timeInMinutes(confirmation.time) <= 120
        ) {
          followUpMessages.push(related);
          contextualMessageIndexes.add(relatedIndex);
          completedAfterConfirmation = true;
          break;
        }
        if (
          followUpCount < 4
          && isCentralClarification(related)
          && parseAmount(related.body).value === null
        ) {
          followUpMessages.push(related);
          contextualMessageIndexes.add(relatedIndex);
          followUpCount += 1;
          continue;
        }
        if (
          followUpCount < 4
          && !isCentralName(related.sender)
          && normalizeText(related.sender) === normalizeText(confirmation.sender)
          && isDriverRideConfirmation(related)
        ) {
          followUpMessages.push(related);
          contextualMessageIndexes.add(relatedIndex);
          followUpCount += 1;
          continue;
        }
        break;
      }
    }

    contexts.push({
      start: fareMessage,
      driverMessage: confirmation ?? completionMessage,
      messages: [
        ...relatedMessages,
        fareMessage,
        ...interveningMessages,
        ...(confirmation ? [confirmation, ...followUpMessages] : [completionMessage]),
      ],
      complete: Boolean(completionMessage) || completedAfterConfirmation,
      driverConfirmation: Boolean(confirmation),
      completionOnly: Boolean(completionMessage) && !confirmation,
    });
    contextualMessageIndexes.add(index);
    for (const relatedMessage of [...interveningMessages, confirmation, completionMessage, ...followUpMessages].filter(Boolean)) {
      const relatedIndex = messages.indexOf(relatedMessage);
      contextualMessageIndexes.add(relatedIndex);
    }
    index = responseIndex;
  }

  for (const [index, annotated] of annotatedMessages) {
    if (contextualMessageIndexes.has(index) || annotated.amounts.length !== 1) continue;
    const message = messages[index];
    const matchingContexts = contexts.filter(context => {
      if (!context.complete || context.start.date !== message.date) return false;
      const availableMessage = context.messages.find(item => (
        !isCentralName(item.sender) && /^\s*livre\b/.test(normalizeText(item.body))
      ));
      if (
        !availableMessage
        || normalizeText(availableMessage.sender) !== normalizeText(message.sender)
        || timeInMinutes(message.time) - timeInMinutes(availableMessage.time) < 0
        || timeInMinutes(message.time) - timeInMinutes(availableMessage.time) > 15
      ) {
        return false;
      }
      const contextFares = new Set(context.messages.flatMap(item => {
        const amount = parseAmount(item.body);
        return amount.value === null ? [] : [amount.amountCents];
      }));
      return contextFares.size === 1 && contextFares.has(Math.round(annotated.amounts[0] * 100));
    });
    if (matchingContexts.length === 1) {
      matchingContexts[0].messages.push(message);
      contextualMessageIndexes.add(index);
    }
  }

  const candidates = [];
  for (const context of contexts) {
    const combinedText = context.messages.map(message => message.body.trim()).filter(Boolean).join("\n");
    const normalizedText = normalizeText(combinedText).replace(/\s+/g, " ").trim();
    const fares = context.messages
      .map(message => parseAmount(message.body))
      .filter(amount => amount.value !== null || amount.ambiguous);
    const uniqueFares = [...new Set(fares.flatMap(amount => (
      amount.ambiguous ? [] : [amount.amountCents]
    )))];
    const hasAmbiguousFare = fares.some(amount => amount.ambiguous) || uniqueFares.length > 1;
    const amountCents = hasAmbiguousFare || uniqueFares.length !== 1 ? null : uniqueFares[0];
    const amount = amountCents === null ? null : amountCents / 100;
    const driverMessage = context.driverMessage
      ?? context.messages.find(message => isDriverRideConfirmation(message));
    const driverConfirmation = Boolean(driverMessage && isDriverRideConfirmation(driverMessage));
    const senderMatches = driverMatches(
      driverMessage?.sender ?? context.start.sender,
      drivers,
    );
    const conversationDriver = drivers.find(item => String(item.id) === String(conversationDriverId)) ?? null;
    const startDriver = senderMatches.length === 1 ? senderMatches[0] : null;
    const associatedDriver = conversationDriver ?? startDriver;
    const driverMismatch = Boolean(
      conversationDriver && startDriver && String(conversationDriver.id) !== String(startDriver.id),
    );
    const tripId = identifyTripId(combinedText);
    const identity = tripId
      ? `trip:${tripId}`
      : `message:${context.start.time}:${normalizeText(driverMessage?.sender ?? context.start.sender)}:${normalizedText}`;
    const cancellation = isRideCancellation(normalizedText);
    const correction = /\b(corrig\w*|correcao|retific\w*|errad[oa]|ajust\w*|na verdade|nao tinha colocado|coloquei errado|valor errado)\b/.test(normalizedText);
    const scheduledWithoutCompletion = isScheduledRide(normalizedText) && !context.complete;
    const classification = cancellation ? "cancelamento" : correction ? "correção" : "corrida";
    let reviewReason = null;

    if (cancellation) {
      reviewReason = "Cancelamento detectado; confirmar manualmente";
    } else if (correction) {
      reviewReason = "Correção de corrida detectada; conferir antes de substituir";
    } else if (scheduledWithoutCompletion) {
      reviewReason = "Corrida agendada sem confirmação de realização";
    } else if (driverMismatch) {
      reviewReason = "Motorista da mensagem diverge do motorista identificado na conversa";
    } else if (senderMatches.length > 1) {
      reviewReason = "Mais de um motorista identificado";
    } else if (!associatedDriver) {
      reviewReason = "Motorista não identificado";
    } else if (hasAmbiguousFare) {
      reviewReason = "Mais de um valor possível na mensagem";
    } else if (amountCents === null) {
      reviewReason = "Valor da corrida não identificado";
    } else if (context.completionOnly && !hasRideEvidence(normalizedText)) {
      reviewReason = "Sinal de Livre sem contexto suficiente da corrida";
    } else if (context.messages.some(isBareNumericAmount) && !hasRideEvidence(normalizedText)) {
      reviewReason = "Valor numérico sem contexto de corrida; conferir antes de aprovar";
    } else if (!context.complete && !driverConfirmation) {
      reviewReason = "Corrida sem sinal de término (Livre); conferir antes de aprovar";
    }

    candidates.push({
      date: context.start.date,
      time: context.start.time,
      sender: driverMessage?.sender ?? context.start.sender,
      text: combinedText,
      driverId: associatedDriver?.id ?? null,
      driverName: associatedDriver?.nome ?? null,
      amount,
      amountCents,
      identity,
      hasTripId: Boolean(tripId),
      hasRideContext: true,
      confirmed: !reviewReason && !cancellation && !correction,
      confirmationSignal: driverConfirmation ? "resposta do motorista" : context.complete ? "conversa concluída" : null,
      classification,
      fingerprint: fingerprintRide({
        date: context.start.date,
        identity,
        classification,
        amountCents,
      }, associatedDriver?.id),
      reviewReason,
    });
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (contextualMessageIndexes.has(messageIndex)) continue;
    if (message.isSystem) continue;
    const normalizedBody = normalizeText(message.body).replace(/\s+/g, " ").trim();
    const referencesTrip = /\b(corrida|viagem|trip|ride|passageiro|embarque|servico|anota)\b/.test(normalizedBody);
    const amount = parseAmount(message.body);
    const cancellation = isRideCancellation(normalizedBody);
    const correction = /\b(corrig\w*|correcao|retific\w*|errad[oa]|ajust\w*|na verdade|nao tinha colocado|coloquei errado|valor errado)\b/.test(normalizedBody);
    const confirmation = /\b(confirmad[oa]|confirmo|confirmando|recebid[oa]|repetid[oa])\b/.test(normalizedBody);
    const annotated = annotatedMessages.get(messageIndex);
    if (!referencesTrip && amount.value === null && !amount.ambiguous && !cancellation && !correction && !confirmation) {
      continue;
    }

    const senderDrivers = driverMatches(message.sender, drivers);
    const mentionedDrivers = driverMatches(message.body, drivers);
    const explicitMatches = isCentralName(message.sender) ? [] : senderDrivers;
    const matches = explicitMatches.length ? explicitMatches : mentionedDrivers;
    const conversationDriver = drivers.find(item => String(item.id) === String(conversationDriverId)) ?? null;
    const driver = matches.length === 1 ? matches[0] : null;
    const associatedDriver = conversationDriver ?? driver;
    const tripId = identifyTripId(message.body);
    let reviewReason = null;

    if (cancellation) {
      reviewReason = "Cancelamento detectado; confirmar manualmente";
    } else if (correction) {
      reviewReason = "Correção de corrida detectada; conferir antes de substituir";
    } else if (isScheduledRide(normalizedBody)) {
      reviewReason = "Corrida agendada sem confirmação de realização";
    } else if (confirmation) {
      reviewReason = "Possível confirmação/repetição; não contar como nova corrida sem conferência";
    } else if (matches.length > 1) {
      reviewReason = "Mais de um motorista identificado";
    } else if (conversationDriver && driver && conversationDriver.id !== driver.id) {
      reviewReason = "Motorista da mensagem diverge do motorista identificado na conversa";
    } else if (!associatedDriver) {
      reviewReason = "Motorista não identificado";
    } else if (amount.ambiguous) {
      reviewReason = "Mais de um valor possível na mensagem";
    } else if (amount.value === null) {
      reviewReason = "Valor da corrida não identificado";
    } else if (!referencesTrip || isCentralName(message.sender)) {
      reviewReason = "Mensagem com valor, mas sem referência explícita a corrida";
    }

    const identity = tripId
      ? `trip:${tripId}`
      : `message:${message.time}:${normalizeText(message.sender)}:${normalizedBody}`;

    const fareAmounts = annotated?.amounts ?? [amount.value];
    for (const [fareIndex, fareValue] of fareAmounts.entries()) {
      const fareCents = fareValue === null ? null : Math.round(fareValue * 100);
      const hasMultipleAnnotatedFares = Boolean(annotated && fareAmounts.length > 1);
      const candidateIdentity = hasMultipleAnnotatedFares
        ? `${identity}:fare-${fareIndex + 1}`
        : identity;
      const candidateReviewReason = hasMultipleAnnotatedFares && !cancellation && !correction
        ? "Anotação com várias tarifas; confira cada corrida antes de aprovar"
        : reviewReason;
      const relatedText = annotated?.relatedMessages.length
        ? `\nMensagens relacionadas: ${annotated.relatedMessages.map(item => item.body.trim()).join(" | ")}`
        : "";

      candidates.push({
        date: message.date,
        time: message.time,
        sender: message.sender,
        text: `${message.body.trim()}${relatedText}${hasMultipleAnnotatedFares ? `\nTarifa ${fareIndex + 1} de ${fareAmounts.length}` : ""}`,
        driverId: associatedDriver?.id ?? null,
        driverName: associatedDriver?.nome ?? null,
        amount: fareValue,
        amountCents: fareCents,
        identity: candidateIdentity,
        hasTripId: Boolean(tripId),
        hasRideContext: referencesTrip,
        classification: cancellation ? "cancelamento" : correction ? "correção" : confirmation ? "confirmação" : "corrida",
        fingerprint: fingerprintRide({
          date: message.date,
          identity: candidateIdentity,
          classification: cancellation ? "cancelamento" : correction ? "correção" : confirmation ? "confirmação" : "corrida",
          amountCents: fareCents,
        }, associatedDriver?.id),
        reviewReason: candidateReviewReason,
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.fingerprint)) {
      continue;
    }
    seen.add(candidate.fingerprint);
    unique.push(candidate);
  }

  return unique;
}

export function countWhatsAppMessages(text) {
  return parseWhatsAppMessages(text).length;
}

export function identifyDriversInExport(text, drivers) {
  const identified = new Map();
  for (const message of parseWhatsAppMessages(text)) {
    if (isCentralName(message.sender)) continue;
    for (const driver of [
      ...driverMatches(message.sender, drivers),
      ...driverMatches(message.body, drivers),
    ]) {
      identified.set(driver.id, driver.nome);
    }
  }
  return [...identified.values()];
}
