#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

/**
 * Project folder: --root, else PIXEL_MCP_ROOT, else the project directory Claude Code
 * passes to MCP servers (CLAUDE_PROJECT_DIR), else the working directory.
 */
function parseArgs(argv: string[]): { root: string; outputDir?: string } {
  let root = process.env.PIXEL_MCP_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let outputDir = process.env.PIXEL_MCP_OUTPUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "--project") root = argv[++i] ?? root;
    else if (arg.startsWith("--root=")) root = arg.slice(7);
    else if (arg === "--output-dir") outputDir = argv[++i] ?? outputDir;
    else if (arg.startsWith("--output-dir=")) outputDir = arg.slice(13);
    else if (arg === "--help" || arg === "-h") {
      console.error(`${SERVER_NAME} ${SERVER_VERSION}\nUsage: pixel-art-mcp [--root <project dir>] [--output-dir <dir>]\n` +
        "The project folder defaults to Claude Code's project directory (CLAUDE_PROJECT_DIR) or the working directory.\n" +
        "Env: PIXEL_MCP_ROOT, PIXEL_MCP_OUTPUT_DIR. Communicates over stdio (MCP).");
      process.exit(0);
    }
  }
  return { root, outputDir };
}

async function main(): Promise<void> {
  const { root, outputDir } = parseArgs(process.argv.slice(2));
  const { server, project, tools } = createServer(root, outputDir ? { outputDir } : {});
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION}: ${tools.length} tools, project root ${project.root}, output ${project.outputDir}`);
}

main().catch((err) => {
  console.error(`${SERVER_NAME} failed to start:`, err);
  process.exit(1);
});
