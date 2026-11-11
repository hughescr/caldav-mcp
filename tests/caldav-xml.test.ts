import { describe, expect, test } from 'bun:test';
import { CalDavError } from '../src/caldav/contracts';
import { CALDAV_NS, DAV_NS, findOkProp, parseMultistatus, parseXml } from '../src/caldav/xml';
import { fixture } from './fixtures/caldav/fake-fetch';

function protocolError(fn: () => unknown): boolean {
    try {
        fn();
        return false;
    } catch (error) {
        return error instanceof CalDavError && error.code === 'protocol';
    }
}

describe('parseXml resolves namespaces by URI', () => {
    test('default namespace and prefixed forms give the same element names', () => {
        const a = parseXml('<multistatus xmlns="DAV:"><response/></multistatus>');
        const b = parseXml('<zz:multistatus xmlns:zz="DAV:"><zz:response/></zz:multistatus>');
        for (const root of [a, b]) {
            expect(root.ns).toBe(DAV_NS);
            expect(root.local).toBe('multistatus');
            expect(root.children[0]?.ns).toBe(DAV_NS);
            expect(root.children[0]?.local).toBe('response');
        }
    });

    test('the conventional prefix bound to another URI is not DAV:', () => {
        const root = parseXml('<D:multistatus xmlns:D="urn:ietf:params:xml:ns:caldav"/>');
        expect(root.ns).toBe(CALDAV_NS);
    });

    test('an unprefixed element with no default namespace has the empty namespace', () => {
        expect(parseXml('<multistatus/>').ns).toBe('');
    });

    test('nested declarations shadow outer ones and xmlns="" resets the default', () => {
        const root = parseXml('<a xmlns="urn:one" xmlns:p="urn:two"><p:b xmlns:p="urn:three"><c xmlns=""/></p:b><p:d/></a>');
        expect(root.ns).toBe('urn:one');
        expect(root.children[0]?.ns).toBe('urn:three');
        expect(root.children[0]?.children[0]?.ns).toBe('');
        expect(root.children[1]?.ns).toBe('urn:two');
    });

    test('the xml prefix is predeclared', () => {
        const root = parseXml('<a xml:lang="en"/>');
        expect(root.attributes.get('{http://www.w3.org/XML/1998/namespace}lang')).toBe('en');
    });

    test('unprefixed attributes have no namespace; prefixed ones are qualified; xmlns is not an attribute', () => {
        const root = parseXml('<c:comp xmlns:c="urn:c" name="VEVENT" c:name="other"/>');
        expect(root.attributes.get('name')).toBe('VEVENT');
        expect(root.attributes.get('{urn:c}name')).toBe('other');
        expect(root.attributes.has('xmlns:c')).toBe(false);
    });

    test('an undeclared element prefix => protocol', () => {
        expect(protocolError(() => parseXml('<D:multistatus/>'))).toBe(true);
    });

    test('an undeclared attribute prefix => protocol', () => {
        expect(protocolError(() => parseXml('<a q:x="1"/>'))).toBe(true);
    });

    test('undeclaring a prefix (xmlns:p="") => protocol', () => {
        expect(protocolError(() => parseXml('<a xmlns:p=""/>'))).toBe(true);
    });
});

describe('parseXml text handling', () => {
    test('decodes the five predefined entities and numeric references', () => {
        const root = parseXml('<a>&lt;&gt;&amp;&apos;&quot;&#65;&#x42;&#x1F4C5;</a>');
        expect(root.text).toBe('<>&\'"AB\u{1F4C5}');
    });

    test('CDATA is kept verbatim and not entity-decoded', () => {
        const root = parseXml('<a><![CDATA[<b>&amp;</b>]]></a>');
        expect(root.text).toBe('<b>&amp;</b>');
        expect(root.children).toHaveLength(0);
    });

    test('text and CDATA concatenate in document order', () => {
        expect(parseXml('<a>x<![CDATA[y]]>z</a>').text).toBe('xyz');
    });

    test('decodes entities in attribute values', () => {
        expect(parseXml('<a n="&lt;V&#69;VENT&gt;"/>').attributes.get('n')).toBe('<VEVENT>');
    });

    test('an undefined entity => protocol', () => {
        expect(protocolError(() => parseXml('<a>&foo;</a>'))).toBe(true);
        expect(protocolError(() => parseXml('<a n="&foo;"/>'))).toBe(true);
    });

    test('an invalid character reference => protocol', () => {
        for (const ref of ['&#0;', '&#xD800;', '&#x110000;', '&#;', '&#x;', '&#12a;']) {
            expect(protocolError(() => parseXml(`<a>${ref}</a>`))).toBe(true);
        }
    });

    test('a bare ampersand => protocol', () => {
        expect(protocolError(() => parseXml('<a>a & b</a>'))).toBe(true);
    });

    test('comments and processing instructions are ignored', () => {
        const root = parseXml('<?xml version="1.0"?><!-- c --><a><!-- inner -->t<?pi x?></a>');
        expect(root.text).toBe('t');
    });
});

describe('parseXml refuses dangerous or malformed input', () => {
    test('a DOCTYPE is refused (no entity expansion)', () => {
        const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><a>&lol2;</a>';
        expect(protocolError(() => parseXml(laughs))).toBe(true);
    });

    test('an external entity declaration is refused', () => {
        const xxe = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>';
        expect(protocolError(() => parseXml(xxe))).toBe(true);
    });

    test('a DOCTYPE in any letter case or after whitespace is refused', () => {
        expect(protocolError(() => parseXml('\n<!doctype a><a/>'))).toBe(true);
        expect(protocolError(() => parseXml('<a><!ENTITY x "y"></a>'))).toBe(true);
    });

    const malformed: [string, string][] = [
        ['empty', ''],
        ['whitespace', '   '],
        ['plain text', 'Service Unavailable'],
        ['HTML page', '<html><body><p>Captive portal<br></body></html>'],
        ['mismatched tags', '<a><b></a>'],
        ['unclosed root', '<a>'],
        ['two roots', '<a/><b/>'],
        ['text after root', '<a/>junk'],
        ['text before root', 'junk<a/>'],
        ['text after a trailing comment', '<a/><!-- c -->junk'],
        ['top-level CDATA', '<![CDATA[x]]><a/>'],
        ['control character', '<a>\u0001</a>'],
        ['lone surrogate', '<a>\uD800</a>'],
        ['multiple colons in a name', '<a:b:c xmlns:a="urn:a"/>'],
        ['boolean attribute', '<a b/>'],
        ['duplicate attribute', '<a x="1" x="2"/>'],
        ['JSON', '{"multistatus":[]}'],
    ];
    for (const [label, xml] of malformed) {
        test(`${label} => protocol`, () => {
            expect(protocolError(() => parseXml(xml))).toBe(true);
        });
    }

    test('excessive nesting => protocol', () => {
        const deep = `${'<a>'.repeat(500)}${'</a>'.repeat(500)}`;
        expect(protocolError(() => parseXml(deep))).toBe(true);
    });

    test('a 1 MiB document of many namespace declarations over many children is refused quickly', () => {
        const MiB = 1024 * 1024;
        const declarations = Array.from({ length: 20000 }, (_, index) => ` xmlns:p${index}="u"`).join('');
        const children = '<href/>'.repeat(Math.floor((MiB - declarations.length - 100) / 7));
        const started = performance.now();
        expect(protocolError(() => parseMultistatus(`<multistatus xmlns="DAV:"${declarations}>${children}</multistatus>`))).toBe(true);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test('a 1 MiB listing in the iCloud fixture style stays inside every bound', () => {
        const source = fixture('calendars-default-ns.xml');
        const responses = source.slice(source.indexOf('<response>'), source.lastIndexOf('</multistatus>'));
        const repeats = Math.floor((1024 * 1024 - 200) / responses.length);
        const parsed = parseMultistatus(`<multistatus xmlns="DAV:">${responses.repeat(repeats)}</multistatus>`);
        expect(parsed).toHaveLength(repeats * parseMultistatus(source).length);
    });

    test('more than 50000 elements => protocol; 50000 parse', () => {
        expect(parseXml(`<multistatus xmlns="DAV:">${'<href/>'.repeat(49999)}</multistatus>`).children).toHaveLength(49999);
        expect(protocolError(() => parseXml(`<multistatus xmlns="DAV:">${'<href/>'.repeat(50000)}</multistatus>`))).toBe(true);
    });

    test('more than 64 namespace bindings in scope => protocol', () => {
        const declarations = (count: number) => Array.from({ length: count }, (_, index) => ` xmlns:p${index}="urn:${index}"`).join('');
        // The predeclared xml prefix is one of the bindings in scope.
        expect(parseXml(`<a${declarations(63)}/>`).local).toBe('a');
        expect(protocolError(() => parseXml(`<a${declarations(64)}/>`))).toBe(true);
        expect(protocolError(() => parseXml(`<a${declarations(40)}><b${declarations(30).replaceAll('xmlns:p', 'xmlns:q')}/></a>`))).toBe(true);
    });

    test('more than 20000 namespace declarations in one document => protocol', () => {
        const ok = '<x xmlns="DAV:"/>'.repeat(19999);
        expect(parseXml(`<multistatus xmlns="DAV:">${ok}</multistatus>`).children).toHaveLength(19999);
        expect(protocolError(() => parseXml(`<multistatus xmlns="DAV:">${ok}<x xmlns="DAV:"/></multistatus>`))).toBe(true);
    });

    test('a child declaration does not leak into its siblings or parent', () => {
        const root = parseXml('<a xmlns="urn:one"><b xmlns="urn:two"/><c/></a>');
        expect(root.children.map(child => child.ns)).toEqual(['urn:two', 'urn:one']);
        expect(protocolError(() => parseXml('<a><b xmlns:p="urn:two"/><p:c/></a>'))).toBe(true);
    });

    test('the thrown error carries no input text', () => {
        let caught: unknown;
        try {
            parseXml('<secret-token-value>');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CalDavError);
        expect(String(caught)).not.toContain('secret-token-value');
        expect((caught as Error).cause).toBeUndefined();
    });
});

describe('parseMultistatus', () => {
    test('reads responses, hrefs and propstats', () => {
        const [response, ...rest] = parseMultistatus(fixture('principal-default-ns.xml'));
        expect(rest).toHaveLength(0);
        expect(response?.href).toBe('/');
        expect(response?.status).toBeNull();
        expect(response?.propstats).toHaveLength(1);
        expect(response?.propstats[0]?.status).toBe(200);
        const principal = response ? findOkProp(response, DAV_NS, 'current-user-principal') : undefined;
        expect(principal?.children[0]?.text.trim()).toBe('/10000000001/principal/');
    });

    test('findOkProp ignores properties reported in a non-2xx propstat', () => {
        const [response] = parseMultistatus(fixture('home-set-prefixed.xml'));
        expect(response).toBeDefined();
        if (!response) {
            return;
        }
        expect(findOkProp(response, CALDAV_NS, 'calendar-home-set')).toBeDefined();
        expect(findOkProp(response, CALDAV_NS, 'calendar-user-address-set')).toBeUndefined();
    });

    test('findOkProp matches by namespace URI, not local name alone', () => {
        const [response] = parseMultistatus(fixture('home-set-default-ns.xml'));
        expect(response).toBeDefined();
        if (!response) {
            return;
        }
        expect(findOkProp(response, DAV_NS, 'calendar-home-set')).toBeUndefined();
        expect(findOkProp(response, CALDAV_NS, 'calendar-home-set')).toBeDefined();
    });

    test('parses status lines of several forms', () => {
        const xml = (status: string) =>
            `<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop/><status>${status}</status></propstat></response></multistatus>`;
        expect(parseMultistatus(xml('HTTP/1.1 200 OK'))[0]?.propstats[0]?.status).toBe(200);
        expect(parseMultistatus(xml(' HTTP/1.0 404 Not Found '))[0]?.propstats[0]?.status).toBe(404);
        expect(parseMultistatus(xml('HTTP/2 403'))[0]?.propstats[0]?.status).toBe(403);
        for (const bad of ['200 OK', 'HTTP/1.1 OK', 'HTTP/1.1 2000 OK', '', 'garbage']) {
            expect(protocolError(() => parseMultistatus(xml(bad)))).toBe(true);
        }
    });

    test('a response-level status is read', () => {
        const xml = '<multistatus xmlns="DAV:"><response><href>/gone/</href><status>HTTP/1.1 404 Not Found</status></response></multistatus>';
        const [response] = parseMultistatus(xml);
        expect(response?.status).toBe(404);
        expect(response?.propstats).toHaveLength(0);
    });

    test('an empty multistatus is an empty list', () => {
        expect(parseMultistatus('<multistatus xmlns="DAV:"/>')).toEqual([]);
    });

    const invalid: [string, string][] = [
        ['root not in DAV:', '<multistatus><response/></multistatus>'],
        ['root in the CalDAV namespace', '<D:multistatus xmlns:D="urn:ietf:params:xml:ns:caldav"/>'],
        ['wrong root', '<error xmlns="DAV:"/>'],
        ['response without href', '<multistatus xmlns="DAV:"><response><propstat><prop/><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'],
        ['response with empty href', '<multistatus xmlns="DAV:"><response><href> </href><status>HTTP/1.1 200 OK</status></response></multistatus>'],
        ['response with two hrefs', '<multistatus xmlns="DAV:"><response><href>/a</href><href>/b</href><status>HTTP/1.1 200 OK</status></response></multistatus>'],
        ['response with neither status nor propstat', '<multistatus xmlns="DAV:"><response><href>/a</href></response></multistatus>'],
        ['propstat without status', '<multistatus xmlns="DAV:"><response><href>/a</href><propstat><prop/></propstat></response></multistatus>'],
        ['propstat without prop', '<multistatus xmlns="DAV:"><response><href>/a</href><propstat><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'],
        ['href with child elements', '<multistatus xmlns="DAV:"><response><href><b>/a</b></href><status>HTTP/1.1 200 OK</status></response></multistatus>'],
    ];
    for (const [label, xml] of invalid) {
        test(`${label} => protocol`, () => {
            expect(protocolError(() => parseMultistatus(xml))).toBe(true);
        });
    }
});
