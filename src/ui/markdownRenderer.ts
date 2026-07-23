const HTML_NS = "http://www.w3.org/1999/xhtml";
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * DOM containers into which parsed Markdown nodes can be appended.
 */
type AppendTarget = DocumentFragment | HTMLElement;

/**
 * Parsed list item including nesting, marker type, and optional task state.
 */
type ListItem = {
  checked: boolean | null;
  indent: number;
  ordered: boolean;
  text: string;
};

/**
 * Rendered list together with the first source line after the list.
 */
type ListBlock = {
  element: HTMLOListElement | HTMLUListElement;
  nextIndex: number;
};

/**
 * Parsed GitHub-style table and the first source line after the table.
 */
type TableBlock = {
  headers: string[];
  nextIndex: number;
  rows: string[][];
};

/**
 * Converts supported Markdown into safe DOM nodes without using innerHTML.
 *
 * @param doc - Document that owns the rendered elements.
 * @param markdown - Markdown source to render.
 * @returns Document fragment containing the rendered content.
 */
export function renderMarkdownContent(doc: Document, markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  return renderMarkdownLines(doc, normalized.split("\n"));
}

/**
 * Parses and renders a sequence of normalized Markdown lines.
 *
 * @param doc - Document that owns the rendered elements.
 * @param lines - Markdown source split into lines.
 * @returns Document fragment containing block-level elements.
 */
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

/**
 * Collects a fenced code block and its optional language identifier.
 *
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Index of the opening fence.
 * @returns Code content, normalized language, and next unread line index.
 */
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

/**
 * Collects single-line or fenced display-math content.
 *
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Index of the opening math delimiter.
 * @returns Math content and next unread line index.
 */
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

/**
 * Removes quote markers from consecutive blockquote lines.
 *
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Index of the first quoted line.
 * @returns Inner quote lines and next unread line index.
 */
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

/**
 * Recursively renders consecutive list items at one indentation level.
 *
 * @param doc - Document that owns the rendered list.
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Index of the first list item.
 * @param baseIndent - Indentation belonging to this list level.
 * @param ordered - Whether this list uses ordered markers.
 * @returns Rendered list and next unread line index.
 */
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

/**
 * Collects paragraph lines until a blank line or a new block starts.
 *
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Index of the first paragraph line.
 * @returns Paragraph lines and next unread line index.
 */
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

/**
 * Appends a heading with recursively rendered inline Markdown.
 *
 * @param doc - Document that owns the heading.
 * @param target - Container receiving the heading.
 * @param level - Markdown heading level from one through six.
 * @param text - Heading content.
 * @returns Nothing.
 */
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

/**
 * Appends a paragraph while preserving source line breaks.
 *
 * @param doc - Document that owns the paragraph.
 * @param target - Container receiving the paragraph.
 * @param lines - Paragraph source lines.
 * @returns Nothing.
 */
function appendParagraph(doc: Document, target: AppendTarget, lines: string[]) {
  const paragraph = createHtmlElement(doc, "p");
  appendInlineLines(doc, paragraph, lines);
  target.append(paragraph);
}

/**
 * Appends a blockquote whose inner lines are parsed as Markdown blocks.
 *
 * @param doc - Document that owns the blockquote.
 * @param target - Container receiving the blockquote.
 * @param lines - Blockquote content without quote markers.
 * @returns Nothing.
 */
function appendBlockquote(
  doc: Document,
  target: AppendTarget,
  lines: string[],
) {
  const blockquote = createHtmlElement(doc, "blockquote");
  blockquote.append(renderMarkdownLines(doc, lines));
  target.append(blockquote);
}

/**
 * Appends normal inline content or a disabled task-list checkbox.
 *
 * @param doc - Document that owns the list item controls.
 * @param listItem - List item element to populate.
 * @param item - Parsed list-item data.
 * @returns Nothing.
 */
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

/**
 * Appends a scrollable table with inline Markdown in every cell.
 *
 * @param doc - Document that owns the table.
 * @param target - Container receiving the table wrapper.
 * @param tableBlock - Parsed headers and body rows.
 * @returns Nothing.
 */
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

/**
 * Appends a fenced code block using textContent for safe rendering.
 *
 * @param doc - Document that owns the code elements.
 * @param target - Container receiving the code block.
 * @param content - Literal code content.
 * @param language - Sanitized language identifier for styling.
 * @returns Nothing.
 */
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

/**
 * Appends display-math source for CSS-based presentation.
 *
 * @param doc - Document that owns the math element.
 * @param target - Container receiving the math block.
 * @param content - Literal math source.
 * @returns Nothing.
 */
function appendMathBlock(doc: Document, target: AppendTarget, content: string) {
  const math = createHtmlElement(doc, "div");
  math.className = "zai-math-block";
  math.textContent = content;
  target.append(math);
}

/**
 * Renders each paragraph line and inserts explicit line-break elements.
 *
 * @param doc - Document that owns inserted nodes.
 * @param target - Container receiving inline content.
 * @param lines - Source lines to render.
 * @returns Nothing.
 */
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

/**
 * Parses supported inline Markdown markers into safe nested DOM elements.
 *
 * Supported syntax includes emphasis, underline, strike-through, highlights,
 * code, inline math, subscript, and superscript. Backslashes escape markers.
 *
 * @param doc - Document that owns inserted nodes.
 * @param target - Container receiving inline content.
 * @param text - Inline Markdown source.
 * @returns Nothing.
 */
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

/**
 * Parses an ATX heading line.
 *
 * @param line - Markdown line to inspect.
 * @returns Heading level and text, or null when the line is not a heading.
 */
function parseHeading(line: string) {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;

  return {
    level: match[1]?.length ?? 1,
    text: match[2] ?? "",
  };
}

/**
 * Parses unordered, ordered, and task-list item markers.
 *
 * @param line - Markdown line to inspect.
 * @returns Parsed list item, or null when no list marker is present.
 */
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

/**
 * Parses a GitHub-style pipe table beginning at a line index.
 *
 * @param lines - Complete Markdown line sequence.
 * @param startIndex - Candidate header-row index.
 * @returns Parsed table block, or null when no valid separator follows.
 */
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

/**
 * Splits a pipe-table row while preserving escaped pipe characters.
 *
 * @param line - Table row source.
 * @returns Trimmed cell contents.
 */
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

/**
 * Detects whether a line starts any supported block-level construct.
 *
 * @param lines - Complete Markdown line sequence.
 * @param index - Line index to inspect.
 * @returns True when the line begins a non-paragraph block.
 */
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

/**
 * Detects a backtick or tilde code fence.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line opens a fenced code block.
 */
function isCodeFenceStart(line: string) {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * Detects an opening display-math delimiter.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line starts with a double dollar delimiter.
 */
function isMathBlockStart(line: string) {
  return /^\s*\$\$/.test(line);
}

/**
 * Detects a Markdown blockquote marker.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line belongs to a blockquote.
 */
function isBlockquoteLine(line: string) {
  return /^\s{0,3}>/.test(line);
}

/**
 * Detects Markdown horizontal rules made from repeated matching markers.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line represents a horizontal rule.
 */
function isHorizontalRule(line: string) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

/**
 * Checks whether a line contains at least two pipe-separated cells.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line has table-row structure.
 */
function isTableRow(line: string) {
  return line.includes("|") && splitTableCells(line).length > 1;
}

/**
 * Checks whether every table cell is a valid alignment separator.
 *
 * @param line - Markdown line to inspect.
 * @returns True when the line separates table headers from body rows.
 */
function isTableSeparator(line: string) {
  if (!isTableRow(line)) return false;

  return splitTableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Counts indentation while treating a tab as four spaces.
 *
 * @param value - Leading whitespace to measure.
 * @returns Equivalent indentation width in spaces.
 */
function countIndent(value: string) {
  return [...value].reduce((count, character) => {
    return count + (character === "\t" ? 4 : 1);
  }, 0);
}

/**
 * Finds the next unescaped occurrence of a multi-character marker.
 *
 * @param text - Inline source to scan.
 * @param marker - Closing marker to find.
 * @param startIndex - First character index to inspect.
 * @returns Closing-marker index, or -1 when unmatched.
 */
function findClosingSequence(text: string, marker: string, startIndex: number) {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text.startsWith(marker, index) && !isEscaped(text, index)) {
      return index;
    }
  }

  return -1;
}

/**
 * Finds an unescaped marker that is not part of a doubled marker.
 *
 * @param text - Inline source to scan.
 * @param marker - Single-character closing marker.
 * @param startIndex - First character index to inspect.
 * @returns Closing-marker index, or -1 when unmatched.
 */
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

/**
 * Reads an unwrapped alphanumeric superscript immediately after a caret.
 *
 * @param text - Inline source containing the superscript.
 * @param startIndex - Index immediately after the opening caret.
 * @returns Parsed value and next index, or null when no value follows.
 */
function readCompactSuperscript(text: string, startIndex: number) {
  const match = text.slice(startIndex).match(/^[A-Za-z0-9+-]+/);
  if (!match?.[0]) return null;

  return {
    nextIndex: startIndex + match[0].length,
    value: match[0],
  };
}

/**
 * Determines whether a character is preceded by an odd number of backslashes.
 *
 * @param text - Inline source containing the character.
 * @param index - Character index to inspect.
 * @returns True when the character is escaped.
 */
function isEscaped(text: string, index: number) {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
}

/**
 * Sanitizes a code-fence language for use in a CSS class name.
 *
 * @param language - Raw language suffix from an opening fence.
 * @returns First safe language token, or an empty string.
 */
function normalizeLanguage(language: string) {
  const firstToken = language.trim().split(/\s+/)[0] ?? "";
  return firstToken.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Escapes regular-expression metacharacters in a literal string.
 *
 * @param value - Literal value to escape.
 * @returns Regex-safe string.
 */
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Creates a typed XHTML element in Zotero's document namespace.
 *
 * @param doc - Document that owns the element.
 * @param tagName - HTML tag name to create.
 * @returns Typed element in the XHTML namespace.
 */
function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
) {
  return doc.createElementNS(HTML_NS, tagName) as HTMLElementTagNameMap[K];
}
