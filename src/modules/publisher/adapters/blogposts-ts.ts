import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { PublisherAdapter, ArticlePayload, PublishResult } from './base.js';

export function createBlogPostsTsAdapter(config: {
  blogPostsPath: string;
  imagesDir: string;
}): PublisherAdapter {
  const blogPostsPath = resolve(config.blogPostsPath);
  const imagesDir = resolve(config.imagesDir);

  return {
    name: 'blogposts-ts',

    async publish(article: ArticlePayload): Promise<PublishResult> {
      try {
        if (!existsSync(blogPostsPath)) {
          return { success: false, error: `blogPosts.ts not found at ${blogPostsPath}` };
        }

        let fileContent = readFileSync(blogPostsPath, 'utf-8');

        // Detect next blog number from IMG helpers
        const blogNum = detectNextBlogNum(fileContent);

        // 1. Update article count comment
        const countMatch = fileContent.match(/(\d+)\s*篇/);
        if (countMatch) {
          const oldCount = parseInt(countMatch[1]);
          fileContent = fileContent.replace(
            `${oldCount} 篇`,
            `${oldCount + 1} 篇`
          );
        }

        // 2. Add IMG helper entry
        const imgHelperRegex = /b(\d+):\s*\(f:\s*string\)\s*=>\s*img\(\d+,\s*f\)/g;
        let lastImgMatch: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = imgHelperRegex.exec(fileContent)) !== null) {
          lastImgMatch = m;
        }

        if (lastImgMatch) {
          const insertAfter = lastImgMatch[0];
          const newEntry = `b${blogNum}: (f: string) => img(${blogNum}, f)`;
          fileContent = fileContent.replace(
            insertAfter,
            `${insertAfter},\n  ${newEntry}`
          );
        }

        // 3. Escape content for template literal
        const escapedContent = article.contentHtml
          .replace(/\\/g, '\\\\')
          .replace(/`/g, '\\`')
          .replace(/\$\{/g, '\\${')
          .replace(/\n/g, '\n      ')
          .trim();

        // 4. Build the blog post entry
        const date = new Date().toLocaleDateString('zh-TW', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).replace(/\//g, '.');

        const keywordsStr = article.keywords.map(k => `"${k}"`).join(', ');
        const escapedTitle = article.title.replace(/"/g, '\\"');
        const escapedDesc = (article.metaDescription || '').replace(/"/g, '\\"');

        const newPost = `
  {
    id: "${article.slug}",
    slug: "${article.slug}",
    title: "${escapedTitle}",
    category: "${article.category || 'SEO'}",
    date: "${date}",
    author: "${article.author || 'A7SEO'}",
    desc: "${escapedDesc}",
    image: IMG.b${blogNum}("cover.svg"),
    metaDescription: "${escapedDesc}",
    keywords: [${keywordsStr}],
    content: \`
      ${escapedContent}
    \`,
  }`;

        // 5. Insert before the closing ]; of blogPosts array
        const arrayEndIdx = fileContent.lastIndexOf('];');
        if (arrayEndIdx === -1) {
          return { success: false, error: 'Could not find blogPosts array end (];)' };
        }

        fileContent =
          fileContent.slice(0, arrayEndIdx) +
          ',' +
          newPost +
          '\n' +
          fileContent.slice(arrayEndIdx);

        // Clean double commas
        fileContent = fileContent.replace(/,\s*,/g, ',');

        // 6. Ensure images directory exists
        const blogImgDir = resolve(imagesDir, `blog-${blogNum}`);
        if (!existsSync(blogImgDir)) {
          mkdirSync(blogImgDir, { recursive: true });
        }

        // 7. Write the file
        writeFileSync(blogPostsPath, fileContent, 'utf-8');

        return {
          success: true,
          url: `/blog/${article.slug}`,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }
    },

    async list() {
      if (!existsSync(blogPostsPath)) return [];

      const content = readFileSync(blogPostsPath, 'utf-8');
      const entries: { slug: string; url: string; status: string }[] = [];

      // Extract slugs from the file using regex
      const slugRegex = /slug:\s*"([^"]+)"/g;
      let match;
      while ((match = slugRegex.exec(content)) !== null) {
        entries.push({
          slug: match[1],
          url: `/blog/${match[1]}`,
          status: 'published',
        });
      }

      return entries;
    },
  };
}

function detectNextBlogNum(fileContent: string): number {
  const imgHelperRegex = /b(\d+):\s*\(f:\s*string\)\s*=>\s*img\(/g;
  let maxNum = 0;
  let match;
  while ((match = imgHelperRegex.exec(fileContent)) !== null) {
    const num = parseInt(match[1]);
    if (num > maxNum) maxNum = num;
  }
  return maxNum + 1;
}
