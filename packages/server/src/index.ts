import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT } from "@claude-chrome/protocol";
import { stderrLogger } from "./bridge.js";
import { BridgeManager } from "./manager.js";
import { TOKEN_PATH, loadOrCreateToken } from "./token.js";
import { registerTools } from "./tools.js";
import { uploadPolicyFromEnv } from "./uploads.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const token = loadOrCreateToken();
  const command = process.argv[2];

  // `claude-chrome-mcp token` prints the pairing token for pasting into the extension popup.
  if (command === "token") {
    process.stdout.write(token + "\n");
    return;
  }
  if (command && command !== "serve") {
    process.stderr.write(`Unknown command "${command}". Usage: claude-chrome-mcp [serve|token]\n`);
    process.exit(2);
  }

  const port = Number(process.env.CLAUDE_CHROME_PORT ?? DEFAULT_PORT);
  const manager = new BridgeManager({
    port,
    token,
    extensionId: process.env.CLAUDE_CHROME_EXTENSION_ID,
    pairingHint: `Install/enable the extension and paste the token from ${TOKEN_PATH} into its popup (port ${port}).`,
    log: stderrLogger,
  });

  const server = new McpServer({ name: "local-chrome", version: VERSION });
  registerTools(server, manager, uploadPolicyFromEnv());
  await server.connect(new StdioServerTransport());

  // Claim the port right away so the extension can connect before the first tool call.
  manager.get().catch((error) => stderrLogger(`bridge startup failed: ${error.message}`));

  const shutdown = async () => {
    await manager.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  stderrLogger(`fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
