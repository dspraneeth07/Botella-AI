// BlogIndexPage.js
// -----------------------------------------------------------------------------
// /blog - blog landing page. A hero, a large "featured" post (the first one),
// then the remaining posts as cards. Shares the public site chrome via
// ContentLayout (header, footer, back-to-top, cursor).
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import ContentLayout from '../components/ContentLayout';
import useSEO from '../utils/useSEO';
import { BLOG_POSTS } from '../data/blogPosts';
import './Blog.css';

function BlogIndexPage() {
  useSEO({
    title: 'Blog | Botella AI - Insights for Liquor Retailers',
    description:
      'Guides and insights on AI inventory management, sales analytics, sales intelligence, and margin optimization for liquor stores.',
    canonical: 'https://botella.ai/blog/',
  });

  const [featured, ...rest] = BLOG_POSTS;

  return (
    <ContentLayout>
      <div className="cp-rich blog-index">
        <header className="blog-index-hero">
          <div className="cp-eyebrow-v2">Botella AI Blog</div>
          <h1>Insights for <i>liquor retailers</i></h1>
          <p>
            Practical guides on inventory, analytics, sales intelligence, and
            margins - built for modern liquor stores.
          </p>
        </header>

        {featured && (
          <Link to={`/blog/${featured.slug}`} className="blog-featured">
            <div className="blog-featured-img">
              <img src={featured.image} alt={featured.imageAlt} />
            </div>
            <div className="blog-featured-body">
              <span className="blog-chip">Featured · {featured.category}</span>
              <h2>{featured.title}</h2>
              <p>{featured.excerpt}</p>
              <div className="blog-featured-foot">
                <span className="blog-card-more">Read article →</span>
                <span className="blog-card-meta">{featured.readMins} min read</span>
              </div>
            </div>
          </Link>
        )}

        <div className="blog-grid">
          {rest.map((post) => (
            <Link key={post.slug} to={`/blog/${post.slug}`} className="blog-card">
              <div className="blog-card-img">
                <img src={post.image} alt={post.imageAlt} loading="lazy" />
                <span className="blog-card-chip">{post.category}</span>
              </div>
              <div className="blog-card-body">
                <span className="blog-card-meta">{post.readMins} min read</span>
                <h2>{post.title}</h2>
                <p>{post.excerpt}</p>
                <span className="blog-card-more">Read article →</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </ContentLayout>
  );
}

export default BlogIndexPage;
