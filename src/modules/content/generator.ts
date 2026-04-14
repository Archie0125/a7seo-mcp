import Anthropic from '@anthropic-ai/sdk';
import type { ProjectConfig } from '../../config.js';
import type { ToolResponse } from '../keywords/providers/base.js';
import { ok, fail } from '../keywords/providers/base.js';

export interface ContentBrief {
  keyword: string;
  title: string;
  metaDescription: string;
  headings: { level: number; text: string }[];
  targetWordCount: number;
  faqQuestions: string[];
  relatedKeywords: string[];
  intent: string;
}

export interface GeneratedArticle {
  html: string;
  jsonLd: Record<string, unknown>;
  title: string;
  slug: string;
  metaDescription: string;
  wordCount: number;
  keyword: string;
}

const BRIEF_SYSTEM_PROMPT = `You are an SEO content strategist. Given a target keyword and related data, produce a detailed content brief in JSON format.

Output JSON with these fields:
- title: SEO-optimized article title in the same language as the keyword
- metaDescription: 150-160 char meta description
- headings: array of {level: 2|3, text: string} for H2 and H3 headings
- targetWordCount: recommended word count (1500-3000)
- faqQuestions: 3-5 FAQ questions users would ask
- relatedKeywords: keywords to naturally include
- intent: "informational" | "commercial" | "transactional" | "navigational"

Return ONLY valid JSON, no markdown fences.`;

const GENERATE_SYSTEM_PROMPT = `You are an SEO article generator. Output pure semantic HTML.

Rules:
- ONLY use: article, h1, h2, h3, h4, p, ul, ol, li, dl, dt, dd, a, strong, em, blockquote, figure, figcaption, table, thead, tbody, tr, th, td
- NEVER use: class, id, style attributes, div, span, or any other tags
- h1 appears exactly once (article title)
- h2 for main sections
- h3 for subsections
- FAQ uses <dl><dt>question</dt><dd>answer</dd></dl>
- Last h2 should be a CTA section
- Naturally incorporate the target keyword and related keywords
- Write in the same language as the target keyword
- Output ONLY the HTML content inside <article>...</article>, nothing else`;

export async function generateBrief(
  keyword: string,
  relatedQueries: string[],
  intent: string | null,
  config: ProjectConfig
): Promise<ToolResponse<ContentBrief>> {
  if (!config.anthropicApiKey) {
    return fail(
      'NO_API_KEY',
      'Anthropic API key not configured',
      'Set ANTHROPIC_API_KEY environment variable or add anthropicApiKey to config'
    );
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const userPrompt = `Target keyword: "${keyword}"
Related queries: ${relatedQueries.join(', ') || 'none'}
Search intent: ${intent || 'informational'}
Language: ${config.language}
Region: ${config.region}

Generate a content brief for this keyword.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: BRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const brief = JSON.parse(text) as Omit<ContentBrief, 'keyword'>;

    return ok({
      keyword,
      ...brief,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('authentication') || msg.includes('API key')) {
      return fail('AUTH_FAILED', 'Anthropic API authentication failed', 'Check your ANTHROPIC_API_KEY');
    }
    return fail('BRIEF_FAILED', msg, 'Check API key and network connection');
  }
}

export async function generateArticle(
  brief: ContentBrief,
  config: ProjectConfig
): Promise<ToolResponse<GeneratedArticle>> {
  if (!config.anthropicApiKey) {
    return fail(
      'NO_API_KEY',
      'Anthropic API key not configured',
      'Set ANTHROPIC_API_KEY environment variable or add anthropicApiKey to config'
    );
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const headingsOutline = brief.headings
    .map((h) => `${'#'.repeat(h.level)} ${h.text}`)
    .join('\n');

  const userPrompt = `Write a complete SEO article based on this brief:

Target keyword: "${brief.keyword}"
Title: "${brief.title}"
Meta description: "${brief.metaDescription}"
Search intent: ${brief.intent}
Target word count: ${brief.targetWordCount}
Related keywords to include: ${brief.relatedKeywords.join(', ')}

Outline:
${headingsOutline}

FAQ questions to answer:
${brief.faqQuestions.map((q) => `- ${q}`).join('\n')}

Output the complete article as semantic HTML inside <article>...</article>.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: GENERATE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const html =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Validate: ensure no class/id/style attributes
    const violations = validateSemanticHtml(html);
    if (violations.length > 0) {
      // Auto-clean rather than failing
      const cleaned = cleanHtml(html);
      return ok(buildArticleResult(cleaned, brief));
    }

    return ok(buildArticleResult(html, brief));
  } catch (err) {
    return fail(
      'GENERATE_FAILED',
      (err as Error).message,
      'Check API key, network, or reduce target word count'
    );
  }
}

export async function optimizeContent(
  existingHtml: string,
  keyword: string,
  config: ProjectConfig
): Promise<ToolResponse<{ suggestions: string[]; rewrittenHtml?: string }>> {
  if (!config.anthropicApiKey) {
    return fail(
      'NO_API_KEY',
      'Anthropic API key not configured',
      'Set ANTHROPIC_API_KEY environment variable'
    );
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are an SEO content optimizer. Analyze the given HTML article and provide:
1. A JSON array of optimization suggestions (max 10)
2. If significant improvements are needed, a rewritten version

Output JSON: { "suggestions": ["..."], "rewrittenHtml": "<article>...</article>" or null }
Return ONLY valid JSON.`,
    messages: [
      {
        role: 'user',
        content: `Target keyword: "${keyword}"\nLanguage: ${config.language}\n\nExisting article HTML:\n${existingHtml}`,
      },
    ],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '{}';
  try {
    const result = JSON.parse(text);
    return ok(result);
  } catch {
    return ok({ suggestions: [text], rewrittenHtml: undefined });
  }
}

function buildArticleResult(
  html: string,
  brief: ContentBrief
): GeneratedArticle {
  const slug = brief.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  const wordCount = html.replace(/<[^>]+>/g, '').length;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: brief.title,
    description: brief.metaDescription,
    keywords: [brief.keyword, ...brief.relatedKeywords].join(', '),
    inLanguage: 'zh-TW',
  };

  return {
    html,
    jsonLd,
    title: brief.title,
    slug,
    metaDescription: brief.metaDescription,
    wordCount,
    keyword: brief.keyword,
  };
}

function validateSemanticHtml(html: string): string[] {
  const violations: string[] = [];
  if (/\bclass\s*=/i.test(html)) violations.push('contains class attributes');
  if (/\bid\s*=/i.test(html)) violations.push('contains id attributes');
  if (/\bstyle\s*=/i.test(html)) violations.push('contains style attributes');
  if (/<div[\s>]/i.test(html)) violations.push('contains <div> tags');
  if (/<span[\s>]/i.test(html)) violations.push('contains <span> tags');
  return violations;
}

function cleanHtml(html: string): string {
  return html
    .replace(/\s+class="[^"]*"/gi, '')
    .replace(/\s+id="[^"]*"/gi, '')
    .replace(/\s+style="[^"]*"/gi, '')
    .replace(/<div([^>]*)>/gi, '<section$1>')
    .replace(/<\/div>/gi, '</section>')
    .replace(/<span([^>]*)>/gi, '')
    .replace(/<\/span>/gi, '');
}
