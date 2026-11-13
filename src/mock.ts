import { child, escapeXml, parseXml, serialize, type XmlNode } from './xml';
import faults from '../fixtures/faults.json';

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const WORKFLOW = 'http://mhp-net.de/services/workflowexecutor';
const ARRAYS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';
const ACTION = `${WORKFLOW}/Executor/Execute`;
const templates = Object.fromEntries(await Promise.all(['success', 'command-701', 'mandant', 'carrier', 'product', 'weight-text'].map(async name => [name, await Bun.file(new URL(`../fixtures/${name}.xml`, import.meta.url)).text()])));
const envelope = (content: string) => `<s:Envelope xmlns:s="${SOAP}"><s:Body>${content}</s:Body></s:Envelope>`;
async function delayedResponse(body: BodyInit | null, init: ResponseInit, success = false, error?: string) {
  await Bun.sleep(success ? 2000 : 500);
  console.log(success ? 'Call Successful' : `Call Failed: ${(error ?? `HTTP ${init.status}`).replace(/\s+/g, ' ')}`);
  return new Response(body, init);
}
const xmlResponse = (xml: string, status = 200, success = false, error?: string) => delayedResponse(serialize(parseXml(xml)) + '\n', { status, headers: { 'content-type': 'text/xml; charset=utf-8' } }, success, error);
function fault(kind: keyof typeof faults, message?: string) {
  const f = faults[kind];
  return xmlResponse(envelope(`<s:Fault><faultcode xmlns:a="http://schemas.microsoft.com/net/2005/12/windowscommunicationfoundation/dispatcher">${f.code}</faultcode><faultstring xml:lang="de-DE">${escapeXml(message ?? f.message)}</faultstring></s:Fault>`), 500, false, `${f.code}: ${message ?? f.message}`);
}
function field(node: XmlNode, name: string) {
  const value = child(node, name);
  if (value.children.length) throw new Error(`${name} muss ein Textfeld sein.`);
  return value.text;
}
function set(node: XmlNode, name: string, value: string) {
  let target = node.children.find(c => c.local === name);
  if (!target) {
    target = { name, local: name, uri: '', attributes: {}, text: '', children: [] };
    node.children.push(target);
  }
  target.text = value;
  target.children = [];
}
function visit(node: XmlNode, fn: (node: XmlNode) => void) { fn(node); node.children.forEach(n => visit(n, fn)); }
function merge(target: XmlNode, input: XmlNode) {
  Object.assign(target.attributes, input.attributes);
  for (const item of input.children) {
    const name = item.local.toLowerCase();
    let dest = target.children.find(n => n.local === name);
    if (!dest) {
      dest = { name, local: name, uri: '', attributes: {...item.attributes}, text: '', children: [] };
      target.children.push(dest);
    }
    if (item.children.length) merge(dest, item);
    else if (!['frachtfuehrer', 'send_2n_prodcode'].includes(name)) { dest.text = item.text; dest.children = []; }
  }
}
function workitemResponse(template: string, input: XmlNode, command: string, error?: string) {
  const work = parseXml(templates[template]);
  // Invalid commands have the observed minimal <workitem><mhp><error> response.
  if (template !== 'command-701') merge(work, input);
  const ids = new Map<string, string>();
  const now = new Date().toISOString();
  const tracking = `MOCK-${crypto.randomUUID()}`;
  visit(work, node => {
    if (node.children.length) return;
    if (['processid', 'shipment_id', 'package_id'].includes(node.local)) {
      // Separate identity fields get separate values; shared shipment IDs remain shared.
      const key = node.local;
      if (!ids.has(key)) ids.set(key, crypto.randomUUID());
      node.text = node.local === 'processid' ? crypto.randomUUID() : ids.get(key)!;
    }
    if (node.local.startsWith('time_') || node.local === 'send_versanddatum') node.text = now;
    if (node.local === 'currentdate') node.text = now.slice(0, 10);
    if (['send_id', 'dpa_send_id_text', 'dpa_send_id_list', 'dpa_typepostinglistbarcode'].includes(node.local)) node.text = tracking;
    if (['versanddaten_id', 'send_kolli_id', 'send_shipmentreference'].includes(node.local)) node.text = tracking;
  });
  if (template !== 'command-701') {
    const shipment = child(work, 'shipment');
    const pack = child(shipment, 'package');
    set(work, 'command', command);
    const failed = template !== 'success' || !!error;
    if (template !== 'carrier') {
      set(shipment, 'shipment_status', failed ? '900' : '800');
      set(pack, 'package_status', failed ? '999' : '899');
    }
    if (error) {
      set(shipment, 'shipment_fehlertext', error);
      set(pack, 'package_fehlertext', error);
    }
    if (failed) {
      error ||= template === 'carrier'
        ? child(child(child(work, 'mhp'), 'error'), 'message').text
        : child(shipment, 'shipment_fehlertext').text;
      visit(work, n => { n.children = n.children.filter(c => !['send_id','dpa_send_id_text','dpa_send_id_list','dpa_typepostinglistbarcode'].includes(c.local)); });
    }
    if (!failed) {
      set(pack, 'send_gewichteinzel', field(child(child(input, 'shipment'), 'package'), 'Send_GewichtEinzel').replace(',', '.'));
      set(shipment, 'send_gewichtgesamt', child(pack, 'send_gewichteinzel').text);
      set(pack, 'unmapped_send_2n_prodcode', field(child(child(input, 'shipment'), 'package'), 'Send_2N_ProdCode'));
      set(pack, 'tmp_send_2n_prodcode', child(pack, 'unmapped_send_2n_prodcode').text);
    }
  }
  return xmlResponse(envelope(`<ExecuteResponse xmlns="${WORKFLOW}"><ExecuteResult xmlns:a="${ARRAYS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:string>${escapeXml(serialize(work))}</a:string></ExecuteResult></ExecuteResponse>`), 200, template === 'success' && !error, error);
}

export async function handle(request: Request): Promise<Response> {
  const body = await request.clone().text().catch(() => '[Request body unavailable]');
  console.log(`Request: ${request.method} ${new URL(request.url).pathname}\nContent-Type: ${request.headers.get('content-type') ?? '(not set)'}\nSOAPAction: ${request.headers.get('soapaction') ?? '(not set)'}\n\n${body}`);
  if (new URL(request.url).pathname !== '/WorkflowInterface') return delayedResponse('Not found', {status: 404}, false, 'Not found');
  if (request.method !== 'POST') return delayedResponse('Method not allowed', {status: 405, headers: {allow: 'POST'}}, false, 'Method not allowed');
  const ct = request.headers.get('content-type');
  if (ct !== null && !/^text\/xml(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(ct.trim())) return delayedResponse(null, {status: 415}, false, 'Unsupported Media Type');
  const action = request.headers.get('soapaction')?.trim();
  if (action !== ACTION && action !== `"${ACTION}"`) return fault('soapaction');
  let execute: XmlNode;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) return delayedResponse(null, {status: 413}, false, 'Payload Too Large');
    const xml = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const root = parseXml(xml);
    if (root.local !== 'Envelope' || root.uri !== SOAP) return fault('namespace');
    if (root.text.trim() || root.children.some(n => n.uri !== SOAP || !['Header', 'Body'].includes(n.local)) || root.children.filter(n => n.local === 'Header').length > 1) return fault('namespace');
    const body = child(root, 'Body', SOAP);
    execute = child(body, 'Execute', WORKFLOW);
    if (body.text.trim() || body.children.length !== 1 || execute.children.length !== 2 || execute.text.trim()) return fault('namespace');
  } catch (e) {
    return fault('outer-xml', e instanceof Error ? e.message : 'Ungültige SOAP-Nachricht.');
  }
  try {
    const commandNode = child(execute, 'command', WORKFLOW);
    const serialized = child(execute, 'serializedWorkItem', WORKFLOW);
    if (commandNode.children.length || serialized.children.length) return fault('namespace');
    const input = parseXml(serialized.text);
    if (input.local !== 'workitem' || input.uri !== '') return fault('inner-xml');
    visit(input, n => {
      if (n.uri) throw new Error('Workitem-Felder müssen ohne Namespace sein.');
      const names = n.children.map(c => c.local.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error('Doppelte Workitem-Felder sind nicht eindeutig.');
    });
    const shipment = child(input, 'shipment');
    const pack = child(shipment, 'package');
    const mandant = field(shipment, 'Send_Mandant');
    const workplace = field(shipment, 'Int_Arbeitsplatz');
    const carrier = field(shipment, 'Frachtfuehrer');
    const product = field(pack, 'Send_2N_ProdCode');
    const weight = field(pack, 'Send_GewichtEinzel');
    const command = commandNode.text;
    if (!['Label:Print', 'Label:Retry'].includes(command)) {
      const response = parseXml(templates['command-701']);
      child(child(child(response, 'mhp'), 'error'), 'message').text = `${commandNode.text} is no valid command. Please use the format attribute:value (i.e.: F-COST:default).`;
      return xmlResponse(envelope(`<ExecuteResponse xmlns="${WORKFLOW}"><ExecuteResult xmlns:a="${ARRAYS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:string>${escapeXml(serialize(response))}</a:string></ExecuteResult></ExecuteResponse>`), 200, false, child(child(child(response, 'mhp'), 'error'), 'message').text);
    }
    if (mandant !== '701') return workitemResponse('mandant', input, command);
    if (!workplace.trim()) return workitemResponse('weight-text', input, command, 'MOCK: Int_Arbeitsplatz darf nicht leer sein.');
    if (carrier !== 'DHL') return workitemResponse('carrier', input, command);
    if (!['PRIO','STD'].includes(product)) return workitemResponse('product', input, command);
    if (!/^\d+,\d+$/.test(weight)) return workitemResponse('weight-text', input, command, 'MOCK: Send_GewichtEinzel muss eine Zahl mit Komma als Dezimaltrennzeichen sein.');
    const kg = Number(weight.replace(',', '.'));
    if (kg < 0.01 || kg > 31.5) return workitemResponse('weight-text', input, command);
    return workitemResponse('success', input, command);
  } catch (e) {
    return fault('inner-xml', e instanceof Error ? e.message : 'Workitem konnte nicht gelesen werden.');
  }
}
