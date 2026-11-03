import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAIHttpHandler } from "./aiHttp.js";

test("local HTTP API exposes status and analysis routes", async t => {
  const server = createServer(createAIHttpHandler({
    status: () => ({ ready: true, model: "test-model", missing: [] }),
    analyze: async body => ({
      rides: [],
      unresolved: [],
      unclassified: [],
      receivedDriver: body.driverName,
    }),
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const statusResponse = await fetch(`${baseUrl}/api/ai/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).ready, true);

  const analysisResponse = await fetch(`${baseUrl}/api/whatsapp/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driverName: "Ana" }),
  });
  assert.equal(analysisResponse.status, 200);
  assert.equal((await analysisResponse.json()).receivedDriver, "Ana");
});

test("local HTTP API returns explicit errors for unavailable analysis", async t => {
  const server = createServer(createAIHttpHandler({
    status: () => ({ ready: false, missing: ["GEMINI_API_KEY"] }),
    analyze: async () => {
      const error = new Error("Configure GEMINI_API_KEY.");
      error.code = "AI_NOT_CONFIGURED";
      throw error;
    },
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/whatsapp/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Configure GEMINI_API_KEY.");
});

test("analysis route streams progress before its result", async t => {
  const server = createServer(createAIHttpHandler({
    status: () => ({ ready: true, connected: false, missing: [] }),
    analyze: async (_body, { onProgress }) => {
      onProgress({ stage: "analyzing", completedChunks: 1, totalChunks: 2 });
      return { rides: [], unresolved: [], unclassified: [] };
    },
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/whatsapp/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({ driverName: "Ana" }),
  });
  const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line));

  assert.equal(response.status, 200);
  assert.equal(lines[0].type, "progress");
  assert.equal(lines[0].completedChunks, 1);
  assert.equal(lines[1].type, "result");
});
