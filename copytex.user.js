// ==UserScript==
// @name         CopyTeX
// @namespace    copytex
// @version      0.3.3
// @description  复制网页上的 TeX
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @author       sgt57
// @license      MIT
// @homepageURL  https://github.com/sgt57/copytex
// @supportURL   https://github.com/sgt57/copytex/issues
// ==/UserScript==

(() => {
  'use strict';

  // 全局 KaTeX：保留之后渲染的 HTML-only 公式源码。
  const hooked = new WeakSet();
  function preserveSource(api) {
    if (!api || typeof api !== 'object' || hooked.has(api)) return;
    hooked.add(api);
    for (const [name, index] of [['render', 2], ['renderToString', 1]]) {
      const original = api[name];
      if (typeof original !== 'function') continue;
      try {
        api[name] = function (...args) {
          if (args[index]?.output === 'html')
            args[index] = { ...args[index], output: 'htmlAndMathml' };
          const output = original.apply(this, args);
          // KaTeX 0.11 的 MathML 输出遗漏 display 标记，利用渲染参数补全。
          if (args[index]?.output === 'mathml' && args[index].displayMode) {
            if (name === 'renderToString')
              return output.replace(/<math\b(?![^>]*\bdisplay\s*=)/, '<math display="block"');
            const math = args[1]?.querySelector('math');
            if (math && !math.hasAttribute('display')) math.setAttribute('display', 'block');
          }
          return output;
        };
      } catch { /* 冻结的 API 仍可通过 DOM 提取已有源码。 */ }
    }
  }
  preserveSource(window.katex);
  if (!Object.getOwnPropertyDescriptor(window, 'katex')) {
    let api;
    Object.defineProperty(window, 'katex', {
      configurable: true, enumerable: true,
      get: () => api,
      set: value => { api = value; preserveSource(value); }
    });
  }

  // 洛谷把 KaTeX 封装在模块内，单独包装其 rehype-katex 插件。
  if (/(^|\.)luogu\.com(\.cn)?$/.test(location.hostname)) {
    const chunks = window.webpackChunk_luogu_columba ||= [];
    const patched = new WeakSet();
    function patch(chunk) {
      for (const [id, factory] of Object.entries(chunk[1] || {})) {
        if (patched.has(factory) || !factory.toString().includes('rehype-katex')) continue;
        const wrapped = function (module, exports, require) {
          factory.call(this, module, exports, require);
          module.exports = new Proxy(module.exports, {
            get(target, key) {
              const value = Reflect.get(target, key);
              return typeof value === 'function'
                ? function (options) { return value.call(this, { ...options, output: 'htmlAndMathml' }); }
                : value;
            }
          });
        };
        patched.add(wrapped);
        chunk[1][id] = wrapped;
      }
    }
    const wrapPush = push => function (...items) {
      items.forEach(patch);
      return push.apply(this, items);
    };
    chunks.forEach(patch);
    let push = wrapPush(chunks.push);
    Object.defineProperty(chunks, 'push', {
      configurable: true,
      get: () => push,
      set: next => { push = wrapPush(next); }
    });
  }

  const roots = '.katex-display, .katex, mjx-container, .MathJax_Display, .MathJax_SVG_Display, .MathJax, .MathJax_SVG, .MathJax_CHTML, math';
  const annotation = 'annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"]';
  const blockTags = /^(P|DIV|LI|H[1-6]|PRE|BLOCKQUOTE|TR|SECTION|ARTICLE)$/;

  function collectMath() {
    const result = new Map();
    function add(node, tex, display) {
      if (!node?.isConnected || typeof tex !== 'string' || node.closest('pre, code, textarea')) return;
      tex = tex.trim();
      if (tex) result.set(node, { tex, display });
    }
    document.querySelectorAll(roots).forEach(node => {
      const outer = node.closest('.katex-display, mjx-container, .MathJax_Display, .MathJax_SVG_Display') || node;
      const tex = node.querySelector(annotation)?.textContent
        ?? node.getAttribute('data-latex') ?? node.getAttribute('data-tex')
        ?? (node.tagName.toLowerCase() === 'math' ? node.getAttribute('alttext') : null);
      add(outer, tex, outer.matches('.katex-display, .MathJax_Display, .MathJax_SVG_Display')
        || ['true', 'block'].includes(outer.getAttribute('display'))
        || !!node.querySelector('math[display="block"]'));
    });
    // MathJax 2：源码 script 通常位于选区之外，必须从原 DOM 读取。
    document.querySelectorAll('script[type^="math/tex"]').forEach(source => {
      const frame = document.getElementById(`${source.id}-Frame`);
      const previous = source.previousElementSibling;
      const node = frame || (previous?.matches(roots) ? previous : null);
      add(node?.closest('.MathJax_Display, .MathJax_SVG_Display') || node,
        source.textContent, /mode\s*=\s*display/i.test(source.type));
    });
    // MathJax 3/4：旧版没有 getMathItemsWithin，读取其可迭代公式列表。
    // CHTML / SVG 共用 MathItem；不把 MathML / AsciiMath 源码误当作 TeX。
    try {
      const doc = window.MathJax?.startup?.document;
      const items = doc?.math ?? doc?.getMathItemsWithin?.([document.body]) ?? [];
      for (const item of items) {
        if (item.inputJax?.name === 'TeX') add(item.typesetRoot, item.math, item.display);
      }
    } catch { /* 引擎可能仍在初始化，DOM 提取不受影响。 */ }
    return result;
  }

  window.addEventListener('copy', event => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    if (document.activeElement?.matches('input, textarea') || document.activeElement?.isContentEditable) return;
    const formulas = collectMath();
    if (!formulas.size) return;
    const enclosing = node => {
      let match;
      for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement)
        if (formulas.has(el)) match = el;
      return match;
    };
    let count = 0;
    const output = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i).cloneRange();
      const start = enclosing(range.startContainer), end = enclosing(range.endContainer);
      if (start) range.setStartBefore(start);
      if (end) range.setEndAfter(end);
      // 段落边界取最大值，不按嵌套层数相加；源码和 <br> 的显式换行原样保留。
      let text = '', pendingBreak = 0, lastLiteral = false;
      const boundary = lines => { pendingBreak = Math.max(pendingBreak, lines); };
      function append(value, literal = false) {
        if (!literal) {
          value = value.replace(/[\t\n\r\f ]+/g, ' ');
          if (!text || pendingBreak || text.endsWith(' ')) value = value.replace(/^ /, '');
        }
        if (!value) return;
        if (pendingBreak && text) {
          if (!lastLiteral) text = text.replace(/[\t ]+$/, '');
          const existing = text.match(/\n*$/)[0].length;
          text += '\n'.repeat(Math.max(0, pendingBreak - existing));
        }
        pendingBreak = 0;
        text += value;
        lastLiteral = literal;
      }
      function read(node, preserve = false) {
        if (!range.intersectsNode(node)) return;
        if (formulas.has(node)) {
          const math = formulas.get(node);
          if (math.display) boundary(2);
          append(math.display ? `$$\n${math.tex}\n$$` : `$${math.tex}$`, true);
          if (math.display) boundary(2);
          count++;
          return;
        }
        if (node.nodeType === 3) {
          const value = node.data.slice(
            node === range.startContainer ? range.startOffset : 0,
            node === range.endContainer ? range.endOffset : node.length);
          append(value, preserve || /^(pre|break-spaces)/.test(getComputedStyle(node.parentElement).whiteSpace));
          return;
        }
        if (node.nodeType === 1) {
          if (node.matches('script, style, .katex-mathml, .MathJax_Preview, .MJX_Assistive_MathML, mjx-assistive-mml, [hidden]')) return;
          if (node.tagName === 'BR') { append('\n', true); return; }
          preserve ||= node.tagName === 'PRE' || /^(pre|break-spaces)/.test(getComputedStyle(node).whiteSpace);
        }
        const lines = /^(P|H[1-6]|BLOCKQUOTE)$/.test(node.tagName) ? 2 : blockTags.test(node.tagName) ? 1 : 0;
        if (lines) boundary(lines);
        for (const child of node.childNodes) read(child, preserve);
        if (lines) boundary(lines);
      }
      read(range.commonAncestorContainer);
      output.push(lastLiteral ? text : text.replace(/[\t ]+$/, ''));
    }
    if (!count) return;
    event.clipboardData.setData('text/plain', output.join('\n'));
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();




