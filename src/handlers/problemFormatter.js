import TurndownService from "turndown";

// 🚀 Convert a Codeforces problem-statement DOM into GitHub-flavored Markdown.
// This is meant to run in the content script (real page context) where MathJax
// has rendered and DOM APIs are available — unlike the service worker, which has
// no DOMParser/document and therefore cannot run Turndown at all.
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});

// Drop MathJax's presentation layers (rendered glyphs / previews) so they don't
// get emitted as duplicated or garbled text next to the real math source.
turndownService.remove((node) => {
  return (
    node.nodeName === "SPAN" &&
    typeof node.className === "string" &&
    /\bMathJax(_Preview|_Display|_SVG|_CHTML)?\b/.test(node.className)
  );
});

// Remove non-math scripts/styles. Math scripts are handled by the rule below and
// take precedence over this removal (added rules run before remove filters).
turndownService.remove((node) => {
  return (
    node.nodeName === "SCRIPT" &&
    !/^math\/tex/.test(node.getAttribute("type") || "")
  );
});
turndownService.remove(["style", "noscript"]);

// Codeforces keeps the TeX source in <script type="math/tex">. Emit GitHub-native
// delimiters: $...$ for inline, $$...$$ for display.
turndownService.addRule("mathjax", {
  filter: (node) =>
    node.nodeName === "SCRIPT" &&
    /^math\/tex/.test(node.getAttribute("type") || ""),
  replacement: (_content, node) => {
    const isDisplay = (node.getAttribute("type") || "").includes("mode=display");
    const tex = (node.textContent || "").trim();
    if (!tex) return "";
    return isDisplay ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
  },
});

// Inline teletype spans -> inline code.
turndownService.addRule("tex-tt", {
  filter: (node) =>
    node.nodeName === "SPAN" &&
    typeof node.className === "string" &&
    node.className.includes("tex-font-style-tt"),
  replacement: (content) => `\`${content}\``,
});

// Extract the textual content of a <pre>, preserving line breaks. Newer
// Codeforces pages wrap each sample line in <div class="test-example-line">.
const preText = (node) => {
  const lines = node.querySelectorAll(".test-example-line");
  const raw =
    lines.length > 0
      ? Array.from(lines)
          .map((l) => l.textContent)
          .join("\n")
      : node.textContent || "";
  return raw.replace(/\s+$/, "");
};

// Codeforces sample tests use bare <pre> without a <code> child, so Turndown's
// default code-block rules skip them. Emit them as fenced code blocks.
turndownService.addRule("cfPre", {
  filter: "pre",
  replacement: (_content, node) => `\n\n\`\`\`\n${preText(node)}\n\`\`\`\n\n`,
});

// Has MathJax finished turning $$$...$$$ into <script type="math/tex">?
// Ready when math was processed, or when there was never any math to begin with.
// Raw $$$ inside <pre>/<code> (e.g. sample tests) is ignored so it doesn't block us.
export const isMathReady = (element) => {
  if (element.querySelector('script[type^="math/tex"]')) return true;
  const clone = element.cloneNode(true);
  clone.querySelectorAll("pre, code").forEach((n) => n.remove());
  return !clone.textContent.includes("$$$");
};

const convertProblemToMarkdown = (element) => {
  try {
    let markdown = turndownService.turndown(element);

    // Normalize any LaTeX delimiters Turndown passed through verbatim.
    // Note: in a replacement string "$$" means a literal "$", so "$$$$" -> "$$".
    markdown = markdown.replace(/\\\(/g, "$").replace(/\\\)/g, "$");
    markdown = markdown.replace(/\\\[/g, "$$$$").replace(/\\\]/g, "$$$$");

    // Safety net: if MathJax hadn't rendered yet (forced extraction), the raw CF
    // delimiter $$$...$$$ may survive. Convert it to GitHub's $...$ — but never
    // touch code spans/blocks, where $$$ can be legitimate sample data.
    const codeStore = [];
    markdown = markdown.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
      codeStore.push(m);
      return ` CFCODE${codeStore.length - 1} `;
    });
    markdown = markdown.replace(
      /\$\$\$([\s\S]+?)\$\$\$/g,
      (_, tex) => `$${tex.trim()}$`
    );
    markdown = markdown.replace(/ CFCODE(\d+) /g, (_, i) => codeStore[Number(i)]);

    return markdown.replace(/\n{3,}/g, "\n\n").trim();
  } catch (err) {
    console.warn("⚠️ Failed to convert problem statement to Markdown:", err);
    return null;
  }
};

// Direct children of .problem-statement that are NOT the free-form statement body.
const KNOWN_SECTION_CLASSES = [
  "header",
  "input-specification",
  "output-specification",
  "sample-tests",
  "note",
];

// Convert a single section's body to Markdown, dropping Codeforces' own section
// labels (we emit our own headings instead).
const sectionToMarkdown = (element) => {
  if (!element) return "";
  const clone = element.cloneNode(true);
  clone
    .querySelectorAll(".section-title, .property-title")
    .forEach((n) => n.remove());
  return convertProblemToMarkdown(clone) || "";
};

// Assemble a structured README mirroring a Codeforces problem's layout:
// Limits / Problem / Input / Output / Examples / Note. Falls back to a flat
// conversion when the expected structure isn't present (e.g. non-standard pages).
export const buildProblemMarkdown = (root) => {
  const parts = [];

  // Limits (time / memory)
  const header = root.querySelector(".header");
  if (header) {
    const limitValue = (sel) => {
      const node = header.querySelector(sel);
      if (!node) return "";
      const c = node.cloneNode(true);
      c.querySelectorAll(".property-title").forEach((n) => n.remove());
      return c.textContent.replace(/\s+/g, " ").trim();
    };
    const time = limitValue(".time-limit").replace(/\s*seconds?$/i, "s");
    const memory = limitValue(".memory-limit");
    const bits = [];
    if (time) bits.push(`time: ${time}`);
    if (memory) bits.push(`memory: ${memory}`);
    if (bits.length) parts.push(`### Limits\n\n${bits.join(", ")}`);
  }

  // Problem body: the first element after the header that isn't a known section.
  let body = header ? header.nextElementSibling : root.firstElementChild;
  while (body) {
    const cls = typeof body.className === "string" ? body.className : "";
    const classList = cls.split(/\s+/);
    if (!KNOWN_SECTION_CLASSES.some((k) => classList.includes(k))) break;
    body = body.nextElementSibling;
  }
  const problemMd = sectionToMarkdown(body);
  if (problemMd) parts.push(`## Problem\n\n${problemMd}`);

  // Input / Output specifications
  const inputMd = sectionToMarkdown(root.querySelector(".input-specification"));
  if (inputMd) parts.push(`### Input\n\n${inputMd}`);
  const outputMd = sectionToMarkdown(
    root.querySelector(".output-specification")
  );
  if (outputMd) parts.push(`### Output\n\n${outputMd}`);

  // Examples (one Input/Output pair per .sample-test). The sub-heading sits
  // directly above its code fence, with a blank line between blocks.
  const sampleTests = root.querySelector(".sample-tests");
  if (sampleTests) {
    const blocks = [];
    sampleTests.querySelectorAll(".sample-test").forEach((test) => {
      const input = test.querySelector(".input pre");
      const output = test.querySelector(".output pre");
      if (input) blocks.push(`### Input\n\`\`\`\n${preText(input)}\n\`\`\``);
      if (output) blocks.push(`### Output\n\`\`\`\n${preText(output)}\n\`\`\``);
    });
    if (blocks.length) parts.push(`## Examples\n${blocks.join("\n\n")}`);
  }

  // Note
  const noteMd = sectionToMarkdown(root.querySelector(".note"));
  if (noteMd) parts.push(`## Note\n${noteMd}`);

  if (parts.length === 0) return convertProblemToMarkdown(root);
  return parts.join("\n\n");
};
