/**
 * In-page script executed inside Playwright page to discover visible elements,
 * generate stable CSS selectors, and detect fragile/auto-generated selectors (Section 9.10).
 */

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  selector: string;
  textPreview: string;
  isFragile: boolean;
  tagName: string;
}

/**
 * Self-contained JavaScript string evaluated directly via page.evaluate().
 * Written as a raw string to prevent tsx/esbuild from injecting '__name' helper into browser scope.
 */
export const ELEMENT_INSPECTOR_SCRIPT = `(() => {
  const results = [];
  const seenSelectors = new Set();

  const IGNORED_TAGS = new Set([
    'HTML', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME',
    'LINK', 'META', 'SVG', 'PATH', 'BR', 'HR'
  ]);

  function isGeneratedHash(val) {
    if (!val) return false;
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(val)) return true;
    if (/[0-9a-f]{7,}/i.test(val)) return true;
    if (/^:r[0-9a-z]+:$/i.test(val)) return true;
    if (/^(css|sc)-[a-z0-9]+/i.test(val)) return true;
    if (/^_[a-zA-Z0-9]{5,}$/.test(val)) return true;
    if (val.length >= 8 && /[0-9]/.test(val) && /[a-zA-Z]/.test(val) && !val.includes('-') && !val.includes('_')) {
      return true;
    }
    return false;
  }

  function isSafeIdentifier(id) {
    return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(id);
  }

  function generateSelector(el) {
    if (el.id && isSafeIdentifier(el.id)) {
      const idFragile = isGeneratedHash(el.id);
      const idSelector = '#' + el.id;
      try {
        if (document.querySelectorAll(idSelector).length === 1) {
          return { selector: idSelector, isFragile: idFragile };
        }
      } catch {}
    }

    const preferredDataAttrs = ['data-testid', 'data-id', 'data-component', 'data-qa', 'data-cy'];
    for (const attr of preferredDataAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = '[' + attr + '="' + val + '"]';
        try {
          if (document.querySelectorAll(sel).length === 1) {
            return { selector: sel, isFragile: isGeneratedHash(val) };
          }
        } catch {}
      }
    }

    const tag = el.tagName.toLowerCase();
    const rawClasses = Array.from(el.classList).filter(c => c && !c.startsWith('hover:') && !c.startsWith('focus:'));
    const stableClasses = rawClasses.filter(c => !isGeneratedHash(c) && isSafeIdentifier(c));
    const hasFragileClass = rawClasses.some(c => isGeneratedHash(c));

    let baseSelector = tag;
    if (stableClasses.length > 0) {
      baseSelector += '.' + stableClasses.slice(0, 2).join('.');
    }

    try {
      const matches = document.querySelectorAll(baseSelector);
      if (matches.length === 1) {
        return { selector: baseSelector, isFragile: hasFragileClass || stableClasses.length === 0 };
      }
    } catch {}

    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(child => child.tagName === el.tagName);
      const index = siblings.indexOf(el) + 1;
      const nth = index > 0 ? ':nth-of-type(' + index + ')' : '';
      const parentSel = parent.id && isSafeIdentifier(parent.id) ? '#' + parent.id + ' > ' : '';
      return {
        selector: parentSel + baseSelector + nth,
        isFragile: true,
      };
    }

    return { selector: baseSelector, isFragile: true };
  }

  const allElements = document.querySelectorAll('*');
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    if (IGNORED_TAGS.has(el.tagName)) continue;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (rect.width < 10 || rect.height < 10) continue;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    let text = (el.innerText || el.textContent || '').trim();
    text = text.replace(/\\s+/g, ' ').slice(0, 80);

    if (!text) {
      text = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
    }

    if (!text && el.children.length === 0 && el.tagName !== 'IMG' && el.tagName !== 'INPUT') {
      continue;
    }

    const { selector, isFragile } = generateSelector(el);
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    results.push({
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      selector,
      textPreview: text,
      isFragile,
      tagName: el.tagName.toLowerCase(),
    });

    if (results.length >= 150) break;
  }

  return results;
})()`;
