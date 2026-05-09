/* global jest */

const createClassList = (initialClasses = []) => {
  const classes = new Set(initialClasses);

  return {
    add: jest.fn((...names) => {
      names.forEach((name) => classes.add(name));
    }),
    remove: jest.fn((...names) => {
      names.forEach((name) => classes.delete(name));
    }),
    toggle: jest.fn((name, force) => {
      if (force === undefined) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }

        classes.add(name);
        return true;
      }

      if (force) {
        classes.add(name);
      } else {
        classes.delete(name);
      }

      return force;
    }),
    contains: jest.fn((name) => classes.has(name)),
    toArray: () => Array.from(classes),
  };
};

const getDataAttributeName = (selector) => {
  const match = selector.match(/^\[data-([a-z-]+)="([^"]+)"\]$/);
  if (!match) return null;

  return {
    key: match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase()),
    value: match[2],
  };
};

const matchesSingleSelector = (element, selector) => {
  const classAndDataMatch = selector.match(/^\.([A-Za-z0-9_-]+)(\[data-([a-z-]+)="([^"]+)"\])$/);
  if (classAndDataMatch) {
    const [, className, , dataName, dataValue] = classAndDataMatch;
    const dataKey = dataName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return element.classList.contains(className) && element.dataset[dataKey] === dataValue;
  }

  if (selector.startsWith('.') && !/[[\s:>+~]/.test(selector)) {
    // Supports `.foo.bar.baz` — every dot-prefixed segment must be present.
    // Combinators (`.foo > .bar`, `.foo .bar`) are intentionally rejected so
    // the fake fails loudly instead of silently no-matching.
    const classes = selector.split('.').filter(Boolean);
    return classes.every((cls) => element.classList.contains(cls));
  }

  if (selector === 'webview') {
    return element.tagName === 'WEBVIEW';
  }

  if (selector === 'webview:not(.hidden)') {
    return element.tagName === 'WEBVIEW' && !element.classList.contains('hidden');
  }

  const dataAttr = getDataAttributeName(selector);
  if (dataAttr) {
    return element.dataset[dataAttr.key] === dataAttr.value;
  }

  return false;
};

const matchesSelector = (element, selector) => {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
};

class FakeElement {
  constructor(tagName = 'div', options = {}) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = { ...(options.dataset || {}) };
    this.style = { ...(options.style || {}) };
    this.handlers = {};
    this.attributes = {};
    this.disabled = options.disabled || false;
    this.draggable = false;
    this._innerHTML = options.innerHTML || '';
    this.textContent = options.textContent || '';
    this.value = options.value || '';
    this.src = options.src || '';
    this.alt = options.alt || '';
    this.onclick = null;
    this.onerror = null;
    this._classes = createClassList(options.classes || []);
    this.classList = this._classes;
    this._className = this.classList.toArray().join(' ');
    this._rect = options.rect || {
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
    };

    Object.defineProperty(this, 'className', {
      get: () => this._className,
      set: (value) => {
        this._className = value;
        this._classes = createClassList(
          String(value)
            .split(/\s+/)
            .map((part) => part.trim())
            .filter(Boolean)
        );
        this.classList = this._classes;
      },
    });

    Object.defineProperty(this, 'innerHTML', {
      get: () => this._innerHTML,
      set: (value) => {
        this._innerHTML = String(value);
        if (value === '') {
          this.children.forEach((child) => {
            child.parentNode = null;
          });
          this.children = [];
        }
      },
    });

    Object.defineProperty(this, 'offsetWidth', {
      get: () => this._rect.width,
      set: (value) => {
        this._rect.width = value;
      },
    });
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }

  setRect(rect) {
    this._rect = { ...this._rect, ...rect };
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    this[name] = value;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    delete this[name];
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(event, handler) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(handler);
  }

  removeEventListener(event, handler) {
    const listeners = this.handlers[event];
    if (!listeners) return;
    this.handlers[event] = listeners.filter((listener) => listener !== handler);
  }

  dispatch(event, payload = {}) {
    const listeners = this.handlers[event] || [];
    listeners.forEach((listener) => listener(payload));
  }

  dispatchEvent(event) {
    if (!event || typeof event.type !== 'string') return false;
    const listeners = this.handlers[event.type] || [];
    listeners.forEach((listener) => listener(event));
    return true;
  }

  appendChild(child) {
    if (child.parentNode) {
      child.remove();
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) {
      this.appendChild(child);
    }
  }

  insertBefore(child, referenceNode) {
    if (referenceNode === null || referenceNode === undefined) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.remove();
    }
    const index = this.children.indexOf(referenceNode);
    if (index < 0) {
      throw new Error('insertBefore: reference node is not a child');
    }
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  prepend(child) {
    if (child.parentNode) {
      child.remove();
    }
    child.parentNode = this;
    this.children.unshift(child);
    return child;
  }

  after(sibling) {
    if (!this.parentNode) return;
    if (sibling.parentNode) {
      sibling.remove();
    }

    const index = this.parentNode.children.indexOf(this);
    sibling.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, sibling);
  }

  remove() {
    if (!this.parentNode) return;

    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) {
      this.parentNode.children.splice(index, 1);
    }
    this.parentNode = null;
  }

  replaceWith(newNode) {
    if (!this.parentNode) return;
    if (newNode.parentNode) {
      newNode.remove();
    }
    const index = this.parentNode.children.indexOf(this);
    if (index < 0) return;
    newNode.parentNode = this.parentNode;
    this.parentNode.children.splice(index, 1, newNode);
    this.parentNode = null;
  }

  replaceChildren(...newChildren) {
    this.children.forEach((child) => {
      child.parentNode = null;
    });
    this.children = [];
    newChildren.forEach((child) => this.appendChild(child));
  }

  contains(target) {
    if (this === target) return true;
    return this.children.some((child) => child.contains(target));
  }

  closest(selector) {
    let current = this;

    while (current) {
      if (matchesSelector(current, selector)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        return child;
      }

      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  querySelectorAll(selector) {
    const results = [];

    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }

    return results;
  }

  focus() {}

  blur() {}

  select() {}
}

const createElement = (tagName = 'div', options = {}) => new FakeElement(tagName, options);

const createDocument = ({ elementsById = {}, createElementOverride, body } = {}) => {
  const documentHandlers = {};
  const documentBody = body || createElement('body');

  Object.values(elementsById).forEach((element) => {
    if (element && !element.parentNode) {
      documentBody.appendChild(element);
    }
  });

  return {
    handlers: documentHandlers,
    body: documentBody,
    createElement: jest.fn((tagName) => {
      if (createElementOverride) {
        return createElementOverride(tagName);
      }
      return createElement(tagName);
    }),
    getElementById: jest.fn((id) => elementsById[id] || null),
    querySelector: jest.fn((selector) => documentBody.querySelector(selector)),
    querySelectorAll: jest.fn((selector) => documentBody.querySelectorAll(selector)),
    addEventListener: jest.fn((event, handler) => {
      documentHandlers[event] = handler;
    }),
  };
};

module.exports = {
  FakeElement,
  createClassList,
  createDocument,
  createElement,
};
