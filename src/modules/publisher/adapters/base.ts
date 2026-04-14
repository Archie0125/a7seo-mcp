export interface ArticlePayload {
  title: string;
  slug: string;
  contentHtml: string;
  metaDescription: string;
  keywords: string[];
  category?: string;
  author?: string;
  schemaJson?: string;
}

export interface PublishResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface PublisherAdapter {
  name: string;
  publish(article: ArticlePayload): Promise<PublishResult>;
  list?(): Promise<{ slug: string; url: string; status: string }[]>;
}
