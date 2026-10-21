import { describe, expect, it } from "vite-plus/test";

import {
  addressFamily,
  checkUrlAdmissibility,
  isBlockedAddress,
  isInternalHost,
} from "../../../src/ci/web-fetch/admissibility.js";

describe("URL admissibility", () => {
  it("accepts an https location on a public host", () => {
    expect(checkUrlAdmissibility("https://github.com/facebook/react")).toEqual({ ok: true });
    expect(checkUrlAdmissibility("https://codeberg.org/example/demo/releases")).toEqual({
      ok: true,
    });
  });

  it("refuses a location that is not https", () => {
    for (const url of [
      "http://example.com/notes",
      "ftp://example.com/notes",
      "file:///etc/passwd",
      "data:text/plain,hello",
    ]) {
      const result = checkUrlAdmissibility(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason, url).toContain("not https");
    }
  });

  it("refuses a location that carries credentials", () => {
    const result = checkUrlAdmissibility("https://user:secret@example.com/notes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("credentials");
  });

  it("refuses a host that is a private or local address", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "[::1]",
    ]) {
      expect(isInternalHost(host), host).toBe(true);
    }
  });

  it("refuses the alternative spellings of an IPv4 address", () => {
    // The URL parser rewrites the alternative spellings into their
    // dotted-quad form, so the location is refused for what it names.
    for (const url of [
      "https://2130706433/",
      "https://0177.0.0.1/",
      "https://0x7f000001/",
      "https://127.1/",
      "https://10.0.0.1/",
    ]) {
      const result = checkUrlAdmissibility(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason, url).toContain("private or local address");
    }
  });

  it("refuses an IPv4-mapped IPv6 address", () => {
    expect(isInternalHost("::ffff:127.0.0.1")).toBe(true);
    expect(isInternalHost("::ffff:7f00:1")).toBe(true);
    expect(isInternalHost("::ffff:8.8.8.8")).toBe(false);
  });

  it("refuses the IPv4-compatible spelling of an IPv4 address", () => {
    // `::a.b.c.d` is an IPv4 address written as an IPv6 one, and it is not
    // the IPv4-mapped form the mapped rules cover.
    expect(isInternalHost("::127.0.0.1")).toBe(true);
    expect(isInternalHost("::7f00:1")).toBe(true);
    expect(isInternalHost("[::127.0.0.1]")).toBe(true);
    expect(isInternalHost("::10.0.0.1")).toBe(true);
    expect(isInternalHost("::169.254.169.254")).toBe(true);
    // The whole range is refused, not only its private half: the spelling
    // itself is the reason.
    expect(isInternalHost("::8.8.8.8")).toBe(true);
  });

  it("refuses the transition prefixes that carry an IPv4 address", () => {
    // 6to4 and Teredo carry the IPv4 address in the prefix, so a private
    // address can be named through them. The prefixes are refused whole,
    // because the mechanism is what makes the address reachable.
    expect(isInternalHost("2002:7f00:1::")).toBe(true);
    expect(isInternalHost("2002:a00:1::")).toBe(true);
    expect(isInternalHost("2001:0:7f00:1:0:0:0:0")).toBe(true);
    expect(isInternalHost("2002:808:808::")).toBe(true);
  });

  it("refuses the special-purpose ranges that are not public destinations", () => {
    for (const host of [
      // IPv4: protocol assignments, documentation, benchmarking, 6to4 relay.
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "198.18.0.1",
      "192.88.99.1",
      "100.64.0.1",
      "224.0.0.1",
      "240.0.0.1",
      // IPv6: multicast, discard-only, protocol assignments, documentation,
      // NAT64.
      "ff02::1",
      "100::1",
      "2001:2::1",
      "2001:db8::1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
    ]) {
      expect(isInternalHost(host), host).toBe(true);
    }
  });

  it("refuses the globally reachable addresses inside a blocked range", () => {
    // Two anycast addresses in each blocked range are reachable from the
    // public internet. A block list cannot say "this range, except these
    // two", so they are refused with the ranges around them; neither is a
    // release-note host.
    expect(isInternalHost("192.0.0.9")).toBe(true);
    expect(isInternalHost("192.0.0.10")).toBe(true);
    expect(isInternalHost("2001:1::1")).toBe(true);
    expect(isInternalHost("2001:1::2")).toBe(true);
  });

  it("leaves the special-purpose ranges that are routable alone", () => {
    for (const host of ["8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(isInternalHost(host), host).toBe(false);
    }
  });

  it("treats a name that merely looks hexadecimal as a name", () => {
    expect(isInternalHost("dead.beef")).toBe(false);
  });

  it("leaves a public host alone", () => {
    expect(isInternalHost("github.com")).toBe(false);
    expect(isInternalHost("8.8.8.8")).toBe(false);
    expect(addressFamily("2001:4860:4860::8888")).toBe(6);
    expect(addressFamily("github.com")).toBeUndefined();
  });

  it("reads an IPv6 literal that carries brackets", () => {
    // A URL keeps the brackets on an IPv6 host, and `net.isIP` does not
    // accept them.
    expect(addressFamily("[2606:4700:4700::1111]")).toBe(6);
    expect(addressFamily("[::1]")).toBe(6);
    expect(addressFamily("[::1]")).toBeDefined();
    expect(isInternalHost("[2606:4700:4700::1111]")).toBe(false);
    expect(isInternalHost("[::1]")).toBe(true);
    expect(isBlockedAddress("[127.0.0.1]")).toBe(true);
    expect(isBlockedAddress("[2606:4700:4700::1111]")).toBe(false);
  });

  it("refuses a resolved answer it cannot read", () => {
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });
});
