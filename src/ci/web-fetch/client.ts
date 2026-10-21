import type { Readable } from "node:stream";
import { createBrotliDecompress, createUnzip } from "node:zlib";

import { addressFamily, checkUrlAdmissibility, isBlockedAddress } from "./admissibility.js";
import { WebFetchError } from "./errors.js";
import { truncateUtf8WithMarker } from "../registry/helpers.js";
import {
  bareHostname,
  httpsTransport,
  systemResolver,
  type HostResolver,
  type RequestHeaderName,
  type ResolvedAddress,
  type Transport,
  type TransportResponse,
} from "./transport.js";

/**
 * The bounded URL reader.
 *
 * The reader fetches one document and returns its text. It does not browse:
 * it opens no other links, runs no script, sends no credential, and never
 * authenticates. Everything it returns is untrusted content.
 */

/** The limits the reader enforces on one run. */
export interface WebFetchLimits {
  /** Requests allowed per run. A redirect hop is a request. */
  maxRequests: number;
  /** Decoded bytes allowed across the whole run. */
  maxTotalBytes: number;
  /** Decoded bytes allowed for one document. */
  maxDocumentBytes: number;
  /** Bytes of one document handed to the model. */
  maxResultBytes: number;
  /** Redirect hops allowed per fetch. */
  maxRedirects: number;
  /** Milliseconds one fetch may take, covering resolution through body. */
  deadlineMs: number;
  /** Fetches allowed to run at once. */
  maxConcurrent: number;
}

/** The reader's default limits. */
export const DEFAULT_WEB_FETCH_LIMITS: WebFetchLimits = {
  maxRequests: 8,
  maxTotalBytes: 128 * 1024,
  maxDocumentBytes: 64 * 1024,
  maxResultBytes: 16 * 1024,
  maxRedirects: 3,
  deadlineMs: 10_000,
  maxConcurrent: 2,
};

/** The content types the reader returns. */
const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
]);

/**
 * The headers the reader sends.
 *
 * The set is fixed: the reader sends no credential, no cookie, and nothing the
 * model supplied. The action's GitHub token is never attached, so a fetched
 * page cannot read it.
 */
export const REQUEST_HEADERS: Readonly<Record<RequestHeaderName, string>> = {
  accept: "text/html,text/plain,text/markdown,application/json,application/xml,text/xml",
  "accept-encoding": "gzip, deflate, br",
  "user-agent": "pi-reviewer-url-reader",
};

/** What one fetch produced. */
export interface WebFetchResult {
  /** The location the content came from, after any redirect. */
  url: string;
  /** The status the final response carried. */
  status: number;
  /** The media type of the document. */
  contentType: string;
  /** The document's text, capped for the model. */
  text: string;
  /** True when the document was cut short, so the model read only part of it. */
  truncated: boolean;
  /** Requests still available in this run. */
  remainingRequests: number;
}

/** The reader's contract. */
export interface WebFetchClient {
  /** Fetches one location and returns its text. */
  fetch(url: string): Promise<WebFetchResult>;
}

/** How the reader is built. */
export interface WebFetchClientOptions {
  /** The transport the socket goes through. */
  transport?: Transport;
  /** The resolver the hostname goes through. */
  resolveHost?: HostResolver;
  /** The limits the reader enforces. */
  limits?: Partial<WebFetchLimits>;
}

/**
 * Races a promise against the fetch's deadline.
 *
 * The transport is expected to honor the signal, but a transport that does
 * not must not hold the run open: the deadline is the reader's, not the
 * transport's.
 */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebFetchError("the request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WebFetchError("the request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The decoded text of a document.
 *
 * A document that is not valid UTF-8 is refused rather than repaired: the
 * reader would parse the repaired text as if it were the document, and a
 * replacement character in a release note is a character nobody published.
 * A document that was cut mid-character is the one exception — the cut is the
 * reader's own, so the incomplete tail is dropped.
 */
function decodeUtf8(bytes: Buffer, allowPartialTail: boolean): string | undefined {
  const decode = (value: Buffer): string => new TextDecoder("utf-8", { fatal: true }).decode(value);
  try {
    return decode(bytes);
  } catch {
    if (!allowPartialTail) return undefined;
    // The reader's own cut can land inside a character; at most three bytes
    // of a UTF-8 sequence are missing.
    for (let cut = 1; cut <= 3 && cut < bytes.length; cut += 1) {
      try {
        return decode(bytes.subarray(0, bytes.length - cut));
      } catch {
        // Keep walking back.
      }
    }
    return undefined;
  }
}

/**
 * The body stream, decoded.
 *
 * The byte cap applies to the decoded content, so an encoding cannot be used
 * to smuggle a document past it.
 */
function decodingStream(body: Readable, encoding: string): AsyncIterable<Buffer> {
  switch (encoding) {
    case "":
    case "identity":
      return body;
    case "gzip":
    case "x-gzip":
    case "deflate":
      return body.pipe(createUnzip());
    case "br":
      return body.pipe(createBrotliDecompress());
    default:
      throw new WebFetchError(`the response encoding "${encoding}" is not supported`);
  }
}

/** A document the reader read, and what it had to leave out. */
interface DecodedDocument {
  /** The document's text. */
  text: string;
  /** True when the document was cut short, so the model read only part of it. */
  truncated: boolean;
  /** The decoded bytes the document was read from. */
  bytes: number;
}

/**
 * Reads a document, stopping at the reader's byte cap.
 *
 * The remaining response is cancelled rather than drained, so an endless
 * document costs the reader only what it read.
 */
async function readDocument(
  body: Readable,
  encoding: string,
  limits: WebFetchLimits,
  signal: AbortSignal,
): Promise<DecodedDocument> {
  let stream: AsyncIterable<Buffer>;
  try {
    stream = decodingStream(body, encoding);
  } catch (error) {
    body.destroy();
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const read = async (): Promise<void> => {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limits.maxDocumentBytes) {
        chunks.push(bytes.subarray(0, bytes.byteLength - (size - limits.maxDocumentBytes)));
        truncated = true;
        break;
      }
      chunks.push(bytes);
    }
  };
  // The deadline covers the body as well as the response head, so a body
  // that stalls ends the fetch instead of holding the run open.
  const onAbort = (): void => {
    body.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await withDeadline(read(), signal);
  } catch {
    body.destroy();
    if (signal.aborted) throw new WebFetchError("the request timed out");
    // The transport's own wording stays inside the transport.
    throw new WebFetchError("the page could not be read");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  // The rest of the response is cancelled rather than drained.
  if (truncated) body.destroy();
  const raw = Buffer.concat(chunks);
  const text = decodeUtf8(raw, truncated);
  if (text === undefined) {
    body.destroy();
    throw new WebFetchError("the page is not valid UTF-8 text");
  }
  return { text, truncated, bytes: raw.byteLength };
}

/** The media type of a response, without its parameters. */
function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Builds the reader.
 *
 * The reader is run-scoped: its request count, its byte budget, and its
 * concurrency bound belong to one run, so a model that loops on the tool
 * cannot spend more than the allowance.
 */
export function createWebFetchClient(options: WebFetchClientOptions = {}): WebFetchClient {
  const transport = options.transport ?? httpsTransport;
  const resolveHost = options.resolveHost ?? systemResolver;
  const limits: WebFetchLimits = { ...DEFAULT_WEB_FETCH_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    // A limit that is not a positive whole number would make the budget
    // checks meaningless, and a result cap below the truncation marker
    // cannot be honoured at all.
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(`Invalid URL reader limit: ${name}`);
  }
  // The truncation marker has to fit inside the result cap, with room for a
  // character of content beside it.
  if (limits.maxResultBytes < 64) throw new RangeError("Invalid URL reader limit: maxResultBytes");
  let requests = 0;
  let totalBytes = 0;
  let reservedBytes = 0;
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < limits.maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // The slot was handed over by release, which left the count alone.
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      // The slot passes straight to the next caller; the count stays the
      // same, so a caller arriving in between cannot take it too.
      next();
      return;
    }
    active -= 1;
  };

  const chargeRequest = (): void => {
    if (requests >= limits.maxRequests)
      throw new WebFetchError("the URL reader request budget is exhausted");
    requests += 1;
  };

  /**
   * The bytes one document may still read.
   *
   * The allowance is reserved before the document is read, so two concurrent
   * reads cannot both spend the same part of the aggregate budget: the
   * reservation is taken out of the run's allowance synchronously, and the
   * unused part is given back when the read ends. A document longer than
   * its allowance is cut short and reported as partial, so the run never
   * reads more than it may return.
   */
  const reserveAllowance = (): number => {
    const remaining = limits.maxTotalBytes - totalBytes - reservedBytes;
    if (remaining <= 0) throw new WebFetchError("the URL reader byte budget is exhausted");
    const allowance = Math.min(limits.maxDocumentBytes, remaining);
    reservedBytes += allowance;
    return allowance;
  };

  const settleAllowance = (allowance: number, bytes: number): void => {
    reservedBytes -= allowance;
    totalBytes += bytes;
  };

  /**
   * The address the socket must connect to.
   *
   * A literal is checked and used as it stands; a name is resolved once, and
   * every address the answer carries is checked before the first of them is
   * used. An answer that mixes a public and a private address is rejected
   * whole, and a name that does not resolve is an error rather than a pass.
   */
  const resolveTarget = async (hostname: string, signal: AbortSignal): Promise<ResolvedAddress> => {
    const family = addressFamily(hostname);
    if (family !== undefined) {
      if (isBlockedAddress(hostname))
        throw new WebFetchError("the host is on a private or local address");
      return { address: bareHostname(hostname), family };
    }
    let answers: readonly ResolvedAddress[];
    try {
      answers = await withDeadline(
        Promise.resolve().then(() => resolveHost(hostname)),
        signal,
      );
    } catch {
      if (signal.aborted) throw new WebFetchError("the request timed out");
      throw new WebFetchError("the host could not be resolved");
    }
    if (answers.length === 0) throw new WebFetchError("the host could not be resolved");
    for (const answer of answers) {
      if (isBlockedAddress(answer.address))
        throw new WebFetchError("the host resolves to a private or local address");
    }
    return answers[0]!;
  };

  const run = async (rawUrl: string): Promise<WebFetchResult> => {
    const admission = checkUrlAdmissibility(rawUrl);
    if (!admission.ok) throw new WebFetchError(admission.reason);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.deadlineMs);
    try {
      let current = new URL(rawUrl);
      for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        // Every hop is checked against the same rules before it is contacted.
        const hopAdmission = checkUrlAdmissibility(current.href);
        if (!hopAdmission.ok) throw new WebFetchError(hopAdmission.reason);
        // A redirect hop is a request, and it is charged as one.
        chargeRequest();
        const address = await resolveTarget(current.hostname, controller.signal);
        let response: TransportResponse;
        try {
          response = await withDeadline(
            transport({
              url: current,
              headers: REQUEST_HEADERS,
              address,
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw new WebFetchError("the request timed out");
          throw error;
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers["location"];
          response.body.destroy();
          if (!location) throw new WebFetchError("the redirect carried no location");
          try {
            current = new URL(location, current);
          } catch {
            throw new WebFetchError("the redirect carried an unusable location");
          }
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          response.body.destroy();
          throw new WebFetchError(`the page returned status ${response.status}`);
        }
        const contentType = mediaTypeOf(response.headers["content-type"] ?? "");
        if (!TEXT_CONTENT_TYPES.has(contentType)) {
          response.body.destroy();
          throw new WebFetchError(
            `the response type "${contentType || "unknown"}" is not a text document`,
          );
        }
        const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
        if (encoding.includes(",")) {
          response.body.destroy();
          throw new WebFetchError("the response encoding is not supported");
        }
        const allowance = reserveAllowance();
        let document: DecodedDocument;
        try {
          document = await readDocument(
            response.body,
            encoding,
            { ...limits, maxDocumentBytes: allowance },
            controller.signal,
          );
        } catch (error) {
          settleAllowance(allowance, 0);
          throw error;
        }
        settleAllowance(allowance, document.bytes);
        const text = truncateUtf8WithMarker(document.text, limits.maxResultBytes);
        return {
          url: current.href,
          status: response.status,
          contentType,
          text,
          truncated: document.truncated || text !== document.text,
          remainingRequests: limits.maxRequests - requests,
        };
      }
      throw new WebFetchError("the redirect chain exceeded the hop limit");
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async fetch(url: string): Promise<WebFetchResult> {
      await acquire();
      try {
        return await run(url);
      } finally {
        release();
      }
    },
  };
}
