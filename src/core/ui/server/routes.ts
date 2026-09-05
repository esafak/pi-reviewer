import type { IncomingMessage, ServerResponse } from "node:http";
import { applyConfigPatch } from "../../config.js";
import type { PiReviewerConfig } from "../../config.js";
import type { UIAction } from "./types.js";

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.byteLength;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      body += c;
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

const RouteId = {
  Home: "home",
  Ping: "ping",
  Config: "config",
  Action: "action",
} as const;

type RouteId = (typeof RouteId)[keyof typeof RouteId];
type HttpMethod = "GET" | "POST";

export type RouteDef = {
  readonly id: RouteId;
  readonly methods: readonly [HttpMethod, ...HttpMethod[]];
  readonly path: string;
};

export type PathSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

export type CompiledRoute = RouteDef & { readonly segments: readonly PathSegment[] };

type RouteMatch = {
  readonly id: RouteId;
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
};

const ROUTES = [
  { id: RouteId.Home, methods: ["GET"], path: "/" },
  { id: RouteId.Ping, methods: ["GET"], path: "/ping" },
  { id: RouteId.Config, methods: ["POST"], path: "/config" },
  { id: RouteId.Action, methods: ["POST"], path: "/action" },
] as const satisfies readonly RouteDef[];

export function compileRoute(route: RouteDef): CompiledRoute {
  if (!route.path.startsWith("/") || route.path.includes("?") || route.path.includes("#")) {
    throw new Error(`Invalid route path: ${route.path}`);
  }

  const methods = new Set(route.methods);
  if (methods.size !== route.methods.length) {
    throw new Error(`Duplicate methods for route: ${route.path}`);
  }

  const names = new Set<string>();
  const pathSegments = route.path === "" || route.path === "/" ? [] : route.path.slice(1).split("/");
  const segments = pathSegments.map((segment): PathSegment => {
    if (!segment.startsWith(":")) return { kind: "static", value: segment };
    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) {
      throw new Error(`Invalid or duplicate route parameter: ${route.path}`);
    }
    names.add(name);
    return { kind: "param", name };
  });

  return { ...route, segments };
}

function compileRoutes(routes: readonly RouteDef[]): readonly CompiledRoute[] {
  const compiled = routes.map(compileRoute);
  const definitions = new Set<string>();
  const ids = new Set<RouteId>();
  for (const route of compiled) {
    if (ids.has(route.id)) throw new Error(`Duplicate route ID: ${route.id}`);
    ids.add(route.id);
    for (const method of route.methods) {
      const definition = `${method} ${route.path}`;
      if (definitions.has(definition)) throw new Error(`Duplicate route: ${definition}`);
      definitions.add(definition);
    }
  }
  return compiled;
}

const COMPILED_ROUTES = compileRoutes(ROUTES);

function splitPath(pathname: string): string[] {
  return pathname === "/" ? [] : pathname.slice(1).split("/");
}

export type PathMatch =
  | { readonly params: Readonly<Record<string, string>> }
  | { readonly decodeError: true }
  | undefined;

export function matchPath(route: CompiledRoute, pathname: string): PathMatch {
  const requestSegments = splitPath(pathname);
  if (requestSegments.length !== route.segments.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, segment] of route.segments.entries()) {
    const requestSegment = requestSegments[index];
    if (segment.kind === "static") {
      if (requestSegment !== segment.value) return undefined;
      continue;
    }
    try {
      params[segment.name] = decodeURIComponent(requestSegment);
    } catch {
      return { decodeError: true };
    }
  }
  return { params };
}

function findRoute(req: IncomingMessage):
  | { readonly match: RouteMatch }
  | { readonly status: 400 | 404 | 405; readonly allow?: string }
{
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return { status: 400 };
  }

  const pathResults = COMPILED_ROUTES
    .map((route) => ({ route, params: matchPath(route, url.pathname) }));
  if (pathResults.some((result) => result.params !== undefined && "decodeError" in result.params)) return { status: 400 };
  const pathMatches = pathResults
    .filter((result): result is { route: CompiledRoute; params: { params: Readonly<Record<string, string>> } } =>
      result.params !== undefined && "params" in result.params,
    )
    .map((result) => ({ route: result.route, params: result.params.params }));
  if (pathMatches.length === 0) return { status: 404 };

  const method = req.method;
  const methodMatch = pathMatches.find((result) => result.route.methods.some((allowedMethod) => allowedMethod === method));
  if (!methodMatch) {
    const allow = [...new Set(pathMatches.flatMap((result) => result.route.methods))].join(", ");
    return { status: 405, allow };
  }
  return { match: { id: methodMatch.route.id, params: methodMatch.params, url } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigPatch(value: unknown): value is Partial<PiReviewerConfig> {
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (!["theme", "viewMode", "verbose", "minSeverity", "model", "thinking", "autoCollapseViewed", "branch"].includes(key)) {
      return false;
    }
    if (key === "theme" && item !== "dark" && item !== "light") return false;
    if (key === "viewMode" && item !== "split" && item !== "unified") return false;
    if (["verbose", "autoCollapseViewed"].includes(key) && typeof item !== "boolean") return false;
    if (["minSeverity", "thinking", "model", "branch"].includes(key) && typeof item !== "string") return false;
  }
  return true;
}

function isUIAction(value: unknown): value is UIAction {
  if (!isRecord(value) || !["send", "save", "save-and-send", "closed"].includes(value.type as string)) return false;
  if (!Array.isArray(value.decisions)) return false;
  if (value.globalComment !== undefined && typeof value.globalComment !== "string") return false;
  if (value.selectedGroups !== undefined && (!Array.isArray(value.selectedGroups) ||
    !value.selectedGroups.every((group) => typeof group === "string"))) return false;
  return value.decisions.every((decision) =>
    isRecord(decision) && typeof decision.index === "number" && Number.isInteger(decision.index) && decision.index >= 0 &&
    ["accept", "reject", "discuss"].includes(decision.decision as string) &&
    (decision.discussText === undefined || typeof decision.discussText === "string"),
  );
}

export function createRequestHandler(
  html: string,
  resolveOnce: (action: UIAction) => void,
  resetHeartbeat: () => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  async function handleHome(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  function handlePing(_req: IncomingMessage, res: ServerResponse): void {
    resetHeartbeat();
    res.writeHead(204);
    res.end();
  }

  async function handleConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const raw = await readBody(req);
      const patch: unknown = JSON.parse(raw);
      if (isConfigPatch(patch)) applyConfigPatch(patch);
    } catch (error) {
      res.writeHead(error instanceof BodyTooLargeError ? 413 : 400);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
  }

  async function handleAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const raw = await readBody(req);
      const action: unknown = JSON.parse(raw);
      if (!isUIAction(action)) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
      resolveOnce(action);
    } catch (error) {
      res.writeHead(error instanceof BodyTooLargeError ? 413 : 400);
      res.end();
    }
  }

  return async (req, res) => {
    const result = findRoute(req);
    if ("status" in result) {
      res.writeHead(result.status, result.allow ? { Allow: result.allow } : undefined);
      res.end();
      return;
    }

    switch (result.match.id) {
      case RouteId.Home:
        await handleHome(req, res);
        return;
      case RouteId.Ping:
        handlePing(req, res);
        return;
      case RouteId.Config:
        await handleConfig(req, res);
        return;
      case RouteId.Action:
        await handleAction(req, res);
        return;
      default: {
        const _exhaustive: never = result.match.id;
        void _exhaustive;
        res.writeHead(500);
        res.end();
      }
    }
  };
}
