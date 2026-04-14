import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import type { PublisherAdapter, ArticlePayload, PublishResult } from './base.js';

export function createMarkdownAdapter(config: {
  outputDir: string;
}): PublisherAdapter {
  const outputDir = resolve(config.outputDir);

  return {
    name: 'markdown-files',

    async publish(article: ArticlePayload): Promise<PublishResult> {
      try {
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }

        const frontmatter = [
          '---',
          `title: "${article.title.replace(/"/g, '\\"')}"`,
          `slug: "${article.slug}"`,
          `description: "${article.metaDescription.replace(/"/g, '\\"')}"`,
          `keywords: [${article.keywords.map((k) => `"${k}"`).join(', ')}]`,
          article.category ? `category: "${article.category}"` : null,
          article.author ? `author: "${article.author}"` : null,
          `date: "${new Date().toISOString().split('T')[0]}"`,
          '---',
          '',
        ]
          .filter(Boolean)
          .join('\n');

        const content = frontmatter + article.contentHtml;
        const filePath = join(outputDir, `${article.slug}.md`);

        writeFileSync(filePath, content, 'utf-8');

        // Write JSON-LD separately if provided
        if (article.schemaJson) {
          const schemaPath = join(outputDir, `${article.slug}.schema.json`);
          writeFileSync(schemaPath, article.schemaJson, 'utf-8');
        }

        return {
          success: true,
          url: filePath,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }
    },

    async list() {
      if (!existsSync(outputDir)) return [];

      const files = readdirSync(outputDir).filter((f) => f.endsWith('.md'));
      return files.map((f) => {
        const content = readFileSync(join(outputDir, f), 'utf-8');
        const slugMatch = f.replace('.md', '');
        const titleMatch = content.match(/^title:\s*"(.+)"/m);
        return {
          slug: slugMatch,
          url: join(outputDir, f),
          status: 'published',
          title: titleMatch?.[1] || slugMatch,
        };
      });
    },
  };
}
