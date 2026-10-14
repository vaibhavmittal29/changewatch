import * as cheerio from 'cheerio';
import { isTag, isText, type Node } from 'domhandler';

const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'tr', 'td', 'th', 'section', 'article', 'header',
  'footer', 'nav', 'main', 'aside', 'blockquote', 'pre', 'hr', 'br'
]);

/**
 * Single extraction contract (Section 9.1).
 * Extracts text from sanitized HTML DOM while inserting line breaks at block-level
 * element boundaries. Used uniformly by checker, picker, and diff engine.
 */
export function extractText(
  domHtml: string,
  includeSelectors: string[] = [],
  ignoreSelectors: string[] = []
): string {
  if (!domHtml || !domHtml.trim()) {
    return '';
  }

  const $ = cheerio.load(domHtml);

  // 1. Remove elements matching ignore selectors
  for (const selector of ignoreSelectors) {
    if (selector && selector.trim()) {
      try {
        $(selector.trim()).remove();
      } catch (err) {
        console.warn(`[extractText] Invalid ignore selector '${selector}':`, err);
      }
    }
  }

  // 2. Select roots to extract from
  let targetElements: cheerio.Cheerio<Node>;
  const validIncludes = includeSelectors.filter(s => s && s.trim());

  if (validIncludes.length > 0) {
    const combinedSelector = validIncludes.join(', ');
    try {
      targetElements = $(combinedSelector) as unknown as cheerio.Cheerio<Node>;
    } catch {
      targetElements = ($('body').length ? $('body') : $.root()) as unknown as cheerio.Cheerio<Node>;
    }
  } else {
    targetElements = ($('body').length ? $('body') : $.root()) as unknown as cheerio.Cheerio<Node>;
  }

  if (targetElements.length === 0) {
    return '';
  }

  // 3. Recursive text extraction with block-level line breaks
  const lines: string[] = [];
  let currentLine = '';

  function flushLine() {
    const trimmed = currentLine.trim();
    if (trimmed) {
      lines.push(trimmed);
    }
    currentLine = '';
  }

  function walk(node: Node) {
    if (isText(node)) {
      currentLine += node.data || '';
      return;
    }

    if (isTag(node)) {
      const tagName = node.name.toLowerCase();
      const isBlock = BLOCK_ELEMENTS.has(tagName);

      if (isBlock) {
        flushLine();
      }

      if (tagName === 'br') {
        flushLine();
        return;
      }

      const children = node.children || [];
      for (const child of children) {
        walk(child);
      }

      if (isBlock) {
        flushLine();
      }
    }
  }

  targetElements.each((_, elem) => {
    walk(elem);
    flushLine();
  });

  return lines.join('\n').trim();
}
