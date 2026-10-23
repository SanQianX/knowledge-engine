'use strict';

// Minimal DOM/vm world that loads the REAL ui/app.js and executes its real
// logic (handlers, api(), showRunDetail(), loadRuns()) under node:test —
// no browser, no source-text mirroring. Only the subset of DOM the engine
// console actually uses is emulated:
//   * element tree with id/class/tag/[attr] selectors (descendant chains)
//   * innerHTML parsing strong enough for the templates app.js renders
//   * click listeners (click() honors `disabled` like a real button)
//   * controlled fetch router with per-call logging and holdable responses
//
// The emulations that matter for correctness are asserted, not assumed:
// querySelectorAll only ever returns parsed/seeded tree elements, so a test
// that needs `#retryRun` proves it was really rendered by showRunDetail().

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'col', 'wbr']);

class ShimElement {
  constructor(tagName, attributes = {}) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.textNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.disabled = Object.prototype.hasOwnProperty.call(attributes, 'disabled');
    this.value = 'value' in attributes ? attributes.value : '';
    this.style = {};
    this._classList = null;
  }
  get id() { return this.attributes.id || ''; }
  get className() { return this.attributes.class || ''; }
  get dataset() {
    const dataset = {};
    for (const [name, value] of Object.entries(this.attributes)) {
      if (name.startsWith('data-')) dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
    return dataset;
  }
  get classList() {
    if (!this._classList) {
      const read = () => new Set((this.attributes.class || '').split(/\s+/).filter(Boolean));
      const write = set => { this.attributes.class = [...set].join(' '); };
      this._classList = {
        add: (...names) => { const set = read(); names.forEach(name => set.add(name)); write(set); },
        remove: (...names) => { const set = read(); names.forEach(name => set.delete(name)); write(set); },
        contains: name => read().has(name),
        toggle: (name, force) => { const set = read(); const next = force === undefined ? !set.has(name) : force; next ? set.add(name) : set.delete(name); write(set); return next; },
      };
    }
    return this._classList;
  }
  get textContent() { return this.textNodes.join('') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.textNodes = [String(value)]; this.children = []; }
  set innerHTML(html) {
    const parsed = parseFragment(String(html));
    this.textNodes = parsed.filter(node => node.nodeType === 3).map(node => node.textContent);
    this.children = parsed.filter(node => node.nodeType === 1);
    this.children.forEach(child => { child.parentNode = this; });
  }
  get innerHTML() { return this.children.map(child => child.outerHTML).join(''); }
  get outerHTML() {
    const attrs = Object.entries(this.attributes).map(([name, value]) => value === '' ? name : `${name}="${value}"`).join(' ');
    return `<${this.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>${this.innerHTML}${this.textContent}</${this.tagName.toLowerCase()}>`;
  }
  get options() { return this.children.filter(child => child.tagName === 'OPTION' && child.nodeType === 1); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  // Raw dispatch: invokes listeners even when disabled — used to pin the
  // per-runId in-flight guard independently of the browser-level disabled
  // button behavior (which click() emulates below).
  dispatch(type, event = {}) {
    const listeners = [...(this.listeners.get(type) || [])];
    for (const listener of listeners) listener({ type, currentTarget: this, target: this, ...event });
  }
  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }
}

function parseAttributes(text) {
  const attributes = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(text))) attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  return attributes;
}

function parseFragment(html) {
  const roots = [];
  const stack = [];
  const attach = node => {
    if (stack.length) {
      const parent = stack[stack.length - 1];
      if (node.nodeType === 3) parent.textNodes.push(node.textContent);
      else { parent.children.push(node); node.parentNode = parent; }
    } else roots.push(node);
  };
  const re = /<(\/)?([a-zA-Z][^\s/>]*)([^>]*?)(\/)?>|([^<]+)/g;
  let match;
  while ((match = re.exec(html))) {
    if (match[5] !== undefined) {
      if (match[5].trim()) attach({ nodeType: 3, textContent: match[5] });
      continue;
    }
    const [, closing, rawTag, attributeText, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index--) {
        if (stack[index].tagName === tag.toUpperCase()) { stack.length = index; break; }
      }
      continue;
    }
    const element = new ShimElement(tag, parseAttributes(attributeText || ''));
    attach(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return roots;
}

function tokenMatches(element, token) {
  if (token.startsWith('#')) return element.attributes.id === token.slice(1);
  if (token.startsWith('.')) return (element.attributes.class || '').split(/\s+/).includes(token.slice(1));
  const attribute = token.match(/^\[([^\]=]+)(?:=(['"]?)(.*?)\2)?\]$/);
  if (attribute) {
    if (element.attributes[attribute[1]] === undefined) return false;
    return attribute[3] === undefined ? true : element.attributes[attribute[1]] === attribute[3];
  }
  return element.tagName === token.toUpperCase();
}

function queryAll(root, selector) {
  const chain = selector.trim().split(/\s+/);
  const elements = [];
  const walk = node => {
    for (const child of node.children) { elements.push(child); walk(child); }
  };
  walk(root);
  return elements.filter(element => {
    if (!tokenMatches(element, chain[chain.length - 1])) return false;
    let node = element.parentNode;
    let index = chain.length - 2;
    while (index >= 0 && node) {
      if (node.nodeType === 1 && tokenMatches(node, chain[index])) index--;
      node = node.parentNode;
    }
    return index < 0;
  });
}

const NAV_VIEWS = ['overview', 'runs', 'knowledge', 'retrieval', 'projects', 'events'];

function createUiWorld({ appSource } = {}) {
  const defaultFile = path.join(__dirname, '..', '..', 'ui', 'app.js');
  const source = !appSource || fs.existsSync(appSource)
    ? fs.readFileSync(appSource || defaultFile, 'utf8')
    : appSource;
  const body = new ShimElement('body');
  const seed = (tag, attributes) => { const element = new ShimElement(tag, attributes); element.parentNode = body; body.children.push(element); return element; };
  const navByView = {};
  for (const view of NAV_VIEWS) navByView[view] = seed('button', { class: 'nav-item', 'data-view': view });
  const seeds = {
    scopeProject: seed('select', { id: 'scopeProject' }),
    runsBody: seed('tbody', { id: 'runsBody' }),
    runProjectFilter: seed('select', { id: 'runProjectFilter' }),
    runStateFilter: seed('select', { id: 'runStateFilter' }),
    triggerProject: seed('select', { id: 'triggerProject' }),
    retrievalProject: seed('select', { id: 'retrievalProject' }),
    runDetail: seed('div', { id: 'runDetail', class: 'hidden' }),
    runDetailId: seed('div', { id: 'runDetailId' }),
    runTimeline: seed('ol', { id: 'runTimeline' }),
    runMeta: seed('dl', { id: 'runMeta' }),
    runStaging: seed('pre', { id: 'runStaging' }),
    toast: seed('div', { id: 'toast' }),
    viewKicker: seed('div', { id: 'viewKicker' }),
    viewTitle: seed('div', { id: 'viewTitle' }),
  };

  const fallbacks = new Map();
  const documentShim = {
    body,
    referrer: '',
    querySelector(selector) {
      const match = queryAll(body, selector)[0];
      if (match) return match;
      if (!fallbacks.has(selector)) fallbacks.set(selector, new ShimElement('div', { id: selector.startsWith('#') ? selector.slice(1) : '' }));
      return fallbacks.get(selector);
    },
    querySelectorAll(selector) { return queryAll(body, selector); },
  };

  const calls = [];
  const rules = [];
  const timers = new Set();
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    FormData: class FormData {},
    location: { search: '', origin: 'http://engine-ui.test' },
    document: documentShim,
    fetch(url, init = {}) {
      return new Promise((resolve, reject) => {
        const call = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body, seq: calls.length };
        call.respond = decision => resolve({
          ok: decision.status >= 200 && decision.status < 300,
          status: decision.status,
          json: async () => { if (decision.badJson) throw new Error('invalid json'); return decision.body; },
        });
        call.rejectWith = reject;
        calls.push(call);
        const rule = rules.find(entry => entry.method === call.method && entry.pattern.test(call.url));
        const decision = rule ? rule.handler(call) : { status: 200, body: { ok: true } };
        if (decision && typeof decision.then === 'function') decision.then(call.respond, call.rejectWith);
        else call.respond(decision);
      });
    },
    setTimeout(fn, ms, ...args) {
      const handle = { kind: 'timeout', native: setTimeout(() => { timers.delete(handle); fn(...args); }, ms) };
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle) { if (handle) { clearTimeout(handle.native); timers.delete(handle); } },
    setInterval(fn, ms, ...args) {
      // Intervals must never fire mid-test (the 5s overview refresh would make
      // assertions non-deterministic); they are recorded and disposed only.
      const handle = { kind: 'interval', fn, ms, args };
      timers.add(handle);
      return handle;
    },
    clearInterval(handle) { if (handle) timers.delete(handle); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'ui/app.js' });
  // The realm whose `instanceof TypeError` api()'s unknown-result branch uses.
  const realmTypeError = vm.runInContext('TypeError', sandbox);

  return {
    sandbox,
    document: documentShim,
    seeds,
    calls,
    TypeError: realmTypeError,
    route(method, pattern, handler) { rules.unshift({ method, pattern, handler }); },
    clickNav(view) { navByView[view].click(); },
    toastState() { return { text: seeds.toast.textContent, shown: seeds.toast.classList.contains('show') }; },
    dispose() { for (const handle of timers) { if (handle.kind === 'timeout') clearTimeout(handle.native); } timers.clear(); },
  };
}

const flush = (rounds = 12) => {
  let chain = Promise.resolve();
  for (let index = 0; index < rounds; index += 1) chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  return chain;
};

module.exports = { createUiWorld, flush };
