import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError } from './paths';
import type { BridgeStateService } from './state';

/** The bridge's MCP tools — exactly these five, none of which writes notes (D23, D24, R8.8). */
export const BRIDGE_TOOL_NAMES = ['get_active_note', 'get_selection', 'list_open_notes', 'open_note', 'get_links'] as const;
export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];

export const BRIDGE_SERVER_INFO = { name: 'obsidian', title: 'Obsidian', version: '0.1.0' } as const;

const SERVER_INSTRUCTIONS =
  'Live view of the Obsidian app the user is working in. Your working directory is the vault root; every path is ' +
  'relative to it (e.g. "Projects/idea.md"). "The active note" is the note editor the user last focused — it stays the ' +
  'same while the user types in this terminal. These tools only read Obsidian state and open notes; to change a note, ' +
  'edit its .md file directly — Obsidian reloads it.';

const PATH_DESCRIPTION = 'Vault-relative path of the note, e.g. "Projects/idea.md" (the ".md" may be omitted). Absolute paths and ".." are rejected.';

type ToolHandler = () => Promise<CallToolResult> | CallToolResult;

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Runs a tool body; `BridgeError`s (bad path, not found) and unexpected failures become MCP tool errors. */
async function run(body: () => unknown): Promise<CallToolResult> {
  try {
    return json(await body());
  } catch (err) {
    if (err instanceof BridgeError) return toolError(err.message);
    return toolError(`Obsidian could not complete the request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Registers the five bridge tools on `server`, backed by the `bridgeState` service. */
export function registerBridgeTools(server: McpServer, state: BridgeStateService): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'get_active_note',
    {
      title: 'Get active note',
      description:
        'Returns the note the user last focused in Obsidian (their most recent note editor — clicking into this terminal ' +
        'does not change it): its vault-relative path, its full current text (including unsaved edits) and cursorLine, the ' +
        '1-based line of the cursor. Use it when the user says "this note", "my note" or "the open note". If no note has ' +
        'been focused yet, returns {"empty": true, "reason": …}.',
      annotations: readOnly,
    },
    (() => run(() => state.getActiveNote())) satisfies ToolHandler,
  );

  server.registerTool(
    'get_selection',
    {
      title: 'Get selected text',
      description:
        'Returns the text the user has selected in the note they last focused in Obsidian, with the note\'s vault-relative ' +
        'path and the 1-based fromLine / toLine (inclusive) of the selection. The selection is kept while the user types in ' +
        'this terminal. Use it when the user refers to "the selection", "the highlighted text" or "these lines". Returns ' +
        '{"text": "", "reason": …} when nothing is selected or no note has been focused.',
      annotations: readOnly,
    },
    (() => run(() => state.getSelection())) satisfies ToolHandler,
  );

  server.registerTool(
    'list_open_notes',
    {
      title: 'List open notes',
      description:
        'Lists the notes open in Obsidian tabs as [{"path", "active"}] with vault-relative paths; "active": true marks the ' +
        'note the user last focused.',
      annotations: readOnly,
    },
    (() => run(() => state.listOpenNotes())) satisfies ToolHandler,
  );

  server.registerTool(
    'open_note',
    {
      title: 'Open note in Obsidian',
      description:
        'Opens a note in Obsidian\'s main editor area so the user can see it, optionally scrolled to and highlighting a ' +
        '1-based line. Keyboard focus stays in the terminal. Use it to show the user a note or a passage you are talking ' +
        'about. It never changes the note. Errors if the path is outside the vault or the note does not exist.',
      inputSchema: {
        path: z.string().describe(PATH_DESCRIPTION),
        line: z.number().int().min(1).optional().describe('1-based line to scroll to (optional).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ path, line }) => run(() => state.openNote(path, line)),
  );

  server.registerTool(
    'get_links',
    {
      title: 'Get links and backlinks',
      description:
        'Returns Obsidian\'s link graph for one note: "outgoing" = notes and files it links to, "backlinks" = notes that ' +
        'link to it, all as vault-relative paths. Comes from Obsidian\'s metadata cache, so [[wikilinks]], aliases and ' +
        'relative links are already resolved. Errors if the path is outside the vault or the note does not exist.',
      inputSchema: { path: z.string().describe(PATH_DESCRIPTION) },
      annotations: readOnly,
    },
    ({ path }) => run(() => state.getLinks(path)),
  );
}

/** A fresh MCP server exposing the bridge tools (one per HTTP request in stateless mode). */
export function createBridgeMcpServer(state: BridgeStateService): McpServer {
  const server = new McpServer(BRIDGE_SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  registerBridgeTools(server, state);
  return server;
}
