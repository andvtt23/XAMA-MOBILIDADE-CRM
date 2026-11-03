import { createAIAnalyzer } from "./aiAnalysis.js";
import { createProductionApi } from "./productionApi.js";

const MAX_REQUEST_BYTES = 8_000_000;

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new Error("A conversa excedeu o limite de 8 MB para análise.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("O corpo da requisição não é um JSON válido.");
    error.statusCode = 400;
    throw error;
  }
}

export function createAIHttpHandler(analyzer = createAIAnalyzer()) {
  return async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/ai/status" && request.method === "GET") {
      sendJson(response, 200, analyzer.status());
      return;
    }
    if (url.pathname !== "/api/whatsapp/analyze") {
      sendJson(response, 404, { error: "Rota da API não encontrada." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Método não permitido." });
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (request.headers.accept?.includes("application/x-ndjson")) {
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        const onProgress = progress => {
          response.write(`${JSON.stringify({ type: "progress", ...progress })}\n`);
        };
        try {
          const result = await analyzer.analyze(body, { onProgress });
          response.end(`${JSON.stringify({ type: "result", result })}\n`);
        } catch (error) {
          response.end(`${JSON.stringify({
            type: "error",
            error: error.message || "Falha na análise da conversa.",
            code: error.code ?? "INVALID_REQUEST",
          })}\n`);
        }
        return;
      }

      const result = await analyzer.analyze(body);
      sendJson(response, 200, result);
    } catch (error) {
      const status = error.statusCode
        ?? (error.code === "AI_NOT_CONFIGURED" ? 503 : error.code ? 502 : 400);
      sendJson(response, status, {
        error: error.message || "Falha na análise da conversa.",
        code: error.code ?? "INVALID_REQUEST",
      });
    }
  };
}

export function createAIHttpMiddleware(analyzer = createAIAnalyzer()) {
  const handler = createAIHttpHandler(analyzer);
  const productionApi = createProductionApi({ pool: null });
  return async (request, response, next) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (!pathname.startsWith("/api/ai/") && pathname !== "/api/whatsapp/analyze") {
      if (await productionApi.handle(request, response)) return;
      next();
      return;
    }
    await handler(request, response);
  };
}
