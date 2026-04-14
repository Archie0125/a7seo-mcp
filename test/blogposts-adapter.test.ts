import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

// We'll import the adapter after creating it
// For now, define the test expectations

const TEST_DIR = resolve('./test-data/blogposts-adapter');
const TEST_FILE = resolve(TEST_DIR, 'blogPosts.ts');

const MINIMAL_BLOG_FILE = `/**
 * 部落格文章資料
 * 2 篇文章
 */

export interface BlogPost {
  id: string;
  title: string;
  category: string;
  date: string;
  author: string;
  desc: string;
  image: string;
  slug: string;
  metaDescription: string;
  keywords: string[];
  content: string;
}

const img = (blog: number, file: string) => \`/images/blog-\${blog}/\${file}\`;
const IMG = {
  b1: (f: string) => img(1, f), b2: (f: string) => img(2, f),
};
export const IMAGE_FALLBACK = "https://example.com/fallback.jpg";

export const blogPosts: BlogPost[] = [
  {
    id: "first-post",
    slug: "first-post",
    title: "First Post",
    category: "Test",
    date: "2026.01.01",
    author: "Test Author",
    desc: "First test post",
    image: IMG.b1("cover.svg"),
    metaDescription: "First test post description",
    keywords: ["test"],
    content: \`
      <h2>Hello</h2>
      <p>World</p>
    \`,
  },
  {
    id: "second-post",
    slug: "second-post",
    title: "Second Post",
    category: "Test",
    date: "2026.01.02",
    author: "Test Author",
    desc: "Second test post",
    image: IMG.b2("cover.svg"),
    metaDescription: "Second test post description",
    keywords: ["test"],
    content: \`
      <h2>Post 2</h2>
      <p>Content</p>
    \`,
  },
];
`;

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEST_FILE, MINIMAL_BLOG_FILE, 'utf-8');
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

// Import adapter dynamically after creation
let createBlogPostsTsAdapter: typeof import('../src/modules/publisher/adapters/blogposts-ts.js').createBlogPostsTsAdapter;

describe('BlogPostsTsAdapter', () => {
  beforeEach(async () => {
    setup();
    const mod = await import('../src/modules/publisher/adapters/blogposts-ts.js');
    createBlogPostsTsAdapter = mod.createBlogPostsTsAdapter;
  });

  afterEach(() => {
    cleanup();
  });

  it('inserts a new blog post entry into blogPosts.ts', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    const result = await adapter.publish({
      title: 'Third Post Title',
      slug: 'third-post',
      contentHtml: '<h2>New Content</h2>\n<p>This is new.</p>',
      metaDescription: 'A third test post',
      keywords: ['new', 'test'],
      category: 'SEO',
      author: 'A7SEO',
    });

    assert.ok(result.success, `Publish failed: ${result.error}`);

    const content = readFileSync(TEST_FILE, 'utf-8');

    // Should contain the new post
    assert.ok(content.includes('"third-post"'), 'Slug not found');
    assert.ok(content.includes('Third Post Title'), 'Title not found');
    assert.ok(content.includes('A third test post'), 'Meta description not found');
    assert.ok(content.includes('New Content'), 'Content not found');
  });

  it('updates the article count comment', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    await adapter.publish({
      title: 'Count Test',
      slug: 'count-test',
      contentHtml: '<p>Test</p>',
      metaDescription: 'test',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    assert.ok(content.includes('3 篇'), 'Count should be updated to 3');
  });

  it('adds IMG helper for the new blog number', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    await adapter.publish({
      title: 'IMG Test',
      slug: 'img-test',
      contentHtml: '<p>Test</p>',
      metaDescription: 'test',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    assert.ok(content.includes('b3:'), 'Should add b3 IMG helper');
    assert.ok(content.includes('img(3, f)'), 'Should reference blog 3');
  });

  it('escapes backticks and template literals in content', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    await adapter.publish({
      title: 'Escape Test',
      slug: 'escape-test',
      contentHtml: '<p>Code: `const x = ${y}`</p>',
      metaDescription: 'test',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    // Backticks and ${} should be escaped inside template literal
    assert.ok(content.includes('\\`'), 'Backticks should be escaped with backslash');
    assert.ok(content.includes('\\${'), 'Template literals should be escaped');
  });

  it('escapes double quotes in title and description', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    await adapter.publish({
      title: 'Title with "quotes"',
      slug: 'quotes-test',
      contentHtml: '<p>Test</p>',
      metaDescription: 'Description with "quotes"',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    assert.ok(content.includes('Title with \\"quotes\\"'), 'Title quotes should be escaped');
    assert.ok(content.includes('Description with \\"quotes\\"'), 'Description quotes should be escaped');
  });

  it('inserts before the closing ]; of blogPosts array', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    await adapter.publish({
      title: 'Array End Test',
      slug: 'array-end-test',
      contentHtml: '<p>Test</p>',
      metaDescription: 'test',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    // The file should still end with ];
    assert.ok(content.trimEnd().endsWith('];'), 'File should end with ];');
    // The new post should come before ];
    const arrayEnd = content.lastIndexOf('];');
    const newPostIdx = content.indexOf('array-end-test');
    assert.ok(newPostIdx < arrayEnd, 'New post should be before ];');
  });

  it('detects next blog number from existing entries', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    // First insert should be blog 3 (after 1 and 2)
    await adapter.publish({
      title: 'Number Test',
      slug: 'number-test',
      contentHtml: '<p>Test</p>',
      metaDescription: 'test',
      keywords: [],
    });

    const content = readFileSync(TEST_FILE, 'utf-8');
    assert.ok(content.includes('IMG.b3("cover.svg")'), 'Should use blog number 3');
  });

  it('list returns existing posts from file', async () => {
    const adapter = createBlogPostsTsAdapter({
      blogPostsPath: TEST_FILE,
      imagesDir: resolve(TEST_DIR, 'images'),
    });

    const list = await adapter.list!();
    assert.ok(list.length >= 2);
    assert.ok(list.some(a => a.slug === 'first-post'));
    assert.ok(list.some(a => a.slug === 'second-post'));
  });
});
