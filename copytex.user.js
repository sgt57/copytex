// ==UserScript==
// @name         CopyTeX
// @namespace    copytex
// @version      0.5.2
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
// @downloadURL  https://raw.githubusercontent.com/sgt57/copytex/main/copytex.user.js
// @updateURL    https://raw.githubusercontent.com/sgt57/copytex/main/copytex.user.js
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

  // 单独转换的公式不进入 MathJax 的公式列表，在调用时记录源码。
  const hookedMathJax = new WeakSet();
  function intercept(object, key, wrap) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return;
    let value = wrap(object[key]);
    try {
      Object.defineProperty(object, key, {
        configurable: true, enumerable: descriptor?.enumerable ?? true,
        get: () => value,
        set: next => { value = wrap(next); }
      });
    } catch { /* 无法包装时仍可读取已有 DOM 和公式列表。 */ }
  }
  function preserveConversions(api) {
    if (!api || typeof api !== 'object' || hookedMathJax.has(api)) return api;
    hookedMathJax.add(api);
    for (const name of ['tex2chtml', 'tex2chtmlPromise']) {
      intercept(api, name, original => {
        if (typeof original !== 'function') return original;
        return function (...args) {
          const remember = node => {
            if (node?.nodeType === 1 && typeof args[0] === 'string') {
              // 写入节点属性，让 cloneNode / outerHTML 重建后仍能读取。
              node.setAttribute('data-tex', args[0]);
            }
            return node;
          };
          const output = original.apply(this, args);
          return name.endsWith('Promise') ? output.then(remember) : remember(output);
        };
      });
    }
    return api;
  }
  preserveConversions(window.MathJax);
  intercept(window, 'MathJax', preserveConversions);

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

  // 输出前统一公式分隔符；已提取的公式和代码按原文保留。
  function formatMath(text, literals = []) {
    let output = '', position = 0, literalIndex = 0, pendingBreak = false, lastLiteral = false;
    function append(value, literal = false) {
      if (pendingBreak && !literal) value = value.replace(/^[\t ]+/, '');
      if (!value) return;
      if (pendingBreak && output) {
        if (!lastLiteral) output = output.replace(/[\t ]+$/, '');
        const before = output.match(/(?:\r?\n)*$/)[0].split('\n').length - 1;
        const after = value.match(/^(?:\r?\n)*/)[0].split('\n').length - 1;
        output += '\n'.repeat(Math.max(0, 2 - before - after));
      }
      pendingBreak = false;
      output += value;
      lastLiteral = literal;
    }
    function closing(from, delimiter) {
      for (let index = text.indexOf(delimiter, from); index !== -1;
        index = text.indexOf(delimiter, index + delimiter.length)) {
        let slashes = 0;
        for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
        if (slashes % 2 === 0) return index;
      }
      return -1;
    }
    const markers = /\\[\s\S]|\${1,2}|`+|^ {0,3}~{3,}/gm;
    while (position < text.length) {
      markers.lastIndex = position;
      const match = markers.exec(text), literal = literals[literalIndex];
      if (literal && (!match || literal[0] <= match.index)) {
        append(text.slice(position, literal[0]));
        append(text.slice(literal[0], literal[1]), true);
        position = literal[1];
        literalIndex++;
        continue;
      }
      if (!match) break;
      const token = match[0], start = match.index;
      let end = markers.lastIndex, value = token, preserve = false, display = false;
      if (token[0] === '`' || token.trim()[0] === '~') {
        const fence = token.trim();
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        if (fence.length >= 3 && /^[ \t]{0,3}$/.test(text.slice(lineStart, start))) {
          const newline = text.indexOf('\n', end);
          const close = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[\\t ]*\\r?$', 'gm');
          close.lastIndex = newline === -1 ? text.length : newline + 1;
          const found = newline === -1 ? null : close.exec(text);
          end = found ? close.lastIndex : text.length;
          preserve = true;
        } else {
          const close = /`+/g;
          close.lastIndex = end;
          let found;
          while ((found = close.exec(text))) {
            if (found[0].length !== token.length) continue;
            end = close.lastIndex;
            preserve = true;
            break;
          }
        }
        value = text.slice(start, end);
      } else if (['\\(', '\\[', '$$', '$'].includes(token)) {
        const delimiter = token === '\\(' ? '\\)' : token === '\\[' ? '\\]' : token;
        const close = closing(end, delimiter);
        if (close !== -1 && (!literal || close + delimiter.length <= literal[0])) {
          const source = text.slice(end, close);
          if (source.trim() && (token !== '$' || !/[\r\n]/.test(source))) {
            end = close + delimiter.length;
            display = token === '\\[' || token === '$$';
            value = display ? '$$\n' + source.trim() + '\n$$'
              : token === '\\(' ? '$' + source.trim() + '$' : text.slice(start, end);
            preserve = true;
          }
        }
      }
      // Markdown 代码跨度也不能越过 DOM 中受保护的源码。
      if (literal && end > literal[0]) {
        end = markers.lastIndex;
        value = token;
        preserve = display = false;
      }
      append(text.slice(position, start));
      if (display) pendingBreak = true;
      append(value, preserve);
      if (display) pendingBreak = true;
      position = end;
    }
    append(text.slice(position));
    return output;
  }

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

  let contextFormula = null, contextMenu, sourceDialog;
  function ensureFormulaTools(){if(contextMenu)return; const style=document.createElement('style'); style.textContent='.copytex-context-menu{position:fixed;z-index:2147483647;min-width:150px;padding:4px;background:Canvas;color:CanvasText;box-shadow:0 3px 12px #0003;font:13px system-ui}.copytex-context-menu button{display:block;width:100%;padding:7px 10px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.copytex-context-menu button:hover{background:#e8f0fe}.copytex-source-backdrop{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:20px;background:#0006}.copytex-source-dialog{width:min(720px,100%);max-height:80vh;display:flex;flex-direction:column;overflow:hidden;border-radius:8px;background:Canvas;color:CanvasText}.copytex-source-head{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #ddd}.copytex-source-code{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;user-select:text;font:13px/1.5 monospace}';(document.head||document.documentElement).append(style);contextMenu=document.createElement('div');contextMenu.className='copytex-context-menu';contextMenu.hidden=true;const view=document.createElement('button');view.textContent='查看 TeX 源码';view.onclick=()=>{if(contextFormula)openSource(contextFormula.tex);hideMenu()};contextMenu.append(view);document.documentElement.append(contextMenu);document.addEventListener('click',hideMenu);document.addEventListener('keydown',e=>{if(e.key==='Escape'){hideMenu();closeSource()}})}
  function hideMenu(){if(contextMenu)contextMenu.hidden=true;contextFormula=null} function openSource(tex){closeSource();const b=document.createElement('div');b.className='copytex-source-backdrop';const d=document.createElement('section');d.className='copytex-source-dialog';const h=document.createElement('header');h.className='copytex-source-head';h.append('TeX 源码');const x=document.createElement('button');x.textContent='×';x.onclick=closeSource;h.append(x);const p=document.createElement('pre');p.className='copytex-source-code';p.textContent=tex;d.append(h,p);b.append(d);b.onclick=e=>{if(e.target===b)closeSource()};document.documentElement.append(b);sourceDialog=b} function closeSource(){if(sourceDialog){sourceDialog.remove();sourceDialog=null}}
  function showFormulaMenu(event) {
    if (event.defaultPrevented) return;
    const formulas = collectMath();
    let node = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    let formula;
    while (node && !formula) { formula = formulas.get(node); node = node.parentElement; }
    if (!formula) return;
    ensureFormulaTools();
    contextFormula = formula;
    contextMenu.hidden = false;
    contextMenu.style.left = Math.min(event.clientX, innerWidth - contextMenu.offsetWidth - 4) + 'px';
    contextMenu.style.top = Math.min(event.clientY, innerHeight - contextMenu.offsetHeight - 4) + 'px';
    event.preventDefault();
  }
  window.addEventListener('contextmenu', event => {
    hideMenu();
    const fallback = currentEvent => {
      if (currentEvent !== event) return;
      window.removeEventListener('contextmenu', fallback);
      showFormulaMenu(event);
    };
    window.addEventListener('contextmenu', fallback);
    setTimeout(() => window.removeEventListener('contextmenu', fallback), 0);
  }, true);
  function readSelection() {
    const active = document.activeElement;
    if (active?.matches('input, textarea')) {
      const start = active.selectionStart, end = active.selectionEnd;
      if (active.type === 'password' || start == null || start === end) return null;
      const original = active.value.slice(start, end);
      const text = formatMath(original);
      return { original, text, changed: text !== original, formulas: 0 };
    }
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    // 按实际显示状态排除隐藏源码副本，不按字符串相同与否删除正文。
    const styles = new WeakMap(), hidden = new WeakMap();
    const styleOf = element => {
      if (!styles.has(element)) styles.set(element, getComputedStyle(element));
      return styles.get(element);
    };
    function hiddenFromCopy(element) {
      if (!element) return false;
      if (hidden.has(element)) return hidden.get(element);
      const style = styleOf(element);
      const clip = style.clip.match(/^rect\(([^)]+)\)$/)?.[1]
        .split(/[,\s]+/).map(value => parseFloat(value));
      const clipped = clip?.length === 4 && clip.every(Number.isFinite)
        && (clip[2] <= clip[0] || clip[1] <= clip[3]);
      const tinyHiddenBox = /^(absolute|fixed)$/.test(style.position)
        && style.overflowX === 'hidden' && style.overflowY === 'hidden'
        && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1;
      const value = style.display === 'none' || style.contentVisibility === 'hidden'
        || style.opacity === '0' || clipped || tinyHiddenBox
        || /^inset\(50%\)$/.test(style.clipPath)
        || hiddenFromCopy(element.parentElement);
      hidden.set(element, value);
      return value;
    }
    const formulas = collectMath();
    const enclosing = node => {
      let match;
      for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement)
        if (formulas.has(el)) match = el;
      return match;
    };
    let count = 0;
    let formatted = false;
    const output = [], originals = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i).cloneRange();
      const start = enclosing(range.startContainer), end = enclosing(range.endContainer);
      if (start) range.setStartBefore(start);
      if (end) range.setEndAfter(end);
      // 段落边界取最大值，不按嵌套层数相加；源码和 <br> 的显式换行原样保留。
      let text = '', pendingBreak = 0, lastLiteral = false;
      const literals = [];
      const boundary = lines => { pendingBreak = Math.max(pendingBreak, lines); };
      function append(value, literal = false, protect = false) {
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
        if (protect) literals.push([text.length, text.length + value.length]);
        text += value;
        lastLiteral = literal;
      }
      function read(node, preserve = false) {
        if (!range.intersectsNode(node)) return;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (hiddenFromCopy(element)) return;
        if (formulas.has(node) && styleOf(node).visibility === 'visible') {
          const math = formulas.get(node);
          if (math.display) boundary(2);
          append(math.display ? `$$\n${math.tex}\n$$` : `$${math.tex}$`, true, true);
          if (math.display) boundary(2);
          count++;
          return;
        }
        if (node.nodeType === 3) {
          if (styleOf(node.parentElement).visibility !== 'visible') return;
          const value = node.data.slice(
            node === range.startContainer ? range.startOffset : 0,
            node === range.endContainer ? range.endOffset : node.length);
          append(value, preserve || /^(pre|break-spaces)/.test(styleOf(node.parentElement).whiteSpace),
            !!node.parentElement.closest('pre, code, textarea'));
          return;
        }
        if (node.nodeType === 1) {
          if (node.matches('script, style, noscript, template, annotation, annotation-xml, .katex-mathml, .MathJax_Preview, .MJX_Assistive_MathML, mjx-assistive-mml, [hidden]')) return;
          if (node.tagName === 'BR') { append('\n', true); return; }
          preserve ||= node.tagName === 'PRE' || /^(pre|break-spaces)/.test(styleOf(node).whiteSpace);
        }
        const lines = /^(P|H[1-6]|BLOCKQUOTE)$/.test(node.tagName) ? 2 : blockTags.test(node.tagName) ? 1 : 0;
        if (lines) boundary(lines);
        for (const child of node.childNodes) read(child, preserve);
        if (lines) boundary(lines);
      }
      read(range.commonAncestorContainer);
      const original = lastLiteral ? text : text.replace(/[\t ]+$/, '');
      const normalized = formatMath(original, literals);
      formatted ||= normalized !== original;
      originals.push(original);
      output.push(normalized);
    }
    return { original: originals.join('\n'), text: output.join('\n'), changed: formatted, formulas: count };
  }

  // 每次 copy 事件都接入格式化，不以选区或公式识别结果作为监听条件。
  window.addEventListener('copy', event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const setData = clipboard.setData;
    const descriptor = Object.getOwnPropertyDescriptor(clipboard, 'setData');
    let selection, formattedText;
    const normalize = text => text === formattedText ? text
      : text === selection?.original ? selection.text : formatMath(text);
    function write(text) {
      setData.call(clipboard, 'text/plain', text);
      formattedText = text;
      event.preventDefault();
    }
    // 只包装本次事件的数据对象，网页停止冒泡后写入的文本也能经过格式化。
    const wrapped = function (type, text) {
      if (this !== clipboard || typeof type !== 'string' || typeof text !== 'string'
        || !/^(text|text\/plain)$/i.test(type)) return setData.apply(this, arguments);
      const normalized = normalize(text);
      const result = setData.call(this, type, normalized);
      formattedText = normalized;
      if (normalized !== text) event.preventDefault();
      return result;
    };
    try {
      Object.defineProperty(clipboard, 'setData', {
        configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
        value: wrapped
      });
    } catch { /* 数据对象无法包装时，仍在冒泡结束前处理其文本。 */ }
    const finish = currentEvent => {
      if (currentEvent !== event) return;
      window.removeEventListener('copy', finish);
      if (Array.from(clipboard.types).includes('text/plain')) {
        const original = clipboard.getData('text/plain');
        const normalized = normalize(original);
        if (normalized !== original) write(normalized);
      } else if (!event.defaultPrevented && !clipboard.types.length && selection?.changed) {
        // 网页未提供文本时，使用已经格式化的选区文本。
        write(selection.text);
      }
    };
    window.addEventListener('copy', finish);
    setTimeout(() => {
      window.removeEventListener('copy', finish);
      if (clipboard.setData !== wrapped) return;
      try {
        if (descriptor) Object.defineProperty(clipboard, 'setData', descriptor);
        else delete clipboard.setData;
      } catch { /* 网页可能在事件结束前冻结数据对象。 */ }
    }, 0);
    selection = readSelection();
    if (selection?.formulas) {
      // 脚本生成的文本已经格式化，直接写入以保留其中的代码原文。
      write(selection.text);
      event.stopImmediatePropagation();
    }
  }, true);

})();
