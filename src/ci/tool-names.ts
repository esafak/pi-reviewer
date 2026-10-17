// Single source of truth for CI agent tool names: tool definitions and the
// startup availability diagnostic both observe these constants so a rename
// cannot desynchronize the diagnostic from registration.
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_AI_SEARCH_TOOL_NAME = "web_ai_search";
export const PACKAGE_LOOKUP_TOOL_NAME = "package_lookup";
export const GITHUB_SEARCH_TOOL_NAME = "github_search";
export const GITHUB_READ_TOOL_NAME = "github_read";
export const GITHUB_GREP_TOOL_NAME = "github_grep";
export const CODE_EXEC_TOOL_NAME = "code_exec";
export const MCP_TOOL_NAME = "mcp";

export const KNOWN_CI_TOOL_NAMES = [
  WEB_SEARCH_TOOL_NAME,
  WEB_AI_SEARCH_TOOL_NAME,
  PACKAGE_LOOKUP_TOOL_NAME,
  GITHUB_SEARCH_TOOL_NAME,
  GITHUB_READ_TOOL_NAME,
  GITHUB_GREP_TOOL_NAME,
  CODE_EXEC_TOOL_NAME,
  MCP_TOOL_NAME,
] as const;

export type CiToolName = (typeof KNOWN_CI_TOOL_NAMES)[number];
