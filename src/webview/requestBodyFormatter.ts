import { parseDocument } from 'yaml';

export type FormattableRawBodyLanguage = 'json' | 'xml' | 'html' | 'yaml';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const COMMENT_NODE = 8;
const DOCUMENT_TYPE_NODE = 10;

const htmlVoidElements = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

type XmlNodeLike = {
  nodeType: number;
  nodeName: string;
  childNodes: ArrayLike<XmlNodeLike>;
  attributes?: ArrayLike<{ name: string; value: string }>;
  textContent: string | null;
};

type XmlDocumentLike = {
  documentElement: XmlNodeLike;
  body?: XmlNodeLike;
  querySelector?(selectors: string): XmlNodeLike | null;
};

function getIndentUnit(indentText: string): string {
  return indentText === '\t' ? '\t' : indentText || '  ';
}

function getYamlIndent(indentText: string): number {
  if (indentText === '\t') {
    return 2;
  }

  return Math.max(indentText.length, 2);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatJsonBody(content: string, indentText: string): string {
  return JSON.stringify(JSON.parse(content), null, getIndentUnit(indentText));
}

function formatYamlBody(content: string, indentText: string): string {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    throw document.errors[0];
  }

  return document.toString({ indent: getYamlIndent(indentText), lineWidth: 0 }).replace(/\n$/, '');
}

function formatNode(node: XmlNodeLike, indentText: string, depth: number, mode: 'xml' | 'html'): string {
  const indent = getIndentUnit(indentText).repeat(depth);
  const childNodes = Array.from(node.childNodes ?? []);

  switch (node.nodeType) {
    case ELEMENT_NODE: {
      const tagName = node.nodeName;
      const attributes = Array.from(node.attributes ?? [])
        .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
        .join('');
      const nonEmptyChildren = childNodes.filter((child) => child.nodeType !== TEXT_NODE || (child.textContent ?? '').trim() !== '');
      const inlineText = childNodes.length === 1 && childNodes[0].nodeType === TEXT_NODE
        ? (childNodes[0].textContent ?? '').trim()
        : '';

      if (inlineText) {
        return `${indent}<${tagName}${attributes}>${escapeText(inlineText)}</${tagName}>`;
      }

      if (nonEmptyChildren.length === 0) {
        if (mode === 'html' && htmlVoidElements.has(tagName.toLowerCase())) {
          return `${indent}<${tagName}${attributes}>`;
        }

        return mode === 'xml'
          ? `${indent}<${tagName}${attributes}/>`
          : `${indent}<${tagName}${attributes}></${tagName}>`;
      }

      const children = nonEmptyChildren
        .map((child) => formatNode(child, indentText, depth + 1, mode))
        .filter(Boolean)
        .join('\n');

      return `${indent}<${tagName}${attributes}>\n${children}\n${indent}</${tagName}>`;
    }
    case TEXT_NODE: {
      const text = (node.textContent ?? '').trim();
      return text ? `${indent}${escapeText(text)}` : '';
    }
    case COMMENT_NODE:
      return `${indent}<!--${node.textContent ?? ''}-->`;
    case CDATA_SECTION_NODE:
      return `${indent}<![CDATA[${node.textContent ?? ''}]]>`;
    case DOCUMENT_TYPE_NODE:
      return `${indent}<!DOCTYPE ${node.nodeName}>`;
    default:
      return '';
  }
}

function formatMarkupDocument(
  document: XmlDocumentLike,
  indentText: string,
  mode: 'xml' | 'html',
  preferDocumentRoot = false,
): string {
  const root = mode === 'html' && !preferDocumentRoot
    ? document.body ?? document.documentElement
    : document.documentElement;
  if (!root) {
    return '';
  }

  const nodes = mode === 'html'
    ? Array.from(root.childNodes ?? []).filter((child) => child.nodeType !== TEXT_NODE || (child.textContent ?? '').trim() !== '')
    : [root];

  return nodes
    .map((node) => formatNode(node, indentText, 0, mode))
    .filter(Boolean)
    .join('\n');
}

function formatXmlBody(content: string, indentText: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(content, 'application/xml') as XmlDocumentLike;
  const parserError = document.querySelector?.('parsererror');
  if (parserError) {
    throw new Error(parserError.textContent ?? 'Invalid XML');
  }

  const declarationMatch = content.match(/^\s*(<\?xml[^>]*\?>)/i);
  const formatted = formatMarkupDocument(document, indentText, 'xml');
  return declarationMatch ? `${declarationMatch[1]}\n${formatted}` : formatted;
}

function formatHtmlBody(content: string, indentText: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(content, 'text/html') as XmlDocumentLike;
  const hasDocumentShell = /<\s*!doctype|<\s*html\b/i.test(content);
  const formatted = formatMarkupDocument(document, indentText, 'html', hasDocumentShell);
  const docTypeMatch = hasDocumentShell ? content.match(/<\s*!doctype[^>]*>/i) : null;
  return docTypeMatch ? `${docTypeMatch[0]}\n${formatted}` : formatted;
}

export function canFormatRawBody(language: string): language is FormattableRawBodyLanguage {
  return language === 'json' || language === 'xml' || language === 'html' || language === 'yaml';
}

export function formatRawBody(content: string, language: string, indentText: string): string {
  if (!canFormatRawBody(language)) {
    return content;
  }

  switch (language) {
    case 'json':
      return formatJsonBody(content, indentText);
    case 'yaml':
      return formatYamlBody(content, indentText);
    case 'xml':
      return formatXmlBody(content, indentText);
    case 'html':
      return formatHtmlBody(content, indentText);
  }
}