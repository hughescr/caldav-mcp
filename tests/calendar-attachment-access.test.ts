import { describe, expect, test } from 'bun:test';
import { checkManagedAttachmentUrl } from '../src/caldav/managed-attachment-policy';
import { classifyAttachment, downloadSupported } from '../src/calendar/attachment-access';
import type { AttachmentDescriptor } from '../src/calendar/model';

const calendarHomeUrl = 'https://p01-caldav.icloud.com/10000000001/calendars/';

function descriptor(overrides: Partial<AttachmentDescriptor>): AttachmentDescriptor {
    return {
        form: 'external_url', component: 'master', componentRecurrenceId: null, managedId: null, uri: null, inlineBase64: null,
        filename: null, contentType: null, declaredSize: null, fingerprint: '0'.repeat(64), ordinal: 0, structurallySupported: true, ...overrides,
    };
}

const external = (uri: string): AttachmentDescriptor => descriptor({ form: 'external_url', uri });

describe('external links with userinfo', () => {
    test('a plain external link is returned as is', () => {
        expect(classifyAttachment(external('https://files.example.invalid/shared/doc.pdf'), calendarHomeUrl)).toEqual({ kind: 'external', url: 'https://files.example.invalid/shared/doc.pdf' });
        // An @ outside the authority is not userinfo.
        expect(classifyAttachment(external('https://files.example.invalid/a@b/doc?x=c@d'), calendarHomeUrl)).toEqual({ kind: 'external', url: 'https://files.example.invalid/a@b/doc?x=c@d' });
    });

    const withUserinfo: [string, string][] = [
        ['username only', 'https://alice@files.example.invalid/doc.pdf'],
        ['username and password', 'https://alice:s3cret@files.example.invalid/doc.pdf'],
        ['password only', 'http://:s3cret@files.example.invalid/doc.pdf'],
        ['percent-encoded userinfo', 'https://al%69ce%40corp:p%3Ass@files.example.invalid/doc.pdf'],
        ['an empty userinfo that the URL parser would drop', 'https://@files.example.invalid/doc.pdf'],
        ['an empty username and password that the URL parser would drop', 'https://:@files.example.invalid/doc.pdf'],
        ['userinfo after a backslash authority separator', 'https:\\\\alice@files.example.invalid/doc.pdf'],
    ];
    for (const [label, uri] of withUserinfo) {
        test(`is refused, not stripped: ${label}`, () => {
            expect(classifyAttachment(external(uri), calendarHomeUrl)).toEqual({ kind: 'unsupported' });
            expect(downloadSupported(external(uri), calendarHomeUrl)).toBe(false);
        });
    }

    test('a managed URL the policy refuses for userinfo does not fall through to an external link', () => {
        const uri = 'https://alice:s3cret@gateway.icloud.com/a1/b2/c3/d4/probe.txt/e5';
        expect(checkManagedAttachmentUrl({ url: uri, managedId: 'm1', calendarHomeUrl })).toEqual({ allowed: false, reason: 'userinfo' });
        const managed = descriptor({ form: 'managed', managedId: 'm1', uri, declaredSize: 32 });
        expect(classifyAttachment(managed, calendarHomeUrl)).toEqual({ kind: 'unsupported' });
        expect(downloadSupported(managed, calendarHomeUrl)).toBe(false);
    });

    test('the same managed URL without userinfo is still managed', () => {
        const managed = descriptor({ form: 'managed', managedId: 'm1', uri: 'https://gateway.icloud.com/a1/b2/c3/d4/probe.txt/e5', declaredSize: 32 });
        expect(classifyAttachment(managed, calendarHomeUrl).kind).toBe('managed');
    });
});
