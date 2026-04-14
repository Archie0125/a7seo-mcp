#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, detectProviders } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { registerAllTools } from './register-tools.js';

async function main() {
  const config = loadConfig();
  const providers = detectProviders(config);

  console.error(`[a7seo-mcp] Starting...`);
  console.error(`[a7seo-mcp] Project: ${config.projectId}`);
  console.error(`[a7seo-mcp] Domain: ${config.domain}`);
  console.error(`[a7seo-mcp] Language: ${config.language}, Region: ${config.region}`);
  console.error(`[a7seo-mcp] Providers: ${providers.join(', ')}`);
  console.error(`[a7seo-mcp] DB: ${config.dbPath}`);

  const db = getDb(config.dbPath);

  const server = new McpServer({
    name: 'a7seo-mcp',
    version: '0.1.0',
  });

  registerAllTools(server, config, db);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[a7seo-mcp] Ready. ${providers.length} providers, tools registered.`);

  // Graceful shutdown
  process.on('SIGINT', () => {
    closeDb();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[a7seo-mcp] Fatal error:', err);
  process.exit(1);
});
