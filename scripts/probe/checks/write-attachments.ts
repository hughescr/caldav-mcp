/**
 * Write-mode attachment evidence. Every event here is written by the probe into its own temporary
 * calendar, so the properties of its ATTACH (parameter names, SIZE, host and scheme class) may be
 * recorded; the attachment URL itself, the MANAGED-ID and the file name never are. A verified
 * upload gets a separate anonymous/challenged/redirect download experiment on Apple hosts;
 * this does not relax the owner's attachment-fetch guard. The temporary calendar, with its events and
 * their attachments, is deleted by the write phase on every path, exactly like every other write
 * check; the managed attachment is also removed with `attachment-remove`, and if the check ends
 * early that removal is still attempted.
 */
import { attachForm, classifyUrl, declaredSize, type AttachForm } from '../attachments';
import { isOk, isRefusal, stopOnThrottle, type CheckContext, type CheckDef, type CheckOutput } from '../context';
import { eventComponents, getResource, requireSynthetic, taintIcalText, taintXml } from '../dav';
import type { ProbeResponse } from '../http';
import { props, type IcalComponent, type IcalProperty } from '../ical';
import { fixed, prose, safeNames, type Safe } from '../safe';
import type { Evidence } from '../types';
import { elementNames, parseXml } from '../xml';
import { downloadManaged, managedUrlShape } from './managed-download';
import { putOrStop } from './write-expansion';
import { DAY, SUMMARY, baseDay, newEvent, primary, probeCalendar, putEvent, utcSpan } from './write-helpers';

const PLAN = 'Phase 2 read path: attachments';

/** The probe's file: 32 ASCII bytes. */
export const PROBE_FILE_TEXT = 'caldav-mcp probe attachment 0001';
export const PROBE_FILE_NAME = 'probe-attachment.txt';
const EXTERNAL_URI = 'https://example.invalid/probe.txt';
const MANAGED_ID = /^[A-Za-z0-9._-]{1,128}$/;
const NONE = fixed('none');

interface Posted { res: ProbeResponse; errorElements: string[] }

/**
 * One attachment action (never followed to another URL). A 403 or 405 is a recorded answer. A 401
 * latches the run like any other 401: nothing more is sent except the one DELETE per temporary
 * calendar, so the calendars are still deleted.
 */
async function postAttachment(ctx: CheckContext, url: string, headers: Record<string, string>, body?: string): Promise<Posted> {
    const res = await ctx.http.request({ method: 'POST', url, headers, ...(body === undefined ? {} : { body }), followRedirects: false });
    stopOnThrottle(ctx, res);
    let errorElements: string[] = [];
    if (/^\s*</.test(res.body)) {
        const root = parseXml(res.body);
        taintXml(root, ctx.taint);
        errorElements = elementNames(root).filter((name) => name !== 'error' && name !== 'href');
    } else if (/^\s*BEGIN:VCALENDAR/i.test(res.body)) {
        taintIcalText(res.body, ctx.taint);
    }
    return { res, errorElements };
}

function attachesOf(ical: IcalComponent | undefined): IcalProperty[] {
    return eventComponents(ical).flatMap((e) => props(e, 'ATTACH'));
}

/** The FMTTYPE of the probe's own attachment: the one media type it uploads, or `<other>`. */
function fmttypeOf(p: IcalProperty): Safe {
    const value = p.params.FMTTYPE;
    return value === undefined ? NONE : fixed(value.toLowerCase() === 'text/plain' ? 'text/plain' : '<other>');
}

/** Properties of the probe's own ATTACH as read back. No URL, MANAGED-ID or file name. */
function describeAttach(ctx: CheckContext, attaches: readonly IcalProperty[], attach: IcalProperty | undefined): Evidence {
    const evidence: Evidence = { attachCount: attaches.length, attachForm: attach === undefined ? NONE : fixed(attachForm(attach)) };
    if (attach === undefined) {
        return evidence;
    }
    const size = declaredSize(attach);
    const url = attachForm(attach) === 'inline-binary' ? undefined : classifyUrl(attach.value);
    return Object.assign(evidence, {
        attachParameterNames: safeNames(Object.keys(attach.params), ctx.taint),
        declaredSize: size,
        declaredSizeEqualsUploaded: size === PROBE_FILE_TEXT.length,
        fmttype: fmttypeOf(attach),
        filenameEqualsUploaded: attach.params.FILENAME === PROBE_FILE_NAME,
        urlSchemeClass: url === undefined ? NONE : fixed(url.scheme),
        urlHostClass: url === undefined ? NONE : fixed(url.host),
    });
}

export const writeAttachmentManagedCheck: CheckDef = {
    id: 'write-attachment-managed',
    planItem: `${PLAN}: managed attachments (RFC 8607) with HTTP Basic and an app-specific password`,
    claim: 'The probe-authored managed attachment can be downloaded exactly, anonymously or after a sign-in challenge with Basic credentials; attachment removal and delayed event read-back are recorded separately.',
    needs: 'temp',
    async run(ctx): Promise<CheckOutput> {
        const temp = primary(ctx);
        const { url, uid } = newEvent(temp, 'attmanaged');
        const evidence: Evidence = {
            managedAttachmentsAdvertised: (ctx.state.homeDav?.tokens as readonly string[] | undefined)?.includes('calendar-managed-attachments') ?? false,
        };
        const put = await putOrStop(ctx, url, probeCalendar(ctx, uid, [...utcSpan(baseDay(ctx) + 24 * DAY), `SUMMARY:${SUMMARY}`]), evidence);
        const added = await postAttachment(ctx, `${url}?action=attachment-add`, {
            'content-type': 'text/plain',
            'content-disposition': `attachment; filename="${PROBE_FILE_NAME}"`,
            prefer: 'return=representation',
        }, PROBE_FILE_TEXT);
        evidence.addStatus = added.res.status;
        if (!isOk(added.res.status)) {
            evidence.preconditions = safeNames(added.errorElements, ctx.taint);
            return {
                outcome: isRefusal(added.res.status) ? 'refuted' : 'inconclusive',
                summary: prose`The server answered HTTP ${added.res.status} to the attachment-add request.`,
                evidence,
            };
        }
        const header = added.res.headers.get('cal-managed-id');
        ctx.taint.add(header);
        Object.assign(evidence, {
            calManagedIdHeaderPresent: header !== null,
            locationHeaderPresent: added.res.headers.has('location'),
            representationReturned: /^\s*BEGIN:VCALENDAR/i.test(added.res.body),
        });
        let managedId = header?.trim() ?? null;
        let removalAttempted = false;
        try {
            const after = await getResource(ctx, url);
            evidence.eventStatus = after.status;
            if (after.status === 200) {
                requireSynthetic(after.ical, after.url, temp.url, uid, after.status);
            }
            const attaches = attachesOf(after.ical);
            const attach = attaches.length === 1 ? attaches[0] : undefined;
            const paramId = attach?.params['MANAGED-ID'];
            ctx.taint.add(paramId);
            const verified = after.status === 200 && attach !== undefined && attachForm(attach) === 'uri-managed'
                && paramId !== undefined && paramId.length > 0 && declaredSize(attach) === Buffer.byteLength(PROBE_FILE_TEXT)
                && attach.params.FILENAME === PROBE_FILE_NAME && (header === null || header.trim() === paramId);
            evidence.attachmentProvenanceVerified = verified;
            evidence.etagChanged = put.etag === null || after.etag === null ? null : put.etag !== after.etag;
            if (!verified || attach === undefined || paramId === undefined) {
                return { outcome: 'inconclusive', summary: prose`The read-back did not identify exactly the uploaded attachment; no attachment URL evidence or fetch was attempted.`, evidence };
            }
            Object.assign(evidence, describeAttach(ctx, attaches, attach));
            evidence.managedIdEqualsHeader = header === null ? null : header.trim() === paramId;
            managedId ??= paramId;
            try { Object.assign(evidence, managedUrlShape(attach.value, paramId, ctx.state.homeUrl)); } catch { /* Invalid URL: download remains inconclusive. */ }
            const outcome = await downloadManaged(ctx, attach.value, PROBE_FILE_TEXT, evidence);
            if (managedId === null || !MANAGED_ID.test(managedId) || ctx.http.credentialsRejected) {
                evidence.removeSkipped = true;
            } else {
                removalAttempted = true;
                const removed = await postAttachment(ctx, `${url}?action=attachment-remove&managed-id=${managedId}`, {});
                evidence.removeStatus = removed.res.status;
                evidence.afterRemoveReads = 0;
                evidence.attachGoneAfterRemove = null;
                evidence.etagChangedAfterRemove = null;
                for (let attempt = 0; attempt < 3 && !ctx.http.credentialsRejected; attempt++) {
                    if (attempt > 0) { await ctx.sleep(2000); }
                    const gone = await getResource(ctx, url);
                    evidence.afterRemoveReads = attempt + 1;
                    evidence.afterRemoveEventStatus = gone.status;
                    if (gone.status !== 200) { break; }
                    requireSynthetic(gone.ical, gone.url, temp.url, uid, gone.status);
                    evidence.attachGoneAfterRemove = !attachesOf(gone.ical).some((a) => a.params['MANAGED-ID'] === managedId);
                    evidence.etagChangedAfterRemove = after.etag === null || gone.etag === null ? null : after.etag !== gone.etag;
                    if (evidence.attachGoneAfterRemove === true) { break; }
                }
            }
            return {
                outcome,
                summary: outcome === 'confirmed' ? prose`A permitted download returned exactly the uploaded bytes; removal evidence is recorded separately.`
                    : outcome === 'refuted' ? prose`All permitted download steps completed without returning the uploaded bytes; removal evidence is recorded separately.`
                        : prose`The download experiment was skipped or could not complete; removal evidence is recorded separately.`,
                evidence,
            };
        } finally {
            // The check ended early: still try to take the attachment off (the calendar deletion would remove it anyway).
            if (!removalAttempted && managedId !== null && MANAGED_ID.test(managedId) && !ctx.http.credentialsRejected) {
                await postAttachment(ctx, `${url}?action=attachment-remove&managed-id=${managedId}`, {}).catch(() => undefined);
            }
        }
    },
};

export type Disposition = 'preserved' | 'converted-to-managed' | 'dropped' | 'modified';

/** What a server did with the ATTACH it was sent: kept it as sent, made it a managed attachment, removed it, or changed it. */
export function dispositionOf(sent: { form: AttachForm; value: string; params?: Readonly<Record<string, string>> }, returned: readonly IcalProperty[]): Disposition {
    const first = returned[0];
    if (first === undefined) {
        return 'dropped';
    }
    if (returned.length !== 1) {
        return 'modified';
    }
    const normalized = (params: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(params).map(([name, value]) => {
        const key = name.toUpperCase();
        return [key, ['ENCODING', 'VALUE', 'FMTTYPE'].includes(key) ? value.toLowerCase() : value];
    }).toSorted(([a], [b]) => (a ?? '').localeCompare(b ?? '')));
    const form = attachForm(first);
    if (form === sent.form && first.value === sent.value && normalized(first.params) === normalized(sent.params ?? {})) {
        return 'preserved';
    }
    return form === 'uri-managed' && sent.form !== 'uri-managed' ? 'converted-to-managed' : 'modified';
}

/** RFC 5545 line folding at 75 octets (the values here are ASCII). */
function fold(line: string): string {
    const parts = [line.slice(0, 75)];
    for (let i = 75; i < line.length; i += 74) {
        parts.push(` ${line.slice(i, i + 74)}`);
    }
    return parts.join('\r\n');
}

export const writeAttachmentInlineCheck: CheckDef = {
    id: 'write-attachment-inline',
    planItem: `${PLAN}: inline base64 and external URI attachments sent by PUT`,
    claim: 'An event with an inline base64 ATTACH and an event with an external ATTACH URI are both accepted by PUT and read back with the ATTACH unchanged.',
    needs: 'temp',
    async run(ctx): Promise<CheckOutput> {
        const temp = primary(ctx);
        const inline = Buffer.from(PROBE_FILE_TEXT, 'utf8').toString('base64');
        const cases = [
            { key: 'inline', suffix: 'attinline', line: `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=text/plain:${inline}`, form: 'inline-binary' as const, value: inline, params: { ENCODING: 'BASE64', VALUE: 'BINARY', FMTTYPE: 'text/plain' }, days: 25 },
            { key: 'external', suffix: 'attexternal', line: `ATTACH:${EXTERNAL_URI}`, form: 'uri-unmanaged' as const, value: EXTERNAL_URI, days: 26 },
        ];
        const evidence: Evidence = {};
        const results: { accepted: boolean; refused: boolean; disposition: Disposition | null }[] = [];
        for (const c of cases) {
            const { url, uid } = newEvent(temp, c.suffix);
            const body = probeCalendar(ctx, uid, [...utcSpan(baseDay(ctx) + c.days * DAY), `SUMMARY:${SUMMARY}`, fold(c.line)]);
            const put = await putEvent(ctx, url, body, { 'if-none-match': '*' });
            evidence[`${c.key}PutStatus`] = put.status;
            const accepted = isOk(put.status);
            if (!accepted) {
                evidence[`${c.key}Preconditions`] = safeNames(put.errorElements, ctx.taint);
                results.push({ accepted, refused: isRefusal(put.status), disposition: null });
                continue;
            }
            const got = await getResource(ctx, url);
            if (got.status === 200) {
                requireSynthetic(got.ical, got.url, temp.url, uid, got.status);
            }
            const attaches = attachesOf(got.ical);
            const disposition = got.ical === undefined ? null : dispositionOf(c, attaches);
            evidence[`${c.key}GetStatus`] = got.status;
            evidence[`${c.key}Disposition`] = disposition === null ? NONE : fixed(disposition);
            evidence[`${c.key}AttachCount`] = attaches.length;
            evidence[`${c.key}ParameterNames`] = safeNames(Object.keys(attaches[0]?.params ?? {}), ctx.taint);
            evidence[`${c.key}ValueUnchanged`] = attaches.length === 1 && attaches[0]?.value === c.value;
            results.push({ accepted, refused: false, disposition });
        }
        if (results.every((r) => r.accepted && r.disposition === 'preserved')) {
            return { outcome: 'confirmed', summary: prose`Both events were accepted and read back with the ATTACH unchanged.`, evidence };
        }
        if (results.some((r) => r.refused || (r.disposition !== null && r.disposition !== 'preserved'))) {
            const changed = results.filter((r) => r.disposition !== null && r.disposition !== 'preserved').length;
            const refused = results.filter((r) => r.refused).length;
            return { outcome: 'refuted', summary: prose`${refused} event(s) were refused and ${changed} had the ATTACH changed or dropped.`, evidence };
        }
        return { outcome: 'inconclusive', summary: prose`The events could not both be written and read back.`, evidence };
    },
};

export const ATTACHMENT_WRITE_CHECKS: CheckDef[] = [writeAttachmentManagedCheck, writeAttachmentInlineCheck];
