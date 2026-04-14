import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ProjectConfig } from './config.js';
import { discoverKeywords, getKeywordTrends } from './modules/keywords/discovery.js';
import { clusterKeywords } from './modules/keywords/clustering.js';
import { generateBrief, generateArticle, optimizeContent } from './modules/content/generator.js';
import { createMarkdownAdapter } from './modules/publisher/adapters/markdown-files.js';
import { ok, fail } from './modules/keywords/providers/base.js';

export function registerAllTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  registerKeywordTools(server, config, db);
  registerContentTools(server, config, db);
  registerPublisherTools(server, config, db);
}

function registerKeywordTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_keywords_discover',
    'Discover keywords with search volume, trends, and competition data. Uses Google Trends (free), Google Keyword Planner (free), and DataForSEO (paid) in a fallback chain.',
    {
      seeds: z.string().describe('Comma-separated seed keywords (e.g. "SEO優化,關鍵字研究")'),
    },
    async ({ seeds }) => {
      try {
        const seedList = seeds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (seedList.length === 0) {
          const res = fail('EMPTY_SEEDS', 'No seed keywords provided', 'Provide comma-separated keywords, e.g. "SEO優化,關鍵字研究"');
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
        }
        const result = await discoverKeywords(seedList, config, db);
        const res = ok(result);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'DISCOVERY_FAILED',
          (err as Error).message,
          'Check that Python + pytrends is installed, or configure Google Keyword Planner credentials'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_keywords_trends',
    'Get Google Trends data for specific keywords. Returns relative interest (0-100), trend direction, and related queries.',
    {
      keywords: z.string().describe('Comma-separated keywords to check trends for'),
      timeframe: z.string().optional().describe('Timeframe (default: "today 12-m"). Options: "today 3-m", "today 12-m", "today 5-y"'),
    },
    async ({ keywords, timeframe }) => {
      try {
        const kwList = keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const result = await getKeywordTrends(kwList, config, db, timeframe);
        const res = ok(result);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'TRENDS_FAILED',
          (err as Error).message,
          'Install Python 3 and pytrends: pip install pytrends'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_keywords_cluster',
    'Group keywords into topical clusters with search intent classification.',
    {
      keywords: z.string().describe('Comma-separated keywords to cluster'),
    },
    async ({ keywords }) => {
      const kwList = keywords
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await clusterKeywords(kwList, config, db);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_keywords_gaps',
    'Find keyword gaps: keywords in the database that do not have published articles yet.',
    {
      limit: z.number().optional().describe('Max results to return (default: 20)'),
    },
    async ({ limit }) => {
      const maxResults = limit || 20;
      const rows = db
        .prepare(
          `SELECT k.keyword, k.volume, k.trend, k.trend_interest, k.intent
           FROM keywords k
           LEFT JOIN articles a ON a.target_keyword_id = k.id AND a.project_id = k.project_id
           WHERE k.project_id = ? AND a.id IS NULL
           ORDER BY k.trend_interest DESC NULLS LAST, k.volume DESC NULLS LAST
           LIMIT ?`
        )
        .all(config.projectId, maxResults);

      const res = ok({ gaps: rows, total: rows.length });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );
}

function registerContentTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_content_brief',
    'Generate a content brief from a target keyword. Analyzes search intent and produces an article outline with headings, FAQ questions, and word count target.',
    {
      keyword: z.string().describe('Target keyword for the article'),
      related_queries: z.string().optional().describe('Comma-separated related keywords to include'),
      intent: z.string().optional().describe('Search intent: informational, commercial, transactional, navigational'),
    },
    async ({ keyword, related_queries, intent }) => {
      const related = related_queries
        ? related_queries.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      // Try to enrich from DB
      if (related.length === 0) {
        const row = db
          .prepare('SELECT trend, intent FROM keywords WHERE project_id = ? AND keyword = ?')
          .get(config.projectId, keyword) as { trend: string; intent: string } | undefined;
        if (row?.intent && !intent) {
          // Use DB intent as fallback
        }
      }

      const result = await generateBrief(keyword, related, intent || null, config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_content_generate',
    'Generate a full SEO article as semantic HTML from a content brief. Outputs pure HTML (no classes, no divs) plus JSON-LD schema.',
    {
      keyword: z.string().describe('Target keyword'),
      title: z.string().optional().describe('Article title (auto-generated if omitted)'),
      headings: z.string().optional().describe('JSON array of headings: [{"level":2,"text":"..."},...]'),
      faq_questions: z.string().optional().describe('Comma-separated FAQ questions'),
      target_word_count: z.number().optional().describe('Target word count (default: 2000)'),
    },
    async ({ keyword, title, headings, faq_questions, target_word_count }) => {
      // Build brief from parameters or generate one
      let brief;
      if (title && headings) {
        let parsedHeadings;
        try {
          parsedHeadings = JSON.parse(headings);
        } catch {
          parsedHeadings = [{ level: 2, text: keyword }];
        }
        brief = {
          keyword,
          title,
          metaDescription: `${title} - ${keyword}`,
          headings: parsedHeadings,
          targetWordCount: target_word_count || 2000,
          faqQuestions: faq_questions ? faq_questions.split(',').map((s) => s.trim()) : [],
          relatedKeywords: [],
          intent: 'informational',
        };
      } else {
        const briefResult = await generateBrief(keyword, [], null, config);
        if (!briefResult.success || !briefResult.data) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(briefResult, null, 2) }] };
        }
        brief = briefResult.data;
      }

      const result = await generateArticle(brief, config);

      // Save to DB as draft
      if (result.success && result.data) {
        const article = result.data;
        // Ensure project exists
        db.prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
          .run(config.projectId, config.projectId, config.domain);

        db.prepare(`
          INSERT OR REPLACE INTO articles
            (project_id, title, slug, status, content_html, schema_json, meta_description, word_count, created_at, updated_at)
          VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          config.projectId,
          article.title,
          article.slug,
          article.html,
          JSON.stringify(article.jsonLd),
          article.metaDescription,
          article.wordCount
        );
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_content_optimize',
    'Analyze existing article HTML and provide SEO optimization suggestions. Optionally rewrites the article.',
    {
      html: z.string().describe('Existing article HTML to optimize'),
      keyword: z.string().describe('Target keyword for optimization'),
    },
    async ({ html, keyword }) => {
      try {
        const result = await optimizeContent(html, keyword, config);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const res = fail('OPTIMIZE_FAILED', (err as Error).message, 'Check API key and article HTML format');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );
}

function registerPublisherTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_publish_draft',
    'Save an article as a draft in the local database.',
    {
      title: z.string().describe('Article title'),
      slug: z.string().describe('URL slug'),
      html: z.string().describe('Article HTML content'),
      meta_description: z.string().optional().describe('Meta description'),
      keyword: z.string().optional().describe('Target keyword'),
    },
    async ({ title, slug, html, meta_description, keyword }) => {
      try {
        db.prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
          .run(config.projectId, config.projectId, config.domain);

        const wordCount = html.replace(/<[^>]+>/g, '').length;

        db.prepare(`
          INSERT OR REPLACE INTO articles
            (project_id, title, slug, status, content_html, meta_description, word_count, created_at, updated_at)
          VALUES (?, ?, ?, 'draft', ?, ?, ?, datetime('now'), datetime('now'))
        `).run(config.projectId, title, slug, html, meta_description || '', wordCount);

        // Link to keyword if provided
        if (keyword) {
          const kw = db.prepare('SELECT id FROM keywords WHERE project_id = ? AND keyword = ?')
            .get(config.projectId, keyword) as { id: number } | undefined;
          if (kw) {
            db.prepare('UPDATE articles SET target_keyword_id = ? WHERE project_id = ? AND slug = ?')
              .run(kw.id, config.projectId, slug);
          }
        }

        const res = ok({ slug, status: 'draft', wordCount });
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail('DRAFT_FAILED', (err as Error).message, 'Check article data and database');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_publish_push',
    'Publish a draft article to the configured publishing target (markdown files, WordPress, etc.).',
    {
      slug: z.string().describe('Slug of the draft article to publish'),
    },
    async ({ slug }) => {
      const article = db
        .prepare('SELECT * FROM articles WHERE project_id = ? AND slug = ?')
        .get(config.projectId, slug) as Record<string, unknown> | undefined;

      if (!article) {
        const res = fail('NOT_FOUND', `No article found with slug "${slug}"`, 'Check the slug or use seo_publish_list to see available drafts');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }

      // Get keyword for the article
      let keywords: string[] = [];
      if (article.target_keyword_id) {
        const kw = db.prepare('SELECT keyword FROM keywords WHERE id = ?').get(article.target_keyword_id) as { keyword: string } | undefined;
        if (kw) keywords = [kw.keyword];
      }

      // Create adapter based on config
      const adapter = createMarkdownAdapter({
        outputDir: config.publisher.config.outputDir || './content',
      });

      const result = await adapter.publish({
        title: article.title as string,
        slug: article.slug as string,
        contentHtml: article.content_html as string,
        metaDescription: (article.meta_description as string) || '',
        keywords,
        schemaJson: article.schema_json as string | undefined,
      });

      if (result.success) {
        db.prepare("UPDATE articles SET status = 'published', published_url = ?, published_at = datetime('now') WHERE project_id = ? AND slug = ?")
          .run(result.url, config.projectId, slug);
      }

      const res = result.success
        ? ok({ slug, url: result.url, status: 'published' })
        : fail('PUBLISH_FAILED', result.error || 'Unknown error', 'Check publisher config and permissions');
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    'seo_publish_list',
    'List all articles in the database with their publish status.',
    {
      status: z.string().optional().describe('Filter by status: draft, published, needs_update'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ status, limit }) => {
      const maxResults = limit || 50;
      let query = 'SELECT title, slug, status, word_count, published_url, published_at, created_at FROM articles WHERE project_id = ?';
      const params: unknown[] = [config.projectId];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(maxResults);

      const rows = db.prepare(query).all(...params);
      const res = ok({ articles: rows, total: rows.length });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );
}
