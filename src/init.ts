import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface InitOptions {
  projectId: string;
  domain: string;
  language: string;
  region: string;
  publisherAdapter: 'markdown-files' | 'blogposts-ts' | 'wordpress';
  outputPath: string;
  overwrite?: boolean;
}

export function generateConfig(options: InitOptions): boolean {
  if (existsSync(options.outputPath) && options.overwrite === false) {
    return false;
  }

  const dir = dirname(options.outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const publisherConfig = getPublisherConfig(options.publisherAdapter);

  const config = {
    projectId: options.projectId,
    domain: options.domain,
    language: options.language,
    region: options.region,
    dbPath: './data/seo-engine.db',
    publisher: {
      adapter: options.publisherAdapter,
      config: publisherConfig,
    },
    googleAds: {
      clientId: '',
      clientSecret: '',
      developerToken: '',
      refreshToken: '',
      customerId: '',
    },
    dataforseo: {
      login: '',
      password: '',
    },
  };

  writeFileSync(options.outputPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return true;
}

function getPublisherConfig(adapter: string): Record<string, string> {
  switch (adapter) {
    case 'blogposts-ts':
      return {
        blogPostsPath: './data/blogPosts.ts',
        imagesDir: './public/images',
      };
    case 'wordpress':
      return {
        apiUrl: 'https://your-site.com/wp-json/wp/v2',
        username: '',
        applicationPassword: '',
      };
    case 'markdown-files':
    default:
      return {
        outputDir: './content',
      };
  }
}
