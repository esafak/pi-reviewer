export type RegistryEcosystem = "python" | "java" | "rust" | "javascript" | "go";

export interface RegistryLookupParams {
  ecosystem: RegistryEcosystem;
  name: string;
  version?: string;
  packaging?: string;
  classifier?: string;
  rows?: number;
}

export interface RegistryProvider {
  lookup(params: RegistryLookupParams, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export interface RegistryClient {
  lookup(params: RegistryLookupParams): Promise<{
    metadata: Record<string, unknown>;
    remainingLookups: number;
  }>;
}
