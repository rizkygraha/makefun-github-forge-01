// mcp.ts — a Model Context Protocol endpoint at /mcp speaking JSON-RPC 2.0 over plain
// HTTP POST (SSE is optional and not used). The suite's checks (checks-mcp.ts) drive it
// through both the modern `server/discover` era (protocol 2026-07-28) and the legacy
// `initialize` handshake, and call six tools over the same store the REST and GraphQL
// endpoints use, so an issue created through MCP is visible through REST and vice versa.

import { VIEWER_LOGIN, type Store } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the branch with the changes.' },
        base: { type: 'string', description: 'Name of the branch to merge into.' },
        body: { type: 'string', description: 'Body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((tool) => tool.name === lower)
    ?? TOOLS.find((tool) => lower.endsWith(`_${tool.name}`) || lower.endsWith(tool.name));
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  const missing = missingRequired(tool, args);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: false,
        default_branch: repo.defaultBranch,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: false,
        default_branch: repo.defaultBranch,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult({
        id: issue.dbId,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        body: issue.body,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({
          id: issue.dbId,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          body: issue.body,
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
        }));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (store.resolveRef(repo, head) === null || store.resolveRef(repo, base) === null) {
        return toolError(`Head or base branch does not exist`);
      }
      if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
        return toolError('A pull request already exists for these branches');
      }
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult({
        id: pull.dbId,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: pull.head,
        base: pull.base,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const pull = store.findPull(repo, Number(args.pull_number));
      if (!pull) return toolError(`Pull request ${args.pull_number} not found`);
      const outcome = store.squashMerge(repo, pull);
      if (!outcome.ok) return toolError(outcome.reason);
      return toolResult({ merged: true, sha: outcome.sha, message: 'Pull request successfully merged' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one JSON-RPC request object. `parsed` is false when the request body was not
 * valid JSON (the parse-error check: HTTP 400 with -32700). Notifications (no `id`)
 * answer 202 with no body.
 */
export function handleMcp(store: Store, body: unknown, parsed: boolean): McpResult {
  if (!parsed) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  const params = (request.params as Record<string, unknown> | undefined) ?? {};

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS[0],
        supportedVersions: PROTOCOL_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const result = callTool(store, name, args);
      if (result.isError === true) {
        // A tool-level error is reported as a result with isError, never as an
        // HTTP 500 or a JSON-RPC error, except for an unknown tool name.
        if (typeof result.content === 'object' && Array.isArray(result.content) && result.content[0] !== undefined) {
          const text = (result.content[0] as Record<string, unknown>).text;
          if (typeof text === 'string' && text.startsWith('Unknown tool:')) {
            return rpcError(id, -32601, text);
          }
        }
        return rpcResult(id, result);
      }
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
