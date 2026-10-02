import { renderArticleHtml } from '@oremedia/contracts/article';
import { articleImages, type ArticleDocumentV1 } from '@oremedia/contracts/content';
import { useAssetUrls } from '../assets/use-assets';

export interface ArticlePreviewProps {
  article: ArticleDocumentV1;
  /** Signed preview URLs by asset version id; an image without one renders with its alt text alone. */
  imageUrls: ReadonlyMap<string, string>;
  featuredUrl?: string | null;
  /** The accessible name of the preview region. */
  label?: string;
}

/**
 * RA-09: the article exactly as it will publish: the one renderer (contracts/article.ts, allow-listed tags only),
 * the same markup the site receives, differing only in the image addresses (signed previews here, the site's own
 * copies there). Styled under `.article-preview` with the deployment's semantic tokens, so the preview reads in
 * the brand pack's type and colours in both themes. The HTML is the renderer's own output; nothing from a remote
 * site is ever placed here.
 */
export function ArticlePreview({
  article,
  imageUrls,
  featuredUrl,
  label = 'Article preview',
}: ArticlePreviewProps) {
  const html = renderArticleHtml(article, {
    imageUrl: (image) => imageUrls.get(image.assetVersionId) ?? null,
  });
  return (
    <article
      className="article-preview rounded-md border border-border bg-background p-4"
      aria-label={label}
      data-testid="article-preview"
    >
      {article.featuredImage && (
        <figure className="article-preview-featured" data-testid="article-preview-featured">
          {featuredUrl ? (
            <img src={featuredUrl} alt={article.featuredImage.alt} />
          ) : (
            <span className="text-xs text-muted-foreground">
              Featured image: {article.featuredImage.alt || '(no alt text)'}
            </span>
          )}
        </figure>
      )}
      <h1>{article.title}</h1>
      {article.excerpt && <p className="article-preview-excerpt">{article.excerpt}</p>}
      {/* The renderer escapes every text and allow-lists every tag; this is our own markup, not a site's. */}
      <div dangerouslySetInnerHTML={{ __html: html }} data-testid="article-preview-body" />
    </article>
  );
}

/** The preview of a live revision: every image's signed preview URL comes from the assets media endpoint. */
export function ArticlePreviewLive({ article, label }: { article: ArticleDocumentV1; label?: string }) {
  const ids = [...new Set(articleImages(article).map((i) => i.assetVersionId))];
  const urls = useAssetUrls(ids, 'web');
  return (
    <ArticlePreview
      article={article}
      imageUrls={urls}
      featuredUrl={article.featuredImage ? (urls.get(article.featuredImage.assetVersionId) ?? null) : null}
      {...(label ? { label } : {})}
    />
  );
}
