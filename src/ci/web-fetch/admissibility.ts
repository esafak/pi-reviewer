import net from "node:net";

/**
 * The static rules a URL must pass before the reader may open it.
 *
 * The rules are a property of the reader, not of the model's judgement: a
 * location is admissible when it is https, carries no credentials, and names
 * a host that is not an address inside the network the runner sits in. Every
 * redirect hop is checked against the same rules before it is contacted, so
 * a redirect cannot carry a URL past them.
 *
 * The host check reads the URL's canonical host. The URL parser has already
 * rewritten the alternative spellings of an IPv4 address — `2130706433`,
 * `0177.0.0.1`, `0x7f000001` — into their dotted-quad form, so
 * `http://2130706433/` is checked as `127.0.0.1` without this module
 * parsing a spelling of its own.
 */

/**
 * The IPv4 ranges a location may not name.
 *
 * The list covers the ranges that are not public destinations: the private
 * and the special-purpose ones alike, so a reader is not left reaching a
 * network it has no business reaching.
 */
const IPV4_RANGES: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast and reserved
  ["240.0.0.0", 4], // reserved
];

/** The IPv6 ranges a location may not name. */
const IPV6_RANGES: readonly (readonly [string, number])[] = [
  // The IPv4-compatible range, which carries the deprecated `::a.b.c.d`
  // spelling: `::127.0.0.1` is loopback written as an IPv6 address, and
  // `::1` and `::` sit inside it.
  ["::", 96],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments, benchmarking included
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which carries an IPv4 address in its prefix
  ["64:ff9b::", 96], // NAT64, the well-known prefix
  ["64:ff9b:1::", 48], // NAT64, the local-use prefix
];

/**
 * The ranges, as one block list.
 *
 * Each IPv4 range is added twice: once as IPv4, and once as the IPv4-mapped
 * IPv6 form of the same range. Node matches an IPv4 address against the IPv6
 * rules by mapping it, so the IPv4 rules alone would not cover a mapped
 * address — while the whole mapped range would cover every IPv4 address,
 * public ones included.
 *
 * Two globally reachable anycast addresses inside the blocked ranges are
 * refused with the ranges around them. They are not release-note hosts, and
 * a block list cannot say "this range, except these two".
 */
const BLOCKED = new net.BlockList();
for (const [network, bits] of IPV4_RANGES) {
  BLOCKED.addSubnet(network, bits, "ipv4");
  BLOCKED.addSubnet(`::ffff:${network}`, bits + 96, "ipv6");
}
for (const [prefix, bits] of IPV6_RANGES) BLOCKED.addSubnet(prefix, bits, "ipv6");

/**
 * The address a host names, without the brackets an IPv6 literal carries.
 *
 * A URL keeps the brackets on an IPv6 host, and `net.isIP` does not accept
 * them, so the brackets are removed before the address is read.
 */
function literalOf(host: string): string {
  const value = host.trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

/** The address family of a literal address, or undefined for a name. */
export function addressFamily(host: string): 4 | 6 | undefined {
  const family = net.isIP(literalOf(host));
  return family === 4 ? 4 : family === 6 ? 6 : undefined;
}

/** Whether the address falls inside a range the reader may not reach. */
function isBlockedLiteral(address: string): boolean {
  const literal = literalOf(address);
  const family = addressFamily(literal);
  if (family === undefined) return false;
  return Boolean(BLOCKED.check(literal, family === 4 ? "ipv4" : "ipv6"));
}

/** Whether the host names an address the reader may not reach. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host.length) return true;
  // A name is not an address; it is resolved later, and the answer is
  // checked then.
  return isBlockedLiteral(host);
}

/**
 * Whether a resolved address is one the reader may not connect to.
 *
 * Unlike a host, a resolved address is always a literal, so a value that
 * does not parse as one is refused rather than passed: an answer the reader
 * cannot read is an answer it cannot vouch for.
 */
export function isBlockedAddress(address: string): boolean {
  const literal = address.trim();
  if (addressFamily(literal) === undefined) return true;
  return isBlockedLiteral(literal);
}

/** The outcome of an admissibility check. */
export type Admissibility = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether the reader may open the location.
 *
 * The scheme, the credentials, and the host are checked here. The size, the
 * content type, and the address a name resolves to are properties of the
 * request itself, and the reader checks them as it makes it.
 */
export function checkUrlAdmissibility(raw: string): Admissibility {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "the location is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "the location is not https" };
  if (url.username || url.password)
    return { ok: false, reason: "the location carries credentials" };
  if (isInternalHost(url.hostname))
    return { ok: false, reason: "the host is on a private or local address" };
  return { ok: true };
}
