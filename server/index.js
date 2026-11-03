import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAIHttpHandler } from "./aiHttp.js";
import { createDatabase, initializeDatabase } from "./database.js";
import { createProductionApi } from "./productionApi.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStaticFile(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const filePath = resolve(dist, `.${pathname}`);
  if (filePath !== dist && !filePath.startsWith(`${dist}${sep}`)) {
    response.writeHead(403).end("Acesso negado.");
    return;
  }
  const target = statSync(filePath, { throwIfNoEntry: false });
  const resolvedPath = target?.isFile() ? filePath : resolve(dist, "index.html");
  response.setHeader("Content-Type", mimeTypes[extname(resolvedPath)] ?? "application/octet-stream");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", resolvedPath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
  createReadStream(resolvedPath).pipe(response);
}

export function createAppServer({ pool = createDatabase(process.env), env = process.env } = {}) {
  const productionApi = createProductionApi({ pool, env });
  const aiHandler = createAIHttpHandler();
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (env.NODE_ENV === "production") {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (await productionApi.handle(request, response)) return;
      if (pathname === "/api/whatsapp/analyze" && env.NODE_ENV === "production") {
        const user = await productionApi.requireUser(request, response);
        if (!user) return;
      }
      if (pathname.startsWith("/api/")) {
        await aiHandler(request, response);
        return;
      }
      serveStaticFile(request, response);
    } catch (error) {
      console.error("Falha ao processar solicitação:", error?.code ?? error?.name ?? "Error");
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ error: "Não foi possível processar a solicitação." }));
      } else {
        response.end();
      }
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4179);
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL é obrigatória em produção. Nenhum dado foi carregado ou armazenado.");
  }
  const pool = createDatabase(process.env);
  const start = async () => {
    if (pool) await initializeDatabase(pool, process.env);
    const server = createAppServer({ pool, env: process.env });
    server.listen(port, "0.0.0.0", () => {
      console.log(`Xama CRM disponível na porta ${port}.`);
    });
    const close = async () => {
      server.close(() => {
        if (pool) void pool.end();
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  };
  start().catch(error => {
    console.error("Não foi possível iniciar o Xama CRM:", error?.message ?? "erro de inicialização");
    process.exitCode = 1;
  });
}
