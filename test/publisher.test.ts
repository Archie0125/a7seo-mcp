import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownAdapter } from '../src/modules/publisher/adapters/markdown-files.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const TEST_OUTPUT = resolve('./test-data/test-content');

describe('MarkdownAdapter', () => {
  beforeEach(() => {
    mkdirSync(resolve('./test-data'), { recursive: true });
    if (existsSync(TEST_OUTPUT)) rmSync(TEST_OUTPUT, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_OUTPUT)) rmSync(TEST_OUTPUT, { recursive: true });
  });

  it('publishes article as markdown file', async () => {
    const adapter = createMarkdownAdapter({ outputDir: TEST_OUTPUT });

    const result = await adapter.publish({
      title: 'Test Article',
      slug: 'test-article',
      contentHtml: '<article><h1>Test</h1><p>Content</p></article>',
      metaDescription: 'A test article',
      keywords: ['test', 'article'],
    });

    assert.ok(result.success);
    assert.ok(result.url);

    const filePath = join(TEST_OUTPUT, 'test-article.md');
    assert.ok(existsSync(filePath));

    const content = readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('title: "Test Article"'));
    assert.ok(content.includes('slug: "test-article"'));
    assert.ok(content.includes('description: "A test article"'));
    assert.ok(content.includes('<article>'));
  });

  it('creates output directory if not exists', async () => {
    const newDir = resolve('./test-data/new-dir');
    if (existsSync(newDir)) rmSync(newDir, { recursive: true });

    const adapter = createMarkdownAdapter({ outputDir: newDir });
    const result = await adapter.publish({
      title: 'Test',
      slug: 'test',
      contentHtml: '<p>Hi</p>',
      metaDescription: 'test',
      keywords: [],
    });

    assert.ok(result.success);
    assert.ok(existsSync(newDir));

    rmSync(newDir, { recursive: true });
  });

  it('writes JSON-LD schema file separately', async () => {
    const adapter = createMarkdownAdapter({ outputDir: TEST_OUTPUT });

    await adapter.publish({
      title: 'Schema Test',
      slug: 'schema-test',
      contentHtml: '<p>Content</p>',
      metaDescription: 'test',
      keywords: [],
      schemaJson: '{"@type":"Article"}',
    });

    const schemaPath = join(TEST_OUTPUT, 'schema-test.schema.json');
    assert.ok(existsSync(schemaPath));
    const schema = readFileSync(schemaPath, 'utf-8');
    assert.equal(schema, '{"@type":"Article"}');
  });

  it('list returns published files', async () => {
    const adapter = createMarkdownAdapter({ outputDir: TEST_OUTPUT });

    await adapter.publish({
      title: 'Article 1',
      slug: 'article-1',
      contentHtml: '<p>One</p>',
      metaDescription: 'first',
      keywords: [],
    });
    await adapter.publish({
      title: 'Article 2',
      slug: 'article-2',
      contentHtml: '<p>Two</p>',
      metaDescription: 'second',
      keywords: [],
    });

    const list = await adapter.list!();
    assert.equal(list.length, 2);
    assert.ok(list.some((a) => a.slug === 'article-1'));
    assert.ok(list.some((a) => a.slug === 'article-2'));
  });

  it('handles frontmatter with special characters in title', async () => {
    const adapter = createMarkdownAdapter({ outputDir: TEST_OUTPUT });

    const result = await adapter.publish({
      title: 'Title with "quotes" and 中文',
      slug: 'special-chars',
      contentHtml: '<p>Content</p>',
      metaDescription: 'Description with "quotes"',
      keywords: ['key'],
    });

    assert.ok(result.success);
    const content = readFileSync(join(TEST_OUTPUT, 'special-chars.md'), 'utf-8');
    assert.ok(content.includes('Title with \\"quotes\\"'));
  });
});
