import type {ElementHandle, JSHandle, Page} from 'puppeteer-core';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

interface SnapshotPoint {
  x: number;
  y: number;
}

interface SnapshotRect extends SnapshotPoint {
  width: number;
  height: number;
}

interface SnapshotElement {
  elementUuid: string;
  element: HTMLElement;
  tag: string;
  rect: SnapshotRect;
  text: string;
  debugInfo?: string;
  interactiveTypes: string[];
}

export interface SnapshotElementResult {
  elementUuid: string;
  element: HTMLElement | ElementHandle<Element>;
  tag: string;
  uid: string;
  text: string;
  interactiveTypes: string[];
}

function clearLabels(root: HTMLElement) {
  const labels = root.querySelectorAll('.__element-snapshot__');
  labels.forEach((label) => label.remove());
}

function snapshotElement(root: HTMLElement, snapshotId: string) {
  const INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];


  function getUUIDOfElement(element: Element) {
    // @ts-expect-error __chrome_devtools_mcp_snapshot__ is not typed
    return window.__chrome_devtools_mcp_snapshot__.snapshotElementMap.get(element);
  }

  function setUUIDOfElement(element: Element, uuid: string) {
    // @ts-expect-error __chrome_devtools_mcp_snapshot__ is not typed
    window.__chrome_devtools_mcp_snapshot__.snapshotElementMap.set(element, uuid);
  }
  
  function setup() {
    // @ts-expect-error __chrome_devtools_mcp_snapshot__ is not typed
    if(!window.__chrome_devtools_mcp_snapshot__) {
      // @ts-expect-error __chrome_devtools_mcp_snapshot__ is not typed
      window.__chrome_devtools_mcp_snapshot__ = {
        snapshotElementMap: new WeakMap<Element, string>(),
      };
    }
  }

  function shortUUID(length = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array); // 浏览器 / Node.js 都支持
    return Array.from(array).map((n) => chars[n % chars.length]).join('');
  }

  
  function isVisibleOnScreen(el: Element) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(x, y);
    return el.contains(topElement) || el === topElement;
  }
  
  function getVisibleElementsWithInteraction(root = document.body) {
    const elements: SnapshotElement[] = [];
  
    function traverse(node: HTMLElement) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }
  
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
  
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0';
  
      // 如果是input类型默认是可见的，不要被剔除
      // if (INPUT_TAGS.includes(node.tagName)) {
      //   visible = true;
      // }
  
      if (visible) {
        // 计算交互类型
        let interactiveTypes = [];
        if (['path'].includes(node.tagName)) {
          return;
        }
        if (['A', 'BUTTON'].includes(node.tagName) || node.getAttribute('role') === 'button') {
          interactiveTypes.push('click');
        }
        if (style.cursor === 'pointer') {
          // && Object.keys(getHoverDeclarationsForElement(node).declarations).length) {
          interactiveTypes.push('click');
        }
        if (INPUT_TAGS.includes(node.tagName)) {
          interactiveTypes.push('input');
        }
        // 文本 fallback
        let text =
          node.innerText?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('alt') ||
          node.getAttribute('title') ||
          node.getAttribute('placeholder') ||
          '';
        text = text.slice(0, 100);
        interactiveTypes = [...new Set(interactiveTypes)];
        if (interactiveTypes.length) {
          if (!getUUIDOfElement(node)) {
            setUUIDOfElement(node, shortUUID());
          }
          elements.push({
            elementUuid: getUUIDOfElement(node),
            element: node,
            tag: node.tagName.toLowerCase(),
            rect: {
              x: rect.x + window.scrollX,
              y: rect.y + window.scrollY,
              width: rect.width,
              height: rect.height,
            },
            text,
            interactiveTypes, // 直接存交互类型
          });
        }
      }
  
      // 遍历子元素
      Array.from(node.children).forEach((child) => traverse(child as HTMLElement));
  
      // 遍历 Shadow DOM（开放模式）
      if (node.shadowRoot) {
        Array.from(node.shadowRoot.children).forEach((child) => traverse(child as HTMLElement));
      }
    }
  
    traverse(root);
    // 这里为了处理类似父元素包含子元素的情况，有很多子元素其实是无效的，只有子元素有独立的交互才有效
    // 这里也有不准确的情况，类似tab, tab本身是可以点击选中，里面也还有关闭按钮，也能处理点击关闭
    const filterContainsElements = (elements: SnapshotElement[]) => {
      return elements.filter((e1) => {
        return !elements.some((e2) => {
          if (e1 === e2) return false;
          // e2 包含 e1
          if (!e2.element.contains(e1.element)) {
            return false;
          }
          // 如果 e2 和 e1 的 rect 完全一致，则认为 e2 完全可以代替包含 e1
          if (
            e2.rect.x === e1.rect.x &&
            e2.rect.y === e1.rect.y &&
            e2.rect.width === e1.rect.width &&
            e2.rect.height === e1.rect.height
          ) {
            return true;
          }
          e1.debugInfo = 'e2 contains e1';
          const e1HoverStyles = getHoverComputedStyles(e1.element);
          if (Object.keys(e1HoverStyles ?? {}).length) {
            e1.debugInfo += '| e1 has hover styles will be retained';
            return false;
          }
          // 交互类型一致才去掉
          const parentTypes = new Set(e2.interactiveTypes);
          return e1.interactiveTypes.every((t) => parentTypes.has(t));
        });
      });
    };
    console.log('before filteredElements', elements);
    const filteredElements = filterContainsElements(elements);
    console.log('after filteredElements', filteredElements);
    return filteredElements.filter((e) => {
      // input类型很多时候都是隐藏的
      if (e.interactiveTypes.includes('input')) {
        return true;
      }
      // 存在有一些按钮，pointerEvents: none，hover时样式则不是none
      if (window.getComputedStyle(e.element).pointerEvents === 'none') {
        return true;
      }
      return isVisibleOnScreen(e.element);
    });
  }
  
  function findOverlayAncestor(el: Element) {
    let current = el;
    let outerOverlay = null;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const zIndex = parseInt(style.zIndex, 10);
  
      if (
        !isNaN(zIndex) &&
        zIndex > 0 // 阈值可调，比如100
      ) {
        outerOverlay = { overlay: current, zIndex };
      }
      // @ts-expect-error current.getRootNode is not typed
      current = current.parentElement || current.getRootNode().host || null;
    }
    return outerOverlay;
  }
  
  function clusterAndSort(elements: SnapshotElement[]) {
    const tolerance = 10;
    // 按 y 坐标排序
    elements.sort((a, b) => a.rect.y - b.rect.y);
  
    const rows = [];
    let currentRow: SnapshotElement[] = [];
  
    for (const el of elements) {
      if (currentRow.length === 0 || Math.abs(el.rect.y - currentRow[0].rect.y) < tolerance) {
        currentRow.push(el);
      } else {
        rows.push(currentRow);
        currentRow = [el];
      }
    }
    if (currentRow.length) rows.push(currentRow);
  
    // 每行内按 x 排序
    rows.forEach((row) => row.sort((a, b) => a.rect.x - b.rect.x));
  
    // 展开成一维数组
    return rows.flat();
  }
  
  function isContained(inner: SnapshotRect, outer: SnapshotRect) {
    const result =
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height;
    return result;
  }
  
  const occupiedBoxZones: SnapshotRect[] = [];
  const occupiedLabelZones: SnapshotRect[] = [];
  const occupiedTextZones: SnapshotRect[] = [];
  
  function computeValidTextZones(el = document.body) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const results = [];
  
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const parent = textNode.parentElement;
      if (!parent) continue;
  
      // 样式判断：父元素不可见就跳过
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
        continue;
      }
  
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const text = range.toString().trim();
      if (!text) continue;
  
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) continue;
  
      // 进一步：采样检测是否被覆盖
      for (const rect of rects) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
  
        if (topEl && (topEl === parent || parent.contains(topEl))) {
          results.push({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            text,
          });
        }
      }
    }
  
    return results;
  }
  
  function drawLabeledBox(container: HTMLElement, element: HTMLElement, uid: string) {
    const box = element.getBoundingClientRect();
    const margin = 2;
    const labelSize = 10;
    const color = 'red';
  
    let zIndex = 1;
    const overlay = findOverlayAncestor(element);
    if (overlay) {
      zIndex = overlay.zIndex;
    }
    // 创建框和编号
    createBoxElement(container, box, color, zIndex);
    const label = createLabelElement(container, uid, labelSize, color);
    let zones = occupiedBoxZones.concat(occupiedLabelZones);
    // 如果某个元素完全被另外的元素包含，那么这个元素位置任何变化都是徒劳的，所以先忽略这种元素，正常布局
    zones = zones.filter((z) => !isContained(box, z));
    // 生成候选位置（八方向 + 微调）
    const candidates = getLabelCandidatesWithEightDirections(box, label, margin, zones);
  
    // 选择第一个有效位置
    let finalPos = candidates.find((pos) => isValidLabelPosition(pos as SnapshotRect, label, box, zones));
  
    if (!finalPos) {
      const candidates = getLabelCandidatesWithEightDirections(box, label, margin, occupiedLabelZones);
      finalPos = candidates.find((pos) => isValidLabelPosition(pos as SnapshotRect, label, box, occupiedLabelZones));
      if (!finalPos) {
        // fallback：右下角
        finalPos = { x: box.x + box.width + margin, y: box.y + box.height + margin };
      }
    }
  
    // 放置 label
    label.style.left = `${finalPos.x}px`;
    label.style.top = `${finalPos.y}px`;
  
    // 保存已占用区域
    occupiedLabelZones.push({ x: finalPos.x, y: finalPos.y, width: label.offsetWidth, height: label.offsetHeight });
  }
  
  function createBoxElement(container: HTMLElement, box: SnapshotRect, color: string, zIndex = 1) {
    const boxEl = document.createElement('div');
    boxEl.classList.add('__element-snapshot__');
    boxEl.style.position = 'fixed';
    boxEl.style.left = `${box.x}px`;
    boxEl.style.top = `${box.y}px`;
    boxEl.style.width = `${box.width}px`;
    boxEl.style.height = `${box.height}px`;
    boxEl.style.border = `1px solid ${color}`;
    boxEl.style.pointerEvents = 'none';
    boxEl.style.zIndex = zIndex.toString();
    container.appendChild(boxEl);
    return boxEl;
  }
  
  function createLabelElement(container: HTMLElement, uid: string, labelSize: number, color: string, zIndex = 1) {
    const label = document.createElement('div');
    label.classList.add('__element-snapshot__');
    label.innerText = uid;
    label.style.pointerEvents = 'none';
    label.style.position = 'fixed';
    label.style.background = color;
    label.style.color = 'white';
    label.style.fontSize = `${labelSize}px`;
    label.style.padding = '1px 2px';
    label.style.borderRadius = '4px';
    label.style.whiteSpace = 'nowrap';
    label.style.zIndex = zIndex.toString();
    container.appendChild(label);
    return label;
  }
  
  function getLabelCandidatesWithEightDirections(box: SnapshotRect, label: HTMLElement, margin: number, occupiedZones: SnapshotRect[]) {
    const w = label.offsetWidth;
    const h = label.offsetHeight;
  
    let basePoints = [
      { x: box.x + box.width / 2 - w / 2, y: box.y - h - margin }, // 上
      { x: box.x + box.width + margin, y: box.y + box.height / 2 - h / 2 }, // 右
      { x: box.x + box.width / 2 - w / 2, y: box.y + box.height + margin }, // 下
      { x: box.x - w - margin, y: box.y + box.height / 2 - h / 2 }, // 左
      { x: box.x + box.width + margin, y: box.y - h - margin }, // 右上
      { x: box.x - w - margin, y: box.y - h - margin }, // 左上
      { x: box.x - w - margin, y: box.y + box.height + margin }, // 左下
      { x: box.x + box.width + margin, y: box.y + box.height + margin }, // 右下
    ];
  
    const candidates = [];
  
    // 先过滤掉可能遮挡文本区域的点
    const validBasePoints = basePoints.filter((p) => isValidLabelPosition(p as SnapshotRect, label, box, occupiedTextZones));
    if (validBasePoints.length !== 0) {
      basePoints = validBasePoints;
    }
  
    for (const base of basePoints) {
      // 先尝试基准点
      if (isValidLabelPosition(base as SnapshotRect, label, box, occupiedZones)) {
        candidates.push(base);
        continue;
      }
  
      // 微调
      const steps = 5; // 微调步数
      let found = false;
  
      for (let i = 1; i <= steps; i++) {
        const offsets = [-i, i];
        for (const offset of offsets) {
          const pos = { ...base };
          // 根据方向选择微调轴，并限制偏移不超过 box 尺寸
          if (base.x === box.x - label.offsetWidth - margin || base.x === box.x + box.width + margin) {
            // 左右方向微调 y，限制在 box 高度范围内
            const deltaY = Math.max(Math.min(offset, box.height), -box.height);
            pos.y += deltaY;
          } else {
            // 上下方向微调 x，限制在 box 宽度范围内
            const deltaX = Math.max(Math.min(offset, box.width), -box.width);
            pos.x += deltaX;
          }
          if (isValidLabelPosition(pos as SnapshotRect, label, box, occupiedZones)) {
            candidates.push(pos);
            found = true;
            break;
          }
        }
        if (found) break;
      }
  
      if (!found) {
        candidates.push(base); // fallback
      }
    }
  
    return candidates;
  }
  
  function isLabelFullyInViewport(pos: SnapshotRect, label: HTMLElement) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
  
    const left = pos.x;
    const top = pos.y;
    const right = left + label.offsetWidth;
    const bottom = top + label.offsetHeight;
  
    return left >= 0 && top >= 0 && right <= viewportWidth && bottom <= viewportHeight;
  }
  
  function isValidLabelPosition(pos: SnapshotRect, label: HTMLElement, boxRect: SnapshotRect, zones: SnapshotRect[]) {
    const rect = { x: pos.x, y: pos.y, width: label.offsetWidth, height: label.offsetHeight };
  
    const inViewport = isLabelFullyInViewport(pos, label);
    if (!inViewport) return false;
  
    const overlapsZones = zones.some(
      (z) =>
        !(rect.x + rect.width < z.x || rect.x > z.x + z.width || rect.y + rect.height < z.y || rect.y > z.y + z.height),
    );
  
    const overlapsBox = !(
      rect.x + rect.width < boxRect.x ||
      rect.x > boxRect.x + boxRect.width ||
      rect.y + rect.height < boxRect.y ||
      rect.y > boxRect.y + boxRect.height
    );
  
    return !overlapsZones && !overlapsBox;
  }
  
  function isElementFullyInViewport(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
  
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
  
    // 元素左上角和右下角在 viewport 内
    const left = rect.left + scrollX;
    const top = rect.top + scrollY;
    const right = left + rect.width;
    const bottom = top + rect.height;
  
    return left >= scrollX && top >= scrollY && right <= scrollX + viewportWidth && bottom <= scrollY + viewportHeight;
  }

  function isElementEnoughSize(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    if(INPUT_TAGS.includes(element.tagName)) {
      return true;
    }
    return rect.width > 4 && rect.height > 4;
  }
  
  // 在页面上下文运行的函数：传入一个元素，返回该元素“会在 hover 时生效”的声明映射
  function getHoverDeclarationsForElement(element: HTMLElement, options: { includeAncestorHover: boolean } = { includeAncestorHover: true }) {
    const { includeAncestorHover = true } = options;
  
    const result: Record<string, string> = {}; // 最终 prop -> value
    const matchedRules: Array<{ selectorPart: string, selNoHover: string, rule: CSSRule | CSSMediaRule | CSSSupportsRule | CSSStyleRule }> = []; // 收集来源规则方便 debug
  
    function processRule(rule: CSSRule | CSSMediaRule | CSSSupportsRule | CSSStyleRule) {
      const STYLE_RULE = CSSRule.STYLE_RULE; // 1
      const MEDIA_RULE = CSSRule.MEDIA_RULE; // 4
      const SUPPORTS_RULE = CSSRule.SUPPORTS_RULE; // 12
  
      try {
        if (rule.type === STYLE_RULE) {
          const selText = (rule as CSSStyleRule).selectorText;
          if (!selText || selText.indexOf(':hover') === -1) return;
  
          // 按 , 拆分子选择器
          const parts = selText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  
          for (const part of parts) {
            if (part.indexOf(':hover') === -1) continue;
  
            // 去掉 :hover，保留其他伪类
            const selNoHover = part.replace(/:hover\b/g, '').trim();
            if (!selNoHover) continue;
  
            // 如果 includeAncestorHover === false，则只允许 :hover 在最后
            if (!includeAncestorHover) {
              const hoverIdx = part.indexOf(':hover');
              const after = part.slice(hoverIdx + ':hover'.length).trim();
              if (after.length !== 0) {
                continue; // 有后缀说明 :hover 作用在祖先
              }
            }
  
            // 检查是否匹配
            let matches = false;
            try {
              matches = element.matches(selNoHover);
            // eslint-disable-next-line
            } catch (e: unknown) {
              matches = false;
            }
  
            if (matches) {
              const style = (rule as CSSStyleRule).style;
              // eslint-disable-next-line
              for (let i = 0; i < style.length; i++) {
                const prop = style[i];
                if (prop) {
                  const val = style.getPropertyValue(prop);
                  result[prop] = val; // later overrides earlier
                }
              }
              matchedRules.push({ selectorPart: part, selNoHover, rule });
            }
          }
        } else if (rule.type === MEDIA_RULE) {
          // 检查 @media 条件
          // @ts-expect-error rule.media is not typed
          const cond = rule.conditionText || (rule.media && rule.media.mediaText);
          if (!cond || window.matchMedia(cond).matches) {
            // @ts-expect-error rule.cssRules is not typed
            for (const r of rule.cssRules) processRule(r);
          }
        } else if (rule.type === SUPPORTS_RULE) {
          // @ts-expect-error rule.cssRules is not typed
          for (const r of rule.cssRules) processRule(r);
        }
      // eslint-disable-next-line
      } catch (e) {
        // 忽略跨域 / 非法选择器等异常
      }
    }
  
    // 遍历所有样式表
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules || sheet.rules;
        // eslint-disable-next-line
      } catch (e) {
        continue; // 跨域跳过
      }
      if (!rules) continue;
      // @ts-expect-error CSSRuleList is not typed
      for (const r of rules) {
        processRule(r);
      }
    }
  
    return { declarations: result, matchedRules };
  }
  
  function getHoverComputedStyles(el: HTMLElement) {
    const { declarations: hoverStyles } = getHoverDeclarationsForElement(el);
  
    if (Object.keys(hoverStyles).length === 0) return null;
  
    // 2. 备份当前内联样式
    const oldStyle: Record<string, string> = {};
    for (const prop of Object.keys(hoverStyles)) {
      // @ts-expect-error el.style is not typed
      oldStyle[prop] = el.style[prop];
      // @ts-expect-error el.style is not typed
      el.style[prop] = hoverStyles[prop]; // 应用 hover 样式
    }
  
    // 3. 获取计算后的样式
    const cs = window.getComputedStyle(el);
    const computed: Record<string, string> = {};
    for (const prop of Object.keys(hoverStyles)) {
      // @ts-expect-error CSSStyleDeclaration is not typed
      computed[prop] = cs[prop];
    }
  
    // 4. 恢复原样
    for (const prop of Object.keys(oldStyle)) {
      // @ts-expect-error el.style is not typed
      el.style[prop] = oldStyle[prop] || '';
    }
  
    return computed;
  }
  const result: SnapshotElementResult[] = [];
  function snapshot() {
    // @ts-expect-error $$log is not typed
    $$log('snapshot start');
    occupiedBoxZones.length = 0;
    occupiedLabelZones.length = 0;
    occupiedTextZones.length = 0;
    let elements = getVisibleElementsWithInteraction(root);
    elements = elements.filter((e) => isElementFullyInViewport(e.element));
    elements = elements.filter((e) => isElementEnoughSize(e.element));
    elements = clusterAndSort(elements);
    elements.forEach((e) => {
      occupiedBoxZones.push(e.rect);
    });
    occupiedTextZones.push(...computeValidTextZones());
    elements.forEach((e, i) => {
      const uid = `#${snapshotId}_${i + 1}`;
      result.push({
        element: e.element,
        elementUuid: e.elementUuid,
        tag: e.tag,
        uid,
        text: e.text,
        interactiveTypes: e.interactiveTypes,
      });
      console.log('drawLabeledBox: ', e.element, e.interactiveTypes, e.debugInfo, i + 1);
      drawLabeledBox(document.body, e.element, uid);
    });
  }
  setup();
  snapshot();
  return result;
}
// TODO 要支持全页面截图
export const takeElementSnapshot = defineTool({
  name: 'take_element_snapshot',
  description: 'Capture a screenshot of the entire page or a specific element, and return two images: one is the original screenshot, and the other highlights all interactive elements with red boxes.',
  annotations: {
    category: ToolCategories.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    format: z
      .enum(['png', 'jpeg'])
      .optional()
      .default('png')
      .describe('Type of format to save the image snapshot as. Default is "png"'),
    uid: z.string().optional().describe('The uid of an element on the page from the page content snapshot')
  },
  handler: async (request, response, context) => {
    const uid = request.params.uid;
    const snapshotId = context.getNextElementSnapshotId();
    let pageOrHandle: Page | ElementHandle;
    const result: SnapshotElementResult[] = [];

    async function parseResultFromHandle(handle?: JSHandle<SnapshotElementResult[]>) {
      for (const prop of (await handle?.getProperties())?.values() ?? []) {
        const objHandle = prop; // 这是每个对象的 JSHandle
      
        // 拿对象的字段
        const elementUuidHandle = await objHandle.getProperty('elementUuid');
        const elementUuid = await elementUuidHandle.jsonValue();

        const tagHandle = await objHandle.getProperty('tag');
        const tag = await tagHandle.jsonValue();

        const textHandle = await objHandle.getProperty('text');
        const text = await textHandle.jsonValue();

        const interactiveTypesHandle = await objHandle.getProperty('interactiveTypes');
        const interactiveTypes = await interactiveTypesHandle.jsonValue();

        const uidHandle = await objHandle.getProperty('uid');
        const uid = await uidHandle.jsonValue();

        const elementHandle = (await objHandle.getProperty('element')).asElement();
      
        result.push({
          element: elementHandle as ElementHandle<Element>,
          elementUuid: elementUuid as string,
          tag: tag as string,
          uid: uid as string,
          text: text as string,
          interactiveTypes: interactiveTypes as string[],
        });
        await textHandle.dispose();
        await objHandle.dispose();
      }
      await context.setElementSnapshot(snapshotId, result);
    }

    if (uid) {
      pageOrHandle = await context.getElementByUid(uid);
      // @ts-expect-error snapshotElement is not typed
      await pageOrHandle.evaluate(clearLabels);
      response.appendResponseLine(`Image snapshot of all interactive elements and their labels on the Element(${uid}) have been generated.`);
      // @ts-expect-error snapshotElement is not typed
      const handle = await handle.evaluateHandle(snapshotElement, snapshotId.toString());
      await parseResultFromHandle(handle);
    } else {
      pageOrHandle = context.getSelectedPage();
      await pageOrHandle.exposeFunction('$$log', (...args: unknown[]) => {
        // console.log('Called from page:', args);
        console.log(...args);
      });
      const body = await pageOrHandle.$("body");
      // @ts-expect-error snapshotElement is not typed
      await body.evaluate(clearLabels);
      const handle = await body?.evaluateHandle(snapshotElement, snapshotId.toString());
      await parseResultFromHandle(handle);
      response.appendResponseLine('# Image snapshot of all interactive elements and their labels on the page have been generated.');
    }
    const screenshot = await pageOrHandle.screenshot({type: request.params.format});
    response.appendResponseLine("## Interactive elements and their labels, json format");
    response.appendResponseLine('```json');
    response.appendResponseLine(JSON.stringify(result, null, 2));
    response.appendResponseLine('```');
    if (screenshot.length >= 2_000_000) {
      const {filename} = await context.saveTemporaryFile(
        screenshot,
        `image/${request.params.format}`,
      );
      response.appendResponseLine(`# Saved image snapshot of all interactive elements and their labels to ${filename}.`);
    } else {
      response.attachImage({
        mimeType: `image/${request.params.format}`,
        data: Buffer.from(screenshot).toString('base64'),
      });
    }
  },
});