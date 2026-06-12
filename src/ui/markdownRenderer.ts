const HTML_NS = "http://www.w3.org/1999/xhtml";
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

type AppendTarget = DocumentFragment | HTMLElement;

type ListItem = {
  checked: boolean | null;
  indent: number;
  ordered: boolean;
  text: string;
};

type ListBlock = {
  element: HTMLOListElement | HTMLUListElement;
  nextIndex: number;
};

type TableBlock = {
  headers: string[];
  nextIndex: number;
  rows: string[][];
};

export function renderMarkdownContent(doc: Document, markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  return renderMarkdownLines(doc, normalized.split("\n"));
}

function renderMarkdownLines(doc: Document, lines: string[]) {
  const fragment = doc.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isCodeFenceStart(line)) {
      const codeBlock = collectCodeBlock(lines, index);
      appendCodeBlock(doc, fragment, codeBlock.content, codeBlock.language);
      index = codeBlock.nextIndex;
      continue;
    }

    if (isMathBlockStart(line)) {
      const mathBlock = collectMathBlock(lines, index);
      appendMathBlock(doc, fragment, mathBlock.content);
      index = mathBlock.nextIndex;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      appendHeading(doc, fragment, heading.level, heading.text);
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      fragment.append(createHtmlElement(doc, "hr"));
      index += 1;
      continue;
    }

    const table = parseTableBlock(lines, index);
    if (table) {
      appendTable(doc, fragment, table);
      index = table.nextIndex;
      continue;
    }

    if (isBlockquoteLine(line)) {
      const blockquote = collectBlockquote(lines, index);
      appendBlockquote(doc, fragment, blockquote.lines);
      index = blockquote.nextIndex;
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      const listBlock = collectListBlock(
        doc,
        lines,
        index,
        listItem.indent,
        listItem.ordered,
      );
      fragment.append(listBlock.element);
      index = listBlock.nextIndex;
      continue;
    }

    const paragraph = collectParagraph(lines, index);
    appendParagraph(doc, fragment, paragraph.lines);
    index = paragraph.nextIndex;
  }

  return fragment;
}

function collectCodeBlock(lines: string[], startIndex: number) {
  const openingLine = lines[startIndex] ?? "";
  const openingMatch = openingLine.match(/^\s*(```|~~~)\s*([A-Za-z0-9_-]*)/);
  const fence = openingMatch?.[1] ?? "```";
  const language = normalizeLanguage(openingMatch?.[2] ?? "");
  const content: string[] = [];
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (new RegExp(`^\\s*${escapeRegExp(fence)}\\s*$`).test(line)) {
      return {
        content: content.join("\n"),
        language,
        nextIndex: index + 1,
      };
    }

    content.push(line);
    index += 1;
  }

  return {
    content: content.join("\n"),
    language,
    nextIndex: index,
  };
}

function collectMathBlock(lines: string[], startIndex: number) {
  const openingLine = lines[startIndex]?.trim() ?? "";
  const inlineMatch = openingLine.match(/^\$\$\s*(.*?)\s*\$\$$/);
  if (inlineMatch && inlineMatch[1]) {
    return {
      content: inlineMatch[1],
      nextIndex: startIndex + 1,
    };
  }

  const content: string[] = [];
  const firstLineContent = openingLine.replace(/^\$\$\s*/, "");
  if (firstLineContent) {
    content.push(firstLineContent);
  }

  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const closingIndex = line.indexOf("$$");
    if (closingIndex >= 0) {
      const beforeClosing = line.slice(0, closingIndex).trimEnd();
      if (beforeClosing) {
        content.push(beforeClosing);
      }

      return {
        content: content.join("\n").trim(),
        nextIndex: index + 1,
      };
    }

    content.push(line);
    index += 1;
  }

  return {
    content: content.join("\n").trim(),
    nextIndex: index,
  };
}

function collectBlockquote(lines: string[], startIndex: number) {
  const quoteLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isBlockquoteLine(line)) break;

    quoteLines.push(line.replace(/^\s{0,3}>\s?/, ""));
    index += 1;
  }

  return {
    lines: quoteLines,
    nextIndex: index,
  };
}

function collectListBlock(
  doc: Document,
  lines: string[],
  startIndex: number,
  baseIndent: number,
  ordered: boolean,
): ListBlock {
  const list = createHtmlElement(doc, ordered ? "ol" : "ul");
  let index = startIndex;
  let lastListItem: HTMLLIElement | null = null;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      break;
    }

    const item = parseListItem(line);
    if (!item) {
      const continuationIndent = countIndent(line);
      if (lastListItem && continuationIndent > baseIndent) {
        lastListItem.append(createHtmlElement(doc, "br"));
        appendInlineMarkdown(doc, lastListItem, line.trim());
        index += 1;
        continue;
      }

      break;
    }

    if (item.indent < baseIndent) break;

    if (item.indent > baseIndent) {
      if (!lastListItem) break;

      const nestedList = collectListBlock(
        doc,
        lines,
        index,
        item.indent,
        item.ordered,
      );
      lastListItem.append(nestedList.element);
      index = nestedList.nextIndex;
      continue;
    }

    if (item.ordered !== ordered) break;

    const listItem = createHtmlElement(doc, "li");
    appendListItemContent(doc, listItem, item);
    list.append(listItem);
    lastListItem = listItem;
    index += 1;
  }

  return {
    element: list,
    nextIndex: index,
  };
}

function collectParagraph(lines: string[], startIndex: number) {
  const paragraphLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) break;
    if (index > startIndex && isBlockStart(lines, index)) break;

    paragraphLines.push(line);
    index += 1;
  }

  return {
    lines: paragraphLines,
    nextIndex: index,
  };
}

function appendHeading(
  doc: Document,
  target: AppendTarget,
  level: number,
  text: string,
) {
  const heading = createHtmlElement(doc, HEADING_TAGS[level - 1] ?? "h6");
  appendInlineMarkdown(doc, heading, text);
  target.append(heading);
}

function appendParagraph(doc: Document, target: AppendTarget, lines: string[]) {
  const paragraph = createHtmlElement(doc, "p");
  appendInlineLines(doc, paragraph, lines);
  target.append(paragraph);
}

function appendBlockquote(
  doc: Document,
  target: AppendTarget,
  lines: string[],
) {
  const blockquote = createHtmlElement(doc, "blockquote");
  blockquote.append(renderMarkdownLines(doc, lines));
  target.append(blockquote);
}

function appendListItemContent(
  doc: Document,
  listItem: HTMLLIElement,
  item: ListItem,
) {
  if (item.checked === null) {
    appendInlineMarkdown(doc, listItem, item.text);
    return;
  }

  listItem.classList.add("zai-task-list-item");

  const checkbox = createHtmlElement(doc, "input");
  checkbox.type = "checkbox";
  checkbox.checked = item.checked;
  checkbox.disabled = true;
  checkbox.tabIndex = -1;

  const text = createHtmlElement(doc, "span");
  appendInlineMarkdown(doc, text, item.text);
  listItem.append(checkbox, text);
}

function appendTable(
  doc: Document,
  target: AppendTarget,
  tableBlock: TableBlock,
) {
  const scroll = createHtmlElement(doc, "div");
  const table = createHtmlElement(doc, "table");
  const thead = createHtmlElement(doc, "thead");
  const headerRow = createHtmlElement(doc, "tr");
  const tbody = createHtmlElement(doc, "tbody");

  scroll.className = "zai-table-scroll";

  for (const header of tableBlock.headers) {
    const cell = createHtmlElement(doc, "th");
    appendInlineMarkdown(doc, cell, header);
    headerRow.append(cell);
  }

  for (const row of tableBlock.rows) {
    const tableRow = createHtmlElement(doc, "tr");
    const cellCount = Math.max(row.length, tableBlock.headers.length);

    for (let index = 0; index < cellCount; index += 1) {
      const cell = createHtmlElement(doc, "td");
      appendInlineMarkdown(doc, cell, row[index] ?? "");
      tableRow.append(cell);
    }

    tbody.append(tableRow);
  }

  thead.append(headerRow);
  table.append(thead, tbody);
  scroll.append(table);
  target.append(scroll);
}

function appendCodeBlock(
  doc: Document,
  target: AppendTarget,
  content: string,
  language: string,
) {
  const pre = createHtmlElement(doc, "pre");
  const code = createHtmlElement(doc, "code");

  if (language) {
    code.className = `language-${language}`;
  }
  code.textContent = content;
  pre.append(code);
  target.append(pre);
}

function appendMathBlock(doc: Document, target: AppendTarget, content: string) {
  const math = createHtmlElement(doc, "div");
  math.className = "zai-math-block";
  math.textContent = content;
  target.append(math);
}

function appendInlineLines(
  doc: Document,
  target: AppendTarget,
  lines: string[],
) {
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      target.append(createHtmlElement(doc, "br"));
    }
    appendInlineMarkdown(doc, target, line);
  });
}

function appendInlineMarkdown(
  doc: Document,
  target: AppendTarget,
  text: string,
) {
  let index = 0;
  let plainText = "";

  const flushPlainText = () => {
    if (!plainText) return;

    target.append(doc.createTextNode(plainText));
    plainText = "";
  };

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character === "\\" && index + 1 < text.length) {
      plainText += text[index + 1] ?? "";
      index += 2;
      continue;
    }

    if (text.startsWith("***", index)) {
      const closingIndex = findClosingSequence(text, "***", index + 3);
      if (closingIndex >= 0) {
        flushPlainText();
        const strong = createHtmlElement(doc, "strong");
        const emphasis = createHtmlElement(doc, "em");
        appendInlineMarkdown(
          doc,
          emphasis,
          text.slice(index + 3, closingIndex),
        );
        strong.append(emphasis);
        target.append(strong);
        index = closingIndex + 3;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const closingIndex = findClosingSequence(text, "**", index + 2);
      if (closingIndex >= 0) {
        flushPlainText();
        const strong = createHtmlElement(doc, "strong");
        appendInlineMarkdown(doc, strong, text.slice(index + 2, closingIndex));
        target.append(strong);
        index = closingIndex + 2;
        continue;
      }
    }

    if (text.startsWith("__", index)) {
      const closingIndex = findClosingSequence(text, "__", index + 2);
      if (closingIndex >= 0) {
        flushPlainText();
        const underline = createHtmlElement(doc, "u");
        appendInlineMarkdown(
          doc,
          underline,
          text.slice(index + 2, closingIndex),
        );
        target.append(underline);
        index = closingIndex + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const closingIndex = findClosingSequence(text, "~~", index + 2);
      if (closingIndex >= 0) {
        flushPlainText();
        const strike = createHtmlElement(doc, "s");
        appendInlineMarkdown(doc, strike, text.slice(index + 2, closingIndex));
        target.append(strike);
        index = closingIndex + 2;
        continue;
      }
    }

    if (text.startsWith("==", index)) {
      const closingIndex = findClosingSequence(text, "==", index + 2);
      if (closingIndex >= 0) {
        flushPlainText();
        const mark = createHtmlElement(doc, "mark");
        appendInlineMarkdown(doc, mark, text.slice(index + 2, closingIndex));
        target.append(mark);
        index = closingIndex + 2;
        continue;
      }
    }

    if (character === "`") {
      const closingIndex = findClosingSequence(text, "`", index + 1);
      if (closingIndex >= 0) {
        flushPlainText();
        const code = createHtmlElement(doc, "code");
        code.textContent = text.slice(index + 1, closingIndex);
        target.append(code);
        index = closingIndex + 1;
        continue;
      }
    }

    if (character === "$" && !text.startsWith("$$", index)) {
      const closingIndex = findClosingSequence(text, "$", index + 1);
      if (closingIndex >= 0) {
        flushPlainText();
        const math = createHtmlElement(doc, "span");
        math.className = "zai-math-inline";
        math.textContent = text.slice(index + 1, closingIndex);
        target.append(math);
        index = closingIndex + 1;
        continue;
      }
    }

    if (character === "*") {
      const closingIndex = findClosingSingleMarker(text, "*", index + 1);
      if (closingIndex >= 0) {
        flushPlainText();
        const emphasis = createHtmlElement(doc, "em");
        appendInlineMarkdown(
          doc,
          emphasis,
          text.slice(index + 1, closingIndex),
        );
        target.append(emphasis);
        index = closingIndex + 1;
        continue;
      }
    }

    if (character === "~" && !text.startsWith("~~", index)) {
      const closingIndex = findClosingSingleMarker(text, "~", index + 1);
      if (closingIndex >= 0) {
        flushPlainText();
        const subscript = createHtmlElement(doc, "sub");
        appendInlineMarkdown(
          doc,
          subscript,
          text.slice(index + 1, closingIndex),
        );
        target.append(subscript);
        index = closingIndex + 1;
        continue;
      }
    }

    if (character === "^") {
      const closingIndex = findClosingSingleMarker(text, "^", index + 1);
      if (closingIndex >= 0) {
        flushPlainText();
        const superscript = createHtmlElement(doc, "sup");
        appendInlineMarkdown(
          doc,
          superscript,
          text.slice(index + 1, closingIndex),
        );
        target.append(superscript);
        index = closingIndex + 1;
        continue;
      }

      const compactSuperscript = readCompactSuperscript(text, index + 1);
      if (compactSuperscript) {
        flushPlainText();
        const superscript = createHtmlElement(doc, "sup");
        superscript.textContent = compactSuperscript.value;
        target.append(superscript);
        index = compactSuperscript.nextIndex;
        continue;
      }
    }

    plainText += character;
    index += 1;
  }

  flushPlainText();
}

function parseHeading(line: string) {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;

  return {
    level: match[1]?.length ?? 1,
    text: match[2] ?? "",
  };
}

function parseListItem(line: string): ListItem | null {
  const match = line.match(/^([ \t]*)([-+*]|\d+[.)])\s+(.*)$/);
  if (!match) return null;

  const marker = match[2] ?? "";
  let text = match[3] ?? "";
  let checked: boolean | null = null;
  const checkboxMatch = text.match(/^\[([ xX])\]\s*(.*)$/);

  if (checkboxMatch) {
    checked = checkboxMatch[1]?.toLowerCase() === "x";
    text = checkboxMatch[2] ?? "";
  }

  return {
    checked,
    indent: countIndent(match[1] ?? ""),
    ordered: /^\d/.test(marker),
    text,
  };
}

function parseTableBlock(
  lines: string[],
  startIndex: number,
): TableBlock | null {
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";
  if (!isTableRow(headerLine) || !isTableSeparator(separatorLine)) return null;

  const headers = splitTableCells(headerLine);
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || !isTableRow(line) || isTableSeparator(line)) break;

    rows.push(splitTableCells(line));
    index += 1;
  }

  return {
    headers,
    rows,
    nextIndex: index,
  };
}

function splitTableCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? "";
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }

    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells;
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? "";
  return (
    isCodeFenceStart(line) ||
    isMathBlockStart(line) ||
    Boolean(parseHeading(line)) ||
    isHorizontalRule(line) ||
    Boolean(parseTableBlock(lines, index)) ||
    isBlockquoteLine(line) ||
    Boolean(parseListItem(line))
  );
}

function isCodeFenceStart(line: string) {
  return /^\s*(```|~~~)/.test(line);
}

function isMathBlockStart(line: string) {
  return /^\s*\$\$/.test(line);
}

function isBlockquoteLine(line: string) {
  return /^\s{0,3}>/.test(line);
}

function isHorizontalRule(line: string) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isTableRow(line: string) {
  return line.includes("|") && splitTableCells(line).length > 1;
}

function isTableSeparator(line: string) {
  if (!isTableRow(line)) return false;

  return splitTableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function countIndent(value: string) {
  return [...value].reduce((count, character) => {
    return count + (character === "\t" ? 4 : 1);
  }, 0);
}

function findClosingSequence(text: string, marker: string, startIndex: number) {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text.startsWith(marker, index) && !isEscaped(text, index)) {
      return index;
    }
  }

  return -1;
}

function findClosingSingleMarker(
  text: string,
  marker: string,
  startIndex: number,
) {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] !== marker) continue;
    if (text[index - 1] === marker || text[index + 1] === marker) continue;
    if (isEscaped(text, index)) continue;

    return index;
  }

  return -1;
}

function readCompactSuperscript(text: string, startIndex: number) {
  const match = text.slice(startIndex).match(/^[A-Za-z0-9+-]+/);
  if (!match?.[0]) return null;

  return {
    nextIndex: startIndex + match[0].length,
    value: match[0],
  };
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
}

function normalizeLanguage(language: string) {
  const firstToken = language.trim().split(/\s+/)[0] ?? "";
  return firstToken.replace(/[^A-Za-z0-9_-]/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
) {
  return doc.createElementNS(HTML_NS, tagName) as HTMLElementTagNameMap[K];
}
