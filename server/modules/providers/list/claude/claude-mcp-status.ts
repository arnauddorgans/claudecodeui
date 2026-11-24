import type { AnyRecord, SessionMcpServer } from '@/shared/types.js';

/**
 * What a client may see of a live session's MCP servers. The SDK's
 * `mcpServerStatus()` rows carry each server's configuration, and that
 * configuration carries secrets: env values, headers (`Authorization`),
 * tokens in URLs and in arguments. Only the fields listed in
 * `SessionMcpServer` leave the server, and an error message — which can echo
 * a command line or a URL — only once redacted.
 */

const MAX_ERROR_LENGTH = 500;
const MAX_LABEL_LENGTH = 200;

const REDACTED = '[redacted]';
/** A value an earlier pattern already redacted, quoted or not, is left alone. */
const alreadyRedacted = (value: string): boolean => value.replace(/^["']/, '').startsWith('[redacted');

/** `scheme://user:pass@host/path?query#fragment`: userinfo, query and fragment go. */
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@"'<>]*@)?([^\s/?#"'<>]*)([^\s?#"'<>]*)(\?[^\s#"'<>]*)?(#[^\s"'<>]*)?/gi;
/** `Bearer <token>` / `Basic <credentials>`, wherever they appear. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[^\s"',;]+/gi;
/** `Authorization: …` up to the end of the value. */
const AUTHORIZATION_PATTERN = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
/** `-e NAME=value`, `--env NAME=value`, `--header "X: v"`, `-H X:v`. */
const FLAG_VALUE_PATTERN = /(^|\s)(-e|--env|-H|--header)(\s+|=)("[^"]*"|'[^']*'|\S+)/g;
/** `token=…`, `api_key: …`, `"secret": "…"`, `password=…`: a name that says secret, then its value. */
const SECRET_FIELD_PATTERN = /\b([\w.-]*(?:token|key|secret|password|passwd|pwd|auth|credential|session)[\w.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&"',;)}\]]+)/gi;
/** `NAME=value` in an environment-variable shape (`GITHUB_TOKEN=…`, `API_URL=…`). */
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g;
/** Well-known credential shapes, alone in a message. */
const KNOWN_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g;

/**
 * Redacts what may be a secret in a message from the SDK or a server: URL
 * userinfo and query strings, auth headers and schemes, `-e NAME=value`,
 * `token=`/`key=`-like fields, env assignments and well-known token shapes.
 * Errs on the side of hiding: a redacted word costs less than a leaked token.
 */
export function redactMcpMessage(message: string): string {
  let text = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  text = text.replace(URL_PATTERN, (_match, scheme: string, userinfo: string | undefined, host: string, pathPart: string, query: string | undefined) =>
    `${scheme}${userinfo ? `${REDACTED}@` : ''}${host}${pathPart}${query ? `?${REDACTED}` : ''}`);
  text = text.replace(AUTHORIZATION_PATTERN, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`);
  text = text.replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  text = text.replace(FLAG_VALUE_PATTERN, (_match, lead: string, flag: string, separator: string, value: string) => {
    const unquoted = value.replace(/^["']|["']$/g, '');
    const cut = unquoted.search(/[=:]/);
    const kept = cut > 0 ? `${unquoted.slice(0, cut + 1)}${REDACTED}` : REDACTED;
    return `${lead}${flag}${separator}${kept}`;
  });
  text = text.replace(SECRET_FIELD_PATTERN, (match, name: string, separator: string, value: string) =>
    (alreadyRedacted(value) ? match : `${name}${separator}${REDACTED}`));
  text = text.replace(ENV_ASSIGNMENT_PATTERN, (match, name: string, value: string) =>
    (alreadyRedacted(value) ? match : `${name}=${REDACTED}`));
  text = text.replace(KNOWN_TOKEN_PATTERN, REDACTED);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

const label = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.length > 0
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_LABEL_LENGTH)
    : undefined);

/** The transport a status row's config names; a stdio config may leave `type` out. */
function transportOf(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  const record = config as AnyRecord;
  if (typeof record.type === 'string' && record.type.length > 0) {
    return label(record.type);
  }
  return typeof record.command === 'string' ? 'stdio' : undefined;
}

/**
 * One SDK status row as a client may see it: name, status, the redacted
 * error, the server's own name and version, scope, transport and tool count.
 * The row's `config` is read for its transport only, never copied.
 */
export function describeMcpServer(row: AnyRecord): SessionMcpServer {
  const server: SessionMcpServer = {
    name: String(row.name),
    status: label(row.status) ?? 'pending',
  };
  if (typeof row.error === 'string' && row.error.length > 0) {
    server.error = redactMcpMessage(row.error);
  }
  const info = row.serverInfo;
  if (info && typeof info === 'object' && typeof info.name === 'string') {
    server.serverInfo = { name: label(info.name) ?? '', version: label(info.version) ?? '' };
  }
  const scope = label(row.scope);
  if (scope) {
    server.scope = scope;
  }
  const type = transportOf(row.config);
  if (type) {
    server.type = type;
  }
  if (Array.isArray(row.tools)) {
    server.toolCount = row.tools.length;
  }
  return server;
}

/** The rows of `mcpServerStatus()` a client may see, in the SDK's order. */
export function describeMcpServers(rows: unknown): SessionMcpServer[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is AnyRecord => Boolean(row) && typeof row === 'object' && typeof (row as AnyRecord).name === 'string')
    .map(describeMcpServer);
}

/** The names and statuses an `init` lists, as one comparable string. */
export function mcpFingerprint(servers: unknown): string | null {
  if (!Array.isArray(servers)) {
    return null;
  }
  return JSON.stringify(servers
    .filter((server) => server && typeof server === 'object')
    .map((server: AnyRecord) => [String(server.name), String(server.status)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
