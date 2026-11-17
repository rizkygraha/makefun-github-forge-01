// graphql.ts — a small GraphQL v4 executor for exactly the documents gh and
// github-mcp-server send (see checks-graphql.ts GRAPHQL_DOCUMENTS). It is not a
// general GraphQL server: it parses the operation documents the suite sends,
// validates field names against a fixed schema table, and resolves them from the
// store. Unknown fields answer HTTP 200 with an `errors` array naming the field;
// an unknown repository answers data.repository = null with no errors; a JSON array
// body answers an array of results in order.

import { VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') { i += 1; continue; }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') { out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16)); j += 4; }
          else if (esc !== undefined) out += esc;
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.') {
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
        tokens.push({ kind: 'int', value: Number(input.slice(i, j)) });
      } else {
        tokens.push({ kind: 'int', value: Number.parseInt(input.slice(i, j), 10) });
      }
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; required: boolean }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      operation = token.value;
      const maybeName = this.peek();
      if (maybeName.kind === 'name') name = this.next().value as string;
    }
    const variableDefinitions: Array<{ name: string; required: boolean }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let required = false;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') {
          this.next();
          required = true;
        }
        // Skip a default value (= ...) if present.
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          this.parseValue();
        }
        variableDefinitions.push({ name: varName, required });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selection };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next.kind === 'name') {
        // A named fragment spread: unsupported by the suite's documents; skip its name.
        this.next();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selection };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// -------------------------------------------------------------------------------------------
// schema table (only the fields the suite's documents use, plus the introspection lists)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | null;

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': return node.value;
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function typeOf(value: GqlValue): string {
  if (value === null || value === undefined) return 'Unknown';
  const t = (value as Record<string, unknown>).__typename;
  return typeof t === 'string' ? t : 'Unknown';
}

function executeSelection(parent: GqlValue, parentType: string, selections: SelectionNode[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
      const nested = executeSelection(parent, parentType, selection.selection, ctx);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const fieldType = parentType;
    const known = SCHEMA_FIELDS[fieldType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${fieldType}".` });
      continue;
    }
    const value = resolveField(parent, fieldType, field, ctx);
    out[field.alias ?? field.name] = value;
  }
  return out;
}

function resolveField(parent: GqlValue, parentType: string, field: FieldNode, ctx: GqlContext): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const sub = field.selection;

  const select = (value: GqlValue, type: string): unknown => {
    if (value === null || sub === null) return value;
    return executeSelection(value, type, sub, ctx);
  };

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return select({ __typename: 'User', login: VIEWER_LOGIN }, 'User');
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) ?? null : null;
      if (repo === null) return null;
      return select({ __typename: 'Repository', __repo: repo }, 'Repository');
    }
    if (field.name === 'node') {
      const id = args.id as string;
      const parsed = typeof id === 'string' ? store.parseGlobalId(id) : null;
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = store.findRepoByDbId(parsed.id);
        if (!repo) return null;
        return select({ __typename: 'Repository', __repo: repo }, 'Repository');
      }
      if (parsed.kind === 'Issue') {
        const found = store.findIssueByDbId(parsed.id);
        if (!found) return null;
        return select({ __typename: 'Issue', __repo: found.repo, __issue: found.issue }, 'Issue');
      }
      if (parsed.kind === 'PullRequest') {
        const found = store.findPullByDbId(parsed.id);
        if (!found) return null;
        return select({ __typename: 'PullRequest', __repo: found.repo, __pull: found.pull }, 'PullRequest');
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      const value: Record<string, unknown> = { __typename: '__Type', __typeName: name };
      return select(value, '__Type');
    }
  }

  if (parentType === 'Mutation') {
    return resolveMutation(field, args, sub, ctx);
  }

  if (parentType.endsWith('Payload')) {
    if (field.name === 'clientMutationId') return null;
    const raw = (parent as Record<string, unknown>)[field.name];
    if (raw === undefined) return null;
    const targetType = field.name === 'issue' ? 'Issue' : field.name === 'pullRequest' ? 'PullRequest' : field.name === 'commentEdge' ? 'IssueCommentEdge' : 'Unknown';
    return select(raw as GqlValue, targetType);
  }

  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') return select((parent as Record<string, unknown>).node as GqlValue, 'IssueComment');
    if (field.name === 'cursor') return '';
  }

  if (parentType === 'IssueComment') {
    if (field.name === 'id') return (parent as Record<string, unknown>).id ?? null;
    if (field.name === 'body') return (parent as Record<string, unknown>).body ?? null;
  }

  if (parentType === 'User') {
    if (field.name === 'login') return (parent as Record<string, unknown>).login ?? VIEWER_LOGIN;
    if (field.name === 'id') return store.globalId('User', 1000);
  }

  if (parentType === 'Repository') {
    const repo = (parent as Record<string, unknown>).__repo as Repo;
    switch (field.name) {
      case 'id': return store.globalId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'owner': return select({ __typename: 'User', login: repo.owner }, 'User');
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return select({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref');
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = store.findIssue(repo, args.number as number);
        if (!issue) return null;
        return select({ __typename: 'Issue', __repo: repo, __issue: issue }, 'Issue');
      }
      case 'issues': return issuesConnection(store, repo, args, sub, ctx);
      case 'pullRequests': return pullsConnection(store, repo, args, sub, ctx);
      case 'pullRequest': {
        const pull = store.findPull(repo, args.number as number);
        if (!pull) return null;
        return select({ __typename: 'PullRequest', __repo: repo, __pull: pull }, 'PullRequest');
      }
    }
  }

  if (parentType === 'Ref') {
    if (field.name === 'name') return (parent as Record<string, unknown>).name ?? null;
  }

  if (parentType === 'Issue') {
    const issue = (parent as Record<string, unknown>).__issue as Issue;
    switch (field.name) {
      case 'id': return store.globalId('Issue', issue.dbId);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
      case 'url': return `https://example.invalid/${(parent as Record<string, unknown>).__repo !== undefined ? `${((parent as Record<string, unknown>).__repo as Repo).owner}/${((parent as Record<string, unknown>).__repo as Repo).name}` : ''}/issues/${issue.number}`;
      case 'createdAt': return store.isoAt(issue.createdSeq);
      case 'updatedAt': return store.isoAt(issue.updatedSeq);
      case 'author': return select({ __typename: 'User', login: VIEWER_LOGIN }, 'User');
      case 'labels': return { nodes: issue.labels.map((name) => ({ name })) };
      case 'comments': return { nodes: issue.comments.map((comment) => ({ id: store.globalId('IssueComment', comment.id), body: comment.body })) };
    }
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection') {
    const conn = parent as Record<string, unknown>;
    if (field.name === 'nodes') {
      const nodes = (conn.nodes as GqlValue[]) ?? [];
      const nodeType = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => (sub === null ? node : executeSelection(node, nodeType, sub, ctx)));
    }
    if (field.name === 'edges') {
      const nodes = (conn.nodes as GqlValue[]) ?? [];
      const nodeType = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => {
        if (sub === null) return { node, cursor: '' };
        const edge: Record<string, unknown> = {};
        for (const sel of sub) {
          if (sel.kind !== 'field') continue;
          if (sel.field.name === 'node') {
            edge.node = sel.field.selection === null ? node : executeSelection(node, nodeType, sel.field.selection, ctx);
          } else if (sel.field.name === 'cursor') {
            edge.cursor = '';
          }
        }
        return edge;
      });
    }
    if (field.name === 'pageInfo') {
      const pageInfo = (conn.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
      return select({ __typename: 'PageInfo', ...pageInfo }, 'PageInfo');
    }
    if (field.name === 'totalCount') return (conn.nodes as unknown[])?.length ?? 0;
  }

  if (parentType === 'PullRequest') {
    const pull = (parent as Record<string, unknown>).__pull as Pull;
    const repo = (parent as Record<string, unknown>).__repo as Repo;
    switch (field.name) {
      case 'id': return store.globalId('PullRequest', pull.dbId);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'mergeable': return store.mergeableState(repo, pull);
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = store.pullFiles(repo, pull).slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path }));
        return select({ __typename: 'PullRequestChangedFileConnection', nodes: files, pageInfo: { hasNextPage: false, endCursor: null } }, 'PullRequestChangedFileConnection');
      }
    }
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return (parent as Record<string, unknown>).path ?? null;
  }

  if (parentType === 'PageInfo') {
    const pageInfo = parent as Record<string, unknown>;
    if (field.name === 'hasNextPage') return pageInfo.hasNextPage ?? false;
    if (field.name === 'hasPreviousPage') return pageInfo.hasPreviousPage ?? false;
    if (field.name === 'startCursor') return pageInfo.startCursor ?? null;
    if (field.name === 'endCursor') return pageInfo.endCursor ?? null;
  }

  if (parentType === '__Type') {
    const name = (parent as Record<string, unknown>).__typeName as string;
    if (field.name === 'name') return name;
    if (field.name === 'kind') return INTROSPECTION_FIELDS[name] !== undefined ? 'OBJECT' : INTROSPECTION_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const names = INTROSPECTION_FIELDS[name] ?? SCHEMA_FIELDS[name] ?? [];
      const list = names.map((fieldName) => ({ __typename: '__Field', name: fieldName }));
      if (sub === null) return list;
      return list.map((entry) => executeSelection(entry, '__Field', sub, ctx));
    }
    if (field.name === 'enumValues') {
      const names = INTROSPECTION_ENUMS[name] ?? [];
      const list = names.map((enumName) => ({ __typename: '__EnumValue', name: enumName }));
      if (sub === null) return list;
      return list.map((entry) => executeSelection(entry, '__EnumValue', sub, ctx));
    }
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (field.name === 'name') return (parent as Record<string, unknown>).name ?? null;
  }

  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>, sub: SelectionNode[] | null, ctx: GqlContext): unknown {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = cursorNumber(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const field = orderBy.field === 'UPDATED_AT' ? 'updatedSeq' : 'createdSeq';

  let issues = repo.issues.filter((issue) => {
    if (states === null) return true;
    return states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED');
  });
  issues = [...issues].sort((a, b) => {
    const diff = (a[field] - b[field]) * (direction === 'ASC' ? 1 : -1);
    if (diff !== 0) return diff;
    return (b.number - a.number) * (direction === 'ASC' ? -1 : 1);
  });
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const page = issues.slice(0, first);
  const nodes = page.map((issue) => ({ __typename: 'Issue', __repo: repo, __issue: issue }));
  const conn: Record<string, unknown> = {
    __typename: 'IssueConnection',
    nodes,
    pageInfo: {
      hasNextPage: issues.length > first,
      endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
  if (sub === null) return conn;
  return executeSelection(conn, 'IssueConnection', sub, ctx);
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>, sub: SelectionNode[] | null, ctx: GqlContext): unknown {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  let pulls = repo.pulls.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pulls.slice(0, first);
  const nodes = page.map((pull) => ({ __typename: 'PullRequest', __repo: repo, __pull: pull }));
  const conn: Record<string, unknown> = {
    __typename: 'PullRequestConnection',
    nodes,
    pageInfo: { hasNextPage: pulls.length > first, endCursor: null },
  };
  if (sub === null) return conn;
  return executeSelection(conn, 'PullRequestConnection', sub, ctx);
}

function resolveMutation(field: FieldNode, args: Record<string, unknown>, sub: SelectionNode[] | null, ctx: GqlContext): unknown {
  const store = ctx.store;
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const select = (value: GqlValue, type: string): unknown => {
    if (value === null || sub === null) return value;
    return executeSelection(value, type, sub, ctx);
  };

  if (field.name === 'createIssue') {
    const parsed = typeof input.repositoryId === 'string' ? store.parseGlobalId(input.repositoryId) : null;
    const repo = parsed?.kind === 'Repository' ? store.findRepoByDbId(parsed.id) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return select({ __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', __repo: repo, __issue: issue } }, 'CreateIssuePayload');
  }

  if (field.name === 'closeIssue') {
    const parsed = typeof input.issueId === 'string' ? store.parseGlobalId(input.issueId) : null;
    const found = parsed?.kind === 'Issue' ? store.findIssueByDbId(parsed.id) : undefined;
    if (!found) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedSeq = store.nextSeq();
    found.issue.updatedSeq = store.nextSeq();
    return select({ __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', __repo: found.repo, __issue: found.issue } }, 'CloseIssuePayload');
  }

  if (field.name === 'createPullRequest') {
    const parsed = typeof input.repositoryId === 'string' ? store.parseGlobalId(input.repositoryId) : null;
    const repo = parsed?.kind === 'Repository' ? store.findRepoByDbId(parsed.id) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (store.resolveRef(repo, head) === null || store.resolveRef(repo, base) === null) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
      ctx.errors.push({ message: 'createPullRequest: a pull request already exists for these branches' });
      return null;
    }
    const pull = store.createPull(repo, String(input.title ?? ''), '', head, base);
    return select({ __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', __repo: repo, __pull: pull } }, 'CreatePullRequestPayload');
  }

  if (field.name === 'mergePullRequest') {
    const parsed = typeof input.pullRequestId === 'string' ? store.parseGlobalId(input.pullRequestId) : null;
    const found = parsed?.kind === 'PullRequest' ? store.findPullByDbId(parsed.id) : undefined;
    if (!found) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    const outcome = store.squashMerge(found.repo, found.pull);
    if (!outcome.ok) {
      ctx.errors.push({ message: `mergePullRequest: ${outcome.reason}` });
      return null;
    }
    return select({ __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', __repo: found.repo, __pull: found.pull } }, 'MergePullRequestPayload');
  }

  if (field.name === 'addComment') {
    const parsed = typeof input.subjectId === 'string' ? store.parseGlobalId(input.subjectId) : null;
    const found = parsed?.kind === 'Issue' ? store.findIssueByDbId(parsed.id) : undefined;
    if (!found) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const comment = store.createComment(found.issue, String(input.body ?? ''), VIEWER_LOGIN);
    const node = { __typename: 'IssueComment', id: store.globalId('IssueComment', comment.id), body: comment.body };
    const edge = { __typename: 'IssueCommentEdge', node, cursor: '' };
    return select({ __typename: 'AddCommentPayload', commentEdge: edge }, 'AddCommentPayload');
  }

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// Mutation payload types need their fields known for validation of nested selections.
const PAYLOAD_FIELDS: Record<string, string[]> = {
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
};

// The generic executor does not know payload types; handle them in executeSelection by
// registering them in SCHEMA_FIELDS at module load.
for (const [type, fields] of Object.entries(PAYLOAD_FIELDS)) SCHEMA_FIELDS[type] = fields;

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: GqlContext = { store, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(null, rootType, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

/**
 * Handle POST /api/graphql. `body` is the parsed JSON request (object or array).
 * Returns the HTTP status and the JSON body to send.
 */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request must be an object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'GraphQL request has no query.' }] };
    }
    const variables = (record.variables as Record<string, unknown> | undefined) ?? {};
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'GraphQL document has no operation.' }] };
    }
    const operation = operations[0]!;
    // Validate required variables are present (a missing required variable is an error).
    for (const def of operation.variableDefinitions) {
      if (def.required && (variables[def.name] === undefined || variables[def.name] === null)) {
        return { data: null, errors: [{ message: `Variable $${def.name} of required type was not provided.` }] };
      }
    }
    return executeOperation(store, operation, variables);
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
