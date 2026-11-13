import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handle } from "../src/mock";
import { parseXml, serialize, child } from "../src/xml";

const source = await Bun.file(new URL("../fixtures/request.xml", import.meta.url)).text();
const action = "http://mhp-net.de/services/workflowexecutor/Executor/Execute";
const headers = { "content-type": "text/xml; charset=utf-8", soapaction: action };
const log = spyOn(console, 'log').mockImplementation(() => {});
beforeEach(() => log.mockClear());
afterAll(() => log.mockRestore());
async function send(xml = source, h: Record<string, string> = headers) {
  return handle(new Request("http://localhost/WorkflowInterface", { method: "POST", headers: h, body: new TextEncoder().encode(xml) }));
}
async function result(xml = source) {
  const response = await send(xml);
  expect(response.status).toBe(200);
  const root = parseXml(await response.text());
  const body = child(root, "Body", "http://schemas.xmlsoap.org/soap/envelope/");
  const work = body.children[0].children[0].children[0].text;
  return { tree: parseXml(work), xml: work };
}

describe("VLOG print contract", () => {
  test("CLI logs the request and a short success result", async () => {
    const response = await send();
    expect(log.mock.calls[0]?.[0]).toContain(source);
    expect(log.mock.calls.at(-1)).toEqual(['Call Successful']);
    expect(log.mock.calls.flat().join('\n')).not.toContain('<ExecuteResponse');
    expect(await response.text()).toContain('<ExecuteResponse');
  });
  for (const [name, xml, h, message] of [
    ['business error', source.replace('>STD<', '>INVALID<'), headers, 'Produktkombination nicht möglich'],
    ['invalid command', source.replace('>Label:Print<', '>Invalid<'), headers, 'Invalid is no valid command'],
    ['carrier error', source.replace('>DHL<', '>INVALID<'), headers, 'Modulausführung fehlgeschlagen'],
    ['SOAP fault', source, {...headers, soapaction: 'urn:wrong'}, 'ActionNotSupported'],
    ['HTTP error', source, {...headers, 'content-type': 'application/xml'}, 'Unsupported Media Type'],
  ] as const) test(`CLI reports the concrete ${name}`, async () => {
    await send(xml, h);
    expect(log.mock.calls[0]?.[0]).toContain(xml);
    const output=String(log.mock.calls.at(-1)?.[0]);
    expect(output).toContain('Call Failed:');
    expect(output).toContain(message);
    expect(output).not.toContain('<ExecuteResponse');
    expect(log.mock.calls.flat()).not.toContain('Call Successful');
  });
  test("pretty-prints SOAP and embedded workitem XML", async () => {
    const response = await send();
    const soap = await response.text();
    expect(soap).toContain('\n  <s:Body>\n    <ExecuteResponse');
    const body = child(parseXml(soap), 'Body', 'http://schemas.xmlsoap.org/soap/envelope/');
    const work = body.children[0].children[0].children[0].text;
    expect(work).toContain('<workitem>\n  <shipment collection="true">\n    <collection_index>1</collection_index>');
    expect(child(child(parseXml(work), 'shipment'), 'shipment_status').text).toBe('800');
  });
  test("pretty-prints SOAP faults", async () => {
    const response = await send(source, {...headers, soapaction: 'urn:wrong'});
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('\n    <s:Fault>\n      <faultcode');
  });
  test("XML formatting preserves text whitespace and escaping", () => {
    const xml = serialize(parseXml('<root>\n\n <value>  A &amp; B  </value>\n</root>'));
    expect(xml).toBe('<root>\n  <value>  A &amp; B  </value>\n</root>');
    expect(child(parseXml(xml), 'value').text).toBe('  A & B  ');
  });
  test("delays successful print responses by two seconds", async () => {
    const start = performance.now();
    expect((await send()).status).toBe(200);
    expect(performance.now() - start).toBeGreaterThanOrEqual(1990);
  });
  for (const [name, xml, h, status] of [
    ['business error', source.replace('>STD<', '>INVALID<'), headers, 200],
    ['SOAP fault', source, {...headers, soapaction: 'urn:wrong'}, 500],
    ['HTTP error', source, {...headers, 'content-type': 'application/xml'}, 415],
  ] as const) test(`delays ${name} responses by only half a second`, async () => {
    const start = performance.now();
    expect((await send(xml, h)).status).toBe(status);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThan(1800);
  });
  test("success is nested XML, echoes references and varies IDs", async () => {
    const a = await result(); const b = await result();
    expect(a.xml).toContain("<shipment_status>800</shipment_status>");
    expect(a.xml).toContain("<send_referenznr_01>TEST-ORDER-0001</send_referenznr_01>");
    expect(a.xml).not.toBe(b.xml);
    expect(a.xml).toContain("MOCK-");
    expect(a.xml).not.toContain("password");
    expect(a.xml).not.toContain("automaticupload_server");
  });
  test("PRIO succeeds", async () => { expect((await result(source.replace('>STD<', '>PRIO<'))).xml).toContain('<shipment_status>800</shipment_status>'); });
  test("Label:Retry succeeds and is echoed in the response", async () => {
    const {xml} = await result(source.replace('>Label:Print<', '>Label:Retry<'));
    expect(xml).toContain('<shipment_status>800</shipment_status>');
    expect(xml).toContain('<command>Label:Retry</command>');
  });
  test("Label:Retry is preserved in business error responses", async () => {
    const {xml} = await result(source.replace('>Label:Print<', '>Label:Retry<').replace('>STD<', '>INVALID<'));
    expect(xml).toContain('<shipment_status>900</shipment_status>');
    expect(xml).toContain('<command>Label:Retry</command>');
  });
  test("additional shipment fields are accepted and echoed", async () => {
    const {xml}=await result(source.replace('</Frachtfuehrer>', '</Frachtfuehrer><Empf_Fax>01234</Empf_Fax><Send_NachnahmeBetrag>25,50</Send_NachnahmeBetrag>'));
    expect(xml).toContain('<empf_fax>01234</empf_fax>');
    expect(xml).toContain('<send_nachnahmebetrag>25,50</send_nachnahmebetrag>');
    expect(xml).toContain('<shipment_status>800</shipment_status>');
  });
  test("success retains observed carrier/product mappings", async () => {
    const {xml}=await result();
    expect(xml).toContain('<frachtfuehrer>DPA</frachtfuehrer>');
    expect(xml).toContain('<send_2n_prodcode>18</send_2n_prodcode>');
    expect(xml).toContain('<unmapped_frachtfuehrer>DHL</unmapped_frachtfuehrer>');
  });
  test("additional fields retain inherited namespace declarations for attributes", async () => {
    const {xml}=await result(source.replace('<workitem>', '<workitem xmlns:p="urn:extra">').replace('</Frachtfuehrer>', '</Frachtfuehrer><Empf_Fax p:note="x">123</Empf_Fax>'));
    expect(xml).toContain('p:note="x"');
    expect(xml).toContain('xmlns:p="urn:extra"');
    expect(()=>parseXml(xml)).not.toThrow();
  });
  test("caller UUID references remain unchanged", async () => {
    const ref='12345678-1234-4234-8234-123456789012';
    expect((await result(source.replaceAll('TEST-ORDER-0001',ref))).xml).toContain(`<send_referenznr_01>${ref}</send_referenznr_01>`);
  });
  test("accepts aliases and default workflow namespace", async () => {
    expect((await send(source.replaceAll('soapenv', 's').replaceAll('wor:', 'x:').replace('xmlns:wor=', 'xmlns:x='))).status).toBe(200);
    expect((await send(source.replaceAll('wor:', '').replace('xmlns:wor=', 'xmlns='))).status).toBe(200);
  });
  test("missing content-type and quoted SOAPAction work", async () => {
    expect((await send(source, {soapaction: action})).status).toBe(200);
    expect((await send(source, {...headers, soapaction: `"${action}"`})).status).toBe(200);
  });
  for (const ct of ['application/xml', 'text/xml; charset=iso-8859-1', 'text/xml; charset=utf-8; charset=ascii']) {
    test(`rejects content-type ${ct}`, async () => { const r=await send(source,{...headers,'content-type':ct}); expect(r.status).toBe(415); expect(await r.text()).toBe(''); });
  }
  for (const [name, old, value] of [
    ['command', '>Label:Print<', '>701<'], ['mandant','>701<','>999<'],
    ['workplace','>MOCK-PC01<','> <'], ['carrier','>DHL<','>INVALID<'],
    ['product','>STD<','>INVALID<'], ['weight dot','>2,32<','>2.32<'],
    ['weight text','>2,32<','>abc<'], ['weight zero','>2,32<','>0,00<'],
  ]) test(`rejects invalid ${name} with a workitem error`, async () => {
    const {xml}=await result(source.replace(old,value));
    expect(xml).not.toContain('<shipment_status>800</shipment_status>');
    expect(xml).toMatch(/<mhp>|<shipment_fehlertext>/);
    expect(xml).not.toContain('<send_id>');
  });
  for (const [name, xml] of [
    ['outer XML',source.replace('</soapenv:Body>','</soapenv:Wrong>')],
    ['inner XML',source.replace('</Send_Mandant>','</Wrong>')],
    ['namespace',source.replace('xmlns:wor="http://mhp-net.de/services/workflowexecutor"','xmlns:wor="urn:wrong"')],
    ['unbound prefix',source.replace('xmlns:wor=', 'xmlns:other=')],
    ['duplicate field',source.replace('<Send_Mandant>701</Send_Mandant>','<Send_Mandant>701</Send_Mandant><Send_Mandant>701</Send_Mandant>')],
    ['case-colliding field',source.replace('</Send_Mandant>','</Send_Mandant><send_mandant>999</send_mandant>')],
    ['body text',source.replace('<soapenv:Body>','<soapenv:Body>unexpected')],
    ['extra envelope child',source.replace('<soapenv:Header/>','<soapenv:Header/><bogus/>')],
    ['wrong inner namespace',source.replace('<Send_Mandant>','<Send_Mandant xmlns="urn:wrong">')],
    ['extra document',source+'<extra/>'],
    ['DTD', '<!DOCTYPE x [<!ENTITY test "x">]>'+source],
    ['inner DTD',source.replace('<workitem>','<!DOCTYPE workitem><workitem>')],
    ['declaration', '<?xml version="1.0" encoding="iso-8859-1"?>'+source],
  ]) test(`rejects ${name} with SOAP fault`, async () => { const r=await send(xml); expect(r.status).toBe(500); expect(await r.text()).toContain(':Fault>'); });
  test("rejects wrong or absent action", async () => {
    expect((await send(source,{...headers,soapaction:'urn:wrong'})).status).toBe(500);
    expect((await send(source,{'content-type':'text/xml'})).status).toBe(500);
  });
  test("rejects invalid UTF-8 bytes", async () => {
    const r=await handle(new Request('http://localhost/WorkflowInterface',{method:'POST',headers,body:new Uint8Array([0xc3,0x28])}));
    expect(r.status).toBe(500);
  });
  test("wrong method/path do not print",async()=>{
    expect((await handle(new Request('http://localhost/WorkflowInterface'))).status).toBe(405);
    expect((await handle(new Request('http://localhost/other',{method:'POST'}))).status).toBe(404);
  });
  test("XML parser rejects duplicate attributes and undeclared entities", () => {
    expect(()=>parseXml('<x a="1" a="2"/>')).toThrow();
    expect(()=>parseXml('<x>&unknown;</x>')).toThrow();
    expect(serialize(parseXml('<x a="&amp;">&lt;</x>'))).toBe('<x a="&amp;">&lt;</x>');
  });
});
