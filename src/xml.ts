import { SaxesParser } from "saxes";

export interface XmlNode {
  name: string;
  local: string;
  uri: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
}
export const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function parseXml(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  parser.on('doctype', () => { throw new Error('DTDs sind im Mock nicht zulässig.'); });
  parser.on('xmldecl', declaration => {
    if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') throw new Error('XML muss UTF-8 verwenden.');
  });
  parser.on('opentag', tag => {
    if (stack.length >= 64) throw new Error('XML ist zu tief verschachtelt.');
    const node: XmlNode = { name: tag.name, local: tag.local, uri: tag.uri, attributes: Object.fromEntries(Object.values(tag.attributes).map(a => [a.name, a.value])), text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else root = node;
    stack.push(node);
  });
  const text = (value: string) => { if (stack.length) stack.at(-1)!.text += value; };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (!root) throw new Error('XML-Wurzel fehlt.');
  return root;
}
export function child(node: XmlNode, name: string, uri = ''): XmlNode {
  const matches = node.children.filter(c => c.local === name && c.uri === uri);
  if (matches.length !== 1) throw new Error(`Genau ein ${name}-Element im Namespace '${uri}' erforderlich.`);
  return matches[0];
}
export function serialize(node: XmlNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const attrs = Object.entries(node.attributes).map(([k,v]) => ` ${k}="${escapeXml(v)}"`).join('');
  const content = node.children.length && !node.text.trim()
    ? `\n${node.children.map(c => serialize(c, depth + 1)).join('\n')}\n${indent}`
    : `${escapeXml(node.text)}${node.children.map(c => serialize(c)).join('')}`;
  return `${indent}<${node.name}${attrs}>${content}</${node.name}>`;
}
