export interface KeywordResult {
  keyword: string;
  volume: number | null;
  volumeSource: string;
  volumeConfidence: 'exact' | 'range' | 'relative_only' | 'estimated';
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
  trend: 'rising' | 'stable' | 'declining' | null;
  trendInterest: number | null;
  relatedQueries: string[];
}

export interface DiscoveryOptions {
  language: string;
  region: string;
  timeframe?: string;
}

export interface KeywordProvider {
  name: string;
  tier: 'free' | 'paid';
  isAvailable(): Promise<boolean>;
  discover(
    seeds: string[],
    options: DiscoveryOptions
  ): Promise<KeywordResult[]>;
}

export interface ToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    fix: string;
  };
}

export function ok<T>(data: T): ToolResponse<T> {
  return { success: true, data };
}

export function fail<T = unknown>(
  code: string,
  message: string,
  fix: string
): ToolResponse<T> {
  return { success: false, error: { code, message, fix } };
}
