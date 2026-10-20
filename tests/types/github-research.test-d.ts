import {
  enrichmentsByKind,
  numberlessKinds,
  type GitHubReadKind,
  type ReadRequest,
} from "../../src/ci/github-research/client.js";

/**
 * The read union and the option table are one contract, checked at compile
 * time: a runtime test cannot inspect an erased type.
 *
 * These assertions fail the typecheck when the union and
 * `enrichmentsByKind` drift apart.
 */
type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type MemberFor<K extends GitHubReadKind> = Extract<ReadRequest, { kind: K }>;
/** The options a union member carries, beyond the fields every kind shares. */
type OptionKeys<T> = Exclude<keyof T, "kind" | "owner" | "repo" | "number" | "path" | "ref">;

/** Every kind has a row, and every row has a kind. */
type _KindsMatch = Expect<Equals<keyof typeof enrichmentsByKind, GitHubReadKind>>;

/** Each member permits exactly the options its row lists, and forbids the rest. */
type _OptionsMatch = Expect<
  {
    [K in GitHubReadKind]: Equals<
      OptionKeys<MemberFor<K>>,
      (typeof enrichmentsByKind)[K][number]
    > extends true
      ? true
      : false;
  } extends Record<GitHubReadKind, true>
    ? true
    : false
>;

/** The kinds that take a number are exactly the ones the table marks as numberless. */
type _NumbersMatch = Expect<
  Equals<
    { [K in GitHubReadKind]: "number" extends keyof MemberFor<K> ? K : never }[GitHubReadKind],
    Exclude<GitHubReadKind, (typeof numberlessKinds)[number]>
  >
>;

/** A path is the file kind's alone. */
type _PathMatch = Expect<
  Equals<
    { [K in GitHubReadKind]: "path" extends keyof MemberFor<K> ? K : never }[GitHubReadKind],
    "file"
  >
>;
