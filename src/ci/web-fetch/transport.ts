import { lookup as dnsLookup } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";

import { WebFetchError } from "./errors.js";

/**
 * The socket-level transport the URL reader drives.
 *
 * The reader does not use `fetch`. The connection has to go to an address the
 * reader has already checked, and `fetch` resolves the hostname itself, which
 * would be a second, unchecked lookup — a host that answers one address
 * publicly and another privately would slip through. The transport therefore
 * takes the address it must connect to and binds the socket to it through a
 * controlled lookup, while the hostname stays the TLS server name and the
 * certificate identity.
 */

/** One address a host answered with. */
export interface ResolvedAddress {
  /** The address, as a literal. */
  address: string;
  /** The address family. */
  family: 4 | 6;
}

/** Resolves a hostname to every address it answers with. */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * The lookup the socket connects through.
 *
 * It answers with the address the reader validated and nothing else, so the
 * socket cannot reach an address the reader did not check. The contract is
 * Node's own lookup contract, so a change to what Node passes is tracked
 * here rather than copied.
 */
export type PinnedLookup = LookupFunction;

/**
 * The headers the reader is allowed to send.
 *
 * The set is closed: the reader sends no credential, no cookie, and nothing
 * the model supplied, and the type says so where a caller would otherwise
 * have to remember.
 */
export type RequestHeaderName = "accept" | "accept-encoding" | "user-agent";

/**
 * The response headers the transport reports.
 *
 * A server sends the headers it sends, so an absent one is absent rather
 * than empty.
 */
export type ResponseHeaders = Readonly<Record<string, string | undefined>>;

/** What the transport is allowed to send. */
export interface TransportRequest {
  /** The location to open. */
  url: URL;
  /** The headers to send. The caller fixes them; nothing is model-supplied. */
  headers: Readonly<Record<RequestHeaderName, string>>;
  /** The address the socket must connect to. */
  address: ResolvedAddress;
  /** Aborts the request. */
  signal: AbortSignal;
}

/** What the transport returns. */
export interface TransportResponse {
  /** The status the server answered with. */
  status: number;
  /** The response headers, keyed by lowercased name. */
  headers: ResponseHeaders;
  /** The body, still encoded as the server sent it. */
  body: Readable;
}

/** The transport the reader drives. Injectable so tests never open a socket. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * The lookup that pins the socket to the address the reader validated.
 *
 * The hostname is accepted and ignored: it was already resolved, and the
 * answer is the one address the reader checked.
 */
export function pinnedLookup(address: ResolvedAddress): PinnedLookup {
  return (_hostname, options, callback) => {
    // Node asks for a list when it selects an address family itself, and for
    // one address otherwise; the answer is the same address either way.
    if (options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

/** The hostname of a URL, without the brackets an IPv6 literal carries. */
export function bareHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * The request options the transport makes.
 *
 * `autoSelectFamily` is Node's own socket option rather than a request one,
 * so the reader declares it explicitly: automatic address selection would ask
 * the lookup for a list of addresses, and the reader has already chosen one.
 */
export interface ReaderRequestOptions extends RequestOptions {
  autoSelectFamily?: boolean;
}

/**
 * The request the transport makes.
 *
 * The options are the security policy in one place: the socket is bound to
 * the address the reader checked, the hostname stays the certificate
 * identity, and no proxy, agent, or credential option is present — the
 * transport reads no proxy configuration from the environment, so an ambient
 * `HTTP_PROXY` cannot intercept the request.
 */
export function buildRequestOptions(request: TransportRequest): ReaderRequestOptions {
  const hostname = bareHostname(request.url.hostname);
  const options: ReaderRequestOptions = {
    hostname,
    port: request.url.port || 443,
    path: `${request.url.pathname}${request.url.search}`,
    method: "GET",
    headers: { ...request.headers },
    lookup: pinnedLookup(request.address),
    // Automatic address selection would ask the lookup for a list of
    // addresses; the reader has already chosen one.
    autoSelectFamily: false,
    signal: request.signal,
  };
  // An address literal has no name to present, so it carries no server name.
  if (!/^[0-9.]+$/.test(hostname) && !hostname.includes(":")) options.servername = hostname;
  return options;
}

/** The response headers, keyed by lowercased name with a single value each. */
function normalizeHeaders(headers: IncomingHttpHeaders): ResponseHeaders {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return normalized;
}

/** The transport over TLS, bound to the address the reader validated. */
export const httpsTransport: Transport = (request) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const outgoing = httpsRequest(buildRequestOptions(request), (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        body: response,
      });
    });
    outgoing.on("error", () => {
      reject(new WebFetchError("the page could not be reached"));
    });
  });

/**
 * The resolver the reader uses by default.
 *
 * Every address the host answers with is returned, so an answer that mixes a
 * public and a private address can be rejected whole rather than by the luck
 * of which entry the caller happened to read.
 */
export const systemResolver: HostResolver = (hostname) =>
  new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      const resolved: ResolvedAddress[] = [];
      for (const entry of addresses) {
        // The resolver answers with IPv4 and IPv6 addresses. An answer the
        // reader cannot place is one it cannot vouch for, so it is refused
        // rather than guessed at.
        if (entry.family !== 4 && entry.family !== 6) {
          reject(new Error("the resolver answered with an unusable address"));
          return;
        }
        resolved.push({ address: entry.address, family: entry.family });
      }
      resolve(resolved);
    });
  });
