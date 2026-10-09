import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("stdio server", () => {
  it("starts from the CLI entry point and serves tools over stdio", async () => {
    const root = tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(repo, "src/index.ts"), "--root", root, "--output-dir", "out"],
      cwd: repo,
      stderr: "pipe",
    });
    const client = new Client({ name: "smoke", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("pixel-art-mcp");
      expect(client.getInstructions()).toMatch(/palette index/);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(80);
      const drawGrid = tools.find((t) => t.name === "draw_grid")!;
      expect(drawGrid.inputSchema.required).toEqual(expect.arrayContaining(["docId", "x", "y", "rows", "legend"]));
      expect(tools.find((t) => t.name === "render_preview")!.annotations?.readOnlyHint).toBe(true);
      await client.callTool({ name: "load_palette", arguments: { name: "pico8", source: "builtin:pico8" } });
      await client.callTool({ name: "create_document", arguments: { name: "dot", kind: "sprite", width: 8, height: 8 } });
      const res = (await client.callTool({ name: "draw_grid", arguments: { docId: "doc_1", x: 0, y: 0, rows: ["ab"], legend: { a: 8, b: 9 }, preview: true } })) as {
        content: Array<{ type: string; mimeType?: string }>;
      };
      expect(res.content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(res.content[1]!.mimeType).toBe("image/png");
      await client.callTool({ name: "export_png", arguments: { docId: "doc_1" } });
      expect(fs.existsSync(path.join(root, "out/dot.png"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
