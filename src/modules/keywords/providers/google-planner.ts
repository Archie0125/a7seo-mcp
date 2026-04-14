import { GoogleAdsApi } from 'google-ads-api';
import type {
  KeywordProvider,
  KeywordResult,
  DiscoveryOptions,
} from './base.js';

interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  customerId: string;
}

let cachedConfig: GoogleAdsConfig | null = null;

export function setGoogleAdsConfig(config: GoogleAdsConfig) {
  cachedConfig = config;
}

// Language constants for Google Ads
const LANGUAGE_MAP: Record<string, string> = {
  'zh-TW': '1018', // Chinese (Traditional)
  'zh-CN': '1017', // Chinese (Simplified)
  'en': '1000',    // English
  'ja': '1005',    // Japanese
  'ko': '1012',    // Korean
};

// Geo target constants
const GEO_MAP: Record<string, string> = {
  'TW': '2158', // Taiwan
  'HK': '2344', // Hong Kong
  'US': '2840', // United States
  'JP': '2392', // Japan
  'KR': '2410', // South Korea
  'SG': '2702', // Singapore
  'MY': '2458', // Malaysia
};

export const googlePlannerProvider: KeywordProvider = {
  name: 'google-planner',
  tier: 'free',

  async isAvailable(): Promise<boolean> {
    return cachedConfig !== null &&
      !!cachedConfig.clientId &&
      !!cachedConfig.developerToken &&
      !!cachedConfig.refreshToken &&
      !!cachedConfig.customerId;
  },

  async discover(
    seeds: string[],
    options: DiscoveryOptions
  ): Promise<KeywordResult[]> {
    if (!cachedConfig) {
      throw new Error('Google Ads credentials not configured');
    }

    const client = new GoogleAdsApi({
      client_id: cachedConfig.clientId,
      client_secret: cachedConfig.clientSecret,
      developer_token: cachedConfig.developerToken,
    });

    const customer = client.Customer({
      customer_id: cachedConfig.customerId,
      refresh_token: cachedConfig.refreshToken,
    });

    const languageId = LANGUAGE_MAP[options.language] || '1018';
    const geoId = GEO_MAP[options.region] || '2158';

    try {
      // Generate keyword ideas from seed keywords
      const response = await (customer as any).keywordPlanIdeas.generateKeywordIdeas({
        customer_id: cachedConfig.customerId,
        keyword_seed: {
          keywords: seeds,
        },
        language: `languageConstants/${languageId}`,
        geo_target_constants: [`geoTargetConstants/${geoId}`],
        keyword_plan_network: 2, // GOOGLE_SEARCH
        include_adult_keywords: false,
        page_size: 100,
      });

      const results: KeywordResult[] = [];
      const ideas = Array.isArray(response) ? response : (response?.results || []);

      for (const idea of ideas) {
        const metrics = (idea as any).keyword_idea_metrics;
        const keyword = (idea as any).text || '';

        if (!keyword) continue;

        // Parse average monthly searches
        let volume: number | null = null;
        let volumeConfidence: 'exact' | 'range' | 'estimated' = 'estimated';

        if (metrics?.avg_monthly_searches !== undefined && metrics.avg_monthly_searches !== null) {
          volume = Number(metrics.avg_monthly_searches);
          // Google returns exact numbers for accounts with spend, ranges otherwise
          volumeConfidence = volume > 0 ? 'range' : 'estimated';
        }

        // Parse competition
        let difficulty: number | null = null;
        if (metrics?.competition_index !== undefined && metrics.competition_index !== null) {
          difficulty = Number(metrics.competition_index); // 0-100
        }

        // Parse CPC
        let cpc: number | null = null;
        if (metrics?.average_cpc_micros !== undefined && metrics.average_cpc_micros !== null) {
          cpc = Number(metrics.average_cpc_micros) / 1_000_000; // micros to dollars
        }

        results.push({
          keyword,
          volume,
          volumeSource: 'google-planner',
          volumeConfidence,
          difficulty,
          cpc,
          intent: null, // Planner doesn't provide intent
          trend: null,  // Planner doesn't provide trend
          trendInterest: null,
          relatedQueries: [],
        });
      }

      return results;
    } catch (err) {
      const msg = (err as Error).message;

      if (msg.includes('UNAUTHENTICATED') || msg.includes('authentication')) {
        throw new Error(
          'Google Ads authentication failed. Check your credentials: ' +
          'CLIENT_ID, CLIENT_SECRET, DEVELOPER_TOKEN, REFRESH_TOKEN, CUSTOMER_ID'
        );
      }

      if (msg.includes('DEVELOPER_TOKEN_NOT_APPROVED')) {
        throw new Error(
          'Google Ads developer token not approved. ' +
          'Apply for Basic access at: Google Ads > Tools > API Center'
        );
      }

      throw new Error(`Google Keyword Planner error: ${msg}`);
    }
  },
};
