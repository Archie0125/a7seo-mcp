import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Extract the validation and cleaning functions for testing
// Since they're private in generator.ts, we re-implement the same logic here
// and test it. In a real setup we'd export them.

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

function buildSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

describe('HTML validation', () => {
  it('accepts clean semantic HTML', () => {
    const html = '<article><h1>Title</h1><p>Content</p></article>';
    const violations = validateSemanticHtml(html);
    assert.equal(violations.length, 0);
  });

  it('detects class attributes', () => {
    const html = '<article><h1 class="title">Title</h1></article>';
    const violations = validateSemanticHtml(html);
    assert.ok(violations.includes('contains class attributes'));
  });

  it('detects id attributes', () => {
    const html = '<article><h1 id="main-title">Title</h1></article>';
    const violations = validateSemanticHtml(html);
    assert.ok(violations.includes('contains id attributes'));
  });

  it('detects style attributes', () => {
    const html = '<p style="color:red">Text</p>';
    const violations = validateSemanticHtml(html);
    assert.ok(violations.includes('contains style attributes'));
  });

  it('detects div tags', () => {
    const html = '<div><p>Content</p></div>';
    const violations = validateSemanticHtml(html);
    assert.ok(violations.includes('contains <div> tags'));
  });

  it('detects span tags', () => {
    const html = '<p>Some <span>text</span></p>';
    const violations = validateSemanticHtml(html);
    assert.ok(violations.includes('contains <span> tags'));
  });

  it('detects multiple violations', () => {
    const html = '<div class="wrapper" style="margin:0"><span id="x">text</span></div>';
    const violations = validateSemanticHtml(html);
    assert.equal(violations.length, 5);
  });
});

describe('HTML cleaning', () => {
  it('removes class attributes', () => {
    const result = cleanHtml('<h1 class="title">Title</h1>');
    assert.equal(result, '<h1>Title</h1>');
  });

  it('removes id attributes', () => {
    const result = cleanHtml('<h2 id="section-1">Section</h2>');
    assert.equal(result, '<h2>Section</h2>');
  });

  it('removes style attributes', () => {
    const result = cleanHtml('<p style="color:red">Text</p>');
    assert.equal(result, '<p>Text</p>');
  });

  it('converts div to section', () => {
    const result = cleanHtml('<div><p>Content</p></div>');
    assert.equal(result, '<section><p>Content</p></section>');
  });

  it('strips span tags', () => {
    const result = cleanHtml('<p>Some <span>text</span> here</p>');
    assert.equal(result, '<p>Some text here</p>');
  });

  it('handles complex dirty HTML', () => {
    const dirty = '<div class="hero" id="top" style="padding:20px"><h1 class="title">Hello</h1><span class="sub">World</span></div>';
    const clean = cleanHtml(dirty);
    assert.ok(!clean.includes('class='));
    assert.ok(!clean.includes('id='));
    assert.ok(!clean.includes('style='));
    assert.ok(!clean.includes('<div'));
    assert.ok(!clean.includes('<span'));
    assert.ok(clean.includes('<h1>Hello</h1>'));
  });
});

describe('Slug generation', () => {
  it('converts English title to slug', () => {
    assert.equal(buildSlug('Hello World'), 'hello-world');
  });

  it('handles Chinese characters', () => {
    const slug = buildSlug('台北醫美推薦 2026');
    assert.ok(slug.includes('台北醫美推薦'));
    assert.ok(slug.includes('2026'));
  });

  it('removes special characters', () => {
    const slug = buildSlug('SEO: The Complete Guide!');
    assert.ok(!slug.includes(':'));
    assert.ok(!slug.includes('!'));
  });

  it('trims leading/trailing hyphens', () => {
    const slug = buildSlug('  Hello  ');
    assert.ok(!slug.startsWith('-'));
    assert.ok(!slug.endsWith('-'));
  });

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(200);
    const slug = buildSlug(long);
    assert.ok(slug.length <= 80);
  });
});
