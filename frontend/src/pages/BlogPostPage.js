// BlogPostPage.js
// -----------------------------------------------------------------------------
// /blog/:slug - a single blog article rendered with an editorial layout:
// reading-progress bar, category chip + title hero, a big featured image, a
// sticky "on this page" table of contents (built from the H2 sections), the
// article body (headings / paragraphs / lists), an FAQ block (+ FAQ JSON-LD),
// a demo CTA, and a "keep reading" related-posts row. Unknown slugs redirect
// back to the blog index.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import ContentLayout from '../components/ContentLayout';
import useSEO from '../utils/useSEO';
import JsonLd, { buildFaqSchema } from '../components/JsonLd';
import { useDemoPopup } from '../components/DemoPopupContext';
import { BLOG_POSTS, getPostBySlug } from '../data/blogPosts';
import './Blog.css';

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function renderBlock(block, i) {
  switch (block.type) {
    case 'h2':
      return <h2 id={slugify(block.text)} key={i}>{block.text}</h2>;
    case 'h3':
      return <h3 key={i}>{block.text}</h3>;
    case 'ul':
      return (
        <ul key={i}>
          {block.items.map((item, j) => <li key={j}>{item}</li>)}
        </ul>
      );
    case 'p':
    default:
      return <p key={i}>{block.text}</p>;
  }
}

function BlogPostPage() {
  const { slug } = useParams();
  const post = getPostBySlug(slug);
  const { openDemoPopup } = useDemoPopup();
  const barRef = useRef(null);

  useSEO(
    post
      ? { title: post.seo.title, description: post.seo.description, canonical: post.seo.canonical }
      : { title: 'Blog | Botella AI', noindex: true }
  );

  // Reading-progress bar - width tracks how far down the article you've scrolled.
  useEffect(() => {
    if (!post) return undefined;
    const onScroll = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      const pct = max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 0;
      if (barRef.current) barRef.current.style.width = `${pct}%`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [post, slug]);

  if (!post) return <Navigate to="/blog" replace />;

  const sections = post.blocks
    .filter((b) => b.type === 'h2')
    .map((b) => ({ id: slugify(b.text), text: b.text }));
  const related = BLOG_POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);

  return (
    <ContentLayout>
      <div className="blog-progress" aria-hidden="true"><span ref={barRef} /></div>

      <article className="blog-post">
        <Link to="/blog" className="blog-back">← All articles</Link>

        <header className="blog-post-head">
          <span className="blog-chip">{post.category}</span>
          <h1>{post.title}</h1>
          <div className="blog-post-meta">
            <span>Botella AI</span>
            <span className="blog-dot" />
            <span>{post.readMins} min read</span>
          </div>
        </header>

        <figure className="blog-post-figure">
          <img src={post.image} alt={post.imageAlt} />
        </figure>

        <div className="blog-post-layout">
          <aside className="blog-toc">
            <div className="blog-toc-inner">
              <div className="blog-toc-title">On this page</div>
              <nav>
                {sections.map((s) => (
                  <a key={s.id} href={`#${s.id}`}>{s.text}</a>
                ))}
                <a href="#faq">Frequently Asked Questions</a>
              </nav>
            </div>
          </aside>

          <div className="blog-post-body">
            {post.blocks.map(renderBlock)}

            <h2 id="faq">Frequently Asked Questions</h2>
            <div className="blog-faqs">
              {post.faqs.map((f, i) => (
                <div className="blog-faq" key={i}>
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>

            <div className="blog-cta">
              <div className="blog-cta-eyebrow">Botella AI</div>
              <h2>See Botella AI in action</h2>
              <p>Turn your sales and inventory data into clear, actionable insights - built for liquor retailers.</p>
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
            </div>
          </div>
        </div>

        {related.length > 0 && (
          <section className="blog-related">
            <h2>Keep reading</h2>
            <div className="blog-related-grid">
              {related.map((p) => (
                <Link key={p.slug} to={`/blog/${p.slug}`} className="blog-card">
                  <div className="blog-card-img">
                    <img src={p.image} alt={p.imageAlt} loading="lazy" />
                  </div>
                  <div className="blog-card-body">
                    <span className="blog-card-meta">{p.category} · {p.readMins} min read</span>
                    <h3>{p.title}</h3>
                    <span className="blog-card-more">Read article →</span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </article>

      <JsonLd data={buildFaqSchema(post.faqs)} />
    </ContentLayout>
  );
}

export default BlogPostPage;
