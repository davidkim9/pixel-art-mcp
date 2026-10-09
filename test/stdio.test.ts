import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { tempDir } from "./helpers.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Starts the real CLI entry point (from source) as a subprocess. */
async function startStdio(cwd: string, env?: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), path.join(repo, "src/index.ts")],
    cwd,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function exportDot(client: Client): Promise<string[]> {
  await client.callTool({ name: "load_palette", arguments: { name: "pico8", source: "builtin:pico8" } });
  await client.callTool({ name: "create_document", arguments: { name: "dot", kind: "sprite", width: 8, height: 8 } });
  await client.callTool({ name: "draw_grid", arguments: { docId: "doc_1", x: 0, y: 0, rows: ["ab"], legend: { a: 8, b: 9 } } });
  const exported = (await client.callTool({ name: "export_png", arguments: { docId: "doc_1" } })) as { content: Array<{ text?: string }> };
  return JSON.parse(exported.content[0]!.text!).files;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
}

describe("stdio server and project folder", () => {
  it("serves tools over stdio and uses the directory it starts in, with exports in ./assets", async () => {
    const project = tempDir();
    const client = await startStdio(project);
    try {
      expect(client.getServerVersion()?.name).toBe("pixel-art-mcp");
      expect(client.getInstructions()).toMatch(/palette index/);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(80);
      expect(tools.find((t) => t.name === "draw_grid")!.inputSchema.required).toEqual(expect.arrayContaining(["docId", "x", "y", "rows", "legend"]));
      expect(tools.find((t) => t.name === "render_preview")!.annotations?.readOnlyHint).toBe(true);
      const preview = (await client.callTool({ name: "render_palette", arguments: { id: "pico8" } })) as { content: Array<{ type: string }> };
      expect(preview.content.map((c) => c.type)).toEqual(["text"]); // palette not loaded yet → error text only
      expect(await exportDot(client)).toEqual(["assets/dot.png", "assets/dot.json"]);
      expect(fs.existsSync(path.join(project, "assets/dot.png"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("prefers the project directory Claude Code passes in CLAUDE_PROJECT_DIR over the working directory", async () => {
    const project = tempDir();
    const elsewhere = tempDir();
    const client = await startStdio(elsewhere, { CLAUDE_PROJECT_DIR: project });
    try {
      expect(await exportDot(client)).toEqual(["assets/dot.png", "assets/dot.json"]);
      expect(fs.existsSync(path.join(project, "assets/dot.png"))).toBe(true);
      expect(fs.existsSync(path.join(elsewhere, "assets"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("can read files from directories the client shares as MCP roots", async () => {
    const project = tempDir();
    const shared = tempDir();
    fs.writeFileSync(path.join(shared, "pal.hex"), "ff0000\n00ff00\n");
    const { server, project: state } = createServer(project);
    const client = new Client({ name: "roots", version: "1.0.0" }, { capabilities: { roots: { listChanged: true } } });
    let roots = [{ uri: pathToFileURL(shared).href, name: "shared art" }];
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await waitFor(() => state.clientRoots.length === 1);
      const ok = (await client.callTool({ name: "load_palette", arguments: { name: "shared", source: path.join(shared, "pal.hex") } })) as { isError?: boolean };
      expect(ok.isError).toBeFalsy();
      roots = [];
      await client.sendRootsListChanged();
      await waitFor(() => state.clientRoots.length === 0);
      const denied = (await client.callTool({ name: "load_palette", arguments: { name: "shared2", source: path.join(shared, "pal.hex") } })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
      expect(denied.isError).toBe(true);
      expect(denied.content[0]!.text).toMatch(/Access denied/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
