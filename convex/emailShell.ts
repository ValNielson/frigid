/**
 * The shell every frigid email shares, and the helpers that make one safe to
 * build.
 *
 * Five files had grown their own escapeHtml and four had their own copy of the
 * unsubscribe URL. They had already drifted: only one of the five escaped a
 * single quote. One strict copy removes the question of which file you happen
 * to be reading.
 *
 * Free of Node imports and of any work at module load, because
 * onboardingSummary.ts imports this and the home screen imports that.
 */

import { requireEnv } from "./env";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An href we are willing to put in a message, or null.
 *
 * Coupon source URLs arrive from Firecrawl search results, so the scheme is not
 * ours to assume. Escaping alone keeps the attribute from breaking out but says
 * nothing about where the link goes.
 */
export function safeHref(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** The one-click opt-out link, built the same way for every message. */
export function unsubscribeUrl(token: string): string {
  const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
  return `${siteUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Headers that let Gmail and Apple Mail offer their native one-click
 * unsubscribe, which POSTs and so is not tripped by link scanners.
 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** The plain-text opt-out line, so the text and HTML parts cannot disagree. */
export function unsubscribeLine(url: string): string {
  return `Unsubscribe: ${url}`;
}

/**
 * The card shell. `body` and `footer` are HTML the caller has already escaped;
 * `title` is escaped here because it is the one field that is always plain text.
 *
 * Inline styles with hardcoded hex, matching the palette in globals.css,
 * because Tailwind does not exist in a mail client.
 */
export function emailCard(options: {
  title: string;
  body: string;
  unsubscribeUrl: string;
  footer?: string;
  maxWidthPx?: number;
}): string {
  const { title, body, unsubscribeUrl: url, footer, maxWidthPx = 560 } = options;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1b24;">
    <div style="max-width:${maxWidthPx}px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #dbe7ef;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5d7c8f;">frigid</p>
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(title)}</h1>
      ${body}
      <hr style="border:none;border-top:1px solid #e6eef4;margin:32px 0 16px;" />
      ${footer === undefined ? "" : `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#5d7c8f;">${footer}</p>`}
      <p style="margin:0;font-size:12px;line-height:1.6;color:#7d97a7;">
        <a href="${escapeHtml(url)}" style="color:#7d97a7;">Unsubscribe from frigid emails</a>
      </p>
    </div>
  </body>
</html>`;
}
