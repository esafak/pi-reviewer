import { NOISE_PATTERNS } from "../diff-filter.js";

/**
 * The lockfiles of the formats the dependency mode supports.
 *
 * A lockfile records the resolution of the manifest, not the pin itself, so
 * a lockfile refresh carries the versions of every package in the project
 * rather than the ones that changed. It is noise in a dependency analysis
 * for the same reason it is noise in a code review.
 *
 * The patterns match the file's name at any depth, because the formats that
 * write these files write them beside the manifest they belong to.
 */
export const DEPENDENCY_LOCKFILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)aube-lock\.yaml$/,
  /(?:^|\/)mise\.lock$/,
  /(?:^|\/)aqua-checksums\.json$/,
  /(?:^|\/)\.aqua-checksums\.json$/,
  /(?:^|\/)packages\.lock\.json$/,
  /(?:^|\/)pdm\.lock$/,
  /(?:^|\/)uv\.lock$/,
  /(?:^|\/)poetry\.lock$/,
  /(?:^|\/)gradle\.lockfile$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)composer\.lock$/,
];

/**
 * The files the dependency mode treats as noise.
 *
 * The shared list is the review mode's own, unchanged: a review's behavior
 * must not depend on which mode is running. The dependency mode adds the
 * lockfiles of the formats it reads, because a lockfile refresh would
 * otherwise crowd out the manifest change that matters.
 */
export const DEPENDENCY_NOISE_PATTERNS: readonly RegExp[] = [
  ...NOISE_PATTERNS,
  ...DEPENDENCY_LOCKFILE_PATTERNS,
];
