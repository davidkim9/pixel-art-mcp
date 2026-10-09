import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { createServer } from "../src/server.js";
import type { Project } from "../src/project.js";

export interface CallResult {
  data: any;
  images: Buffer[];
  isError: boolean;
  text: string;
}

export interface Harness {
  root: string;
  project: Project;
  client: Client;
  tools: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  /** Like call, but throws if the tool returned an error. */
  ok(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

export function tempDir(prefix = "pixelmcp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startHarness(root = tempDir()): Promise<Harness> {
  const { server, project, tools } = createServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string; data?: string }>;
      isError?: boolean;
    };
    const textPart = res.content.find((c) => c.type === "text");
    const text = textPart?.text ?? "";
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    const images = res.content.filter((c) => c.type === "image").map((c) => Buffer.from(c.data!, "base64"));
    return { data, images, isError: res.isError === true, text };
  };
  return {
    root,
    project,
    client,
    tools,
    call,
    ok: async (name, args) => {
      const r = await call(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.text}`);
      return r;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Decodes a PNG with pngjs (independent reference decoder). */
export function pngjsDecode(buf: Buffer): { width: number; height: number; data: Buffer } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export const PICO8 = [
  "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
  "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
];
