/**
 * What the probe may say about an ATTACH property: its form, the class of the host and scheme
 * of its URI, which parameters it carries, and size and type in fixed buckets. Never the URL,
 * the host name, a file name, a MANAGED-ID or any other value: the owner's data contributes
 * counts and members of the fixed enums below, nothing else. (A property of an event the probe
 * wrote itself may additionally be described by the write checks, still without any URL.)
 */
import { isAllowedProbeUrl, isPerAccountHost, DISCOVERY_HOST } from './hosts';
import { comps, isInlineBinary, props, type IcalComponent, type IcalProperty } from './ical';
import type { Evidence } from './types';

export const HOST_CLASSES = ['caldav-root', 'caldav-partition', 'icloud-other', 'icloud-content', 'apple-other', 'other', 'unparseable'] as const;
export type HostClass = (typeof HOST_CLASSES)[number];

export const SCHEME_CLASSES = ['https', 'http', 'other'] as const;
export type SchemeClass = (typeof SCHEME_CLASSES)[number];

export const ATTACH_FORMS = ['inline-binary', 'uri-managed', 'uri-unmanaged'] as const;
export type AttachForm = (typeof ATTACH_FORMS)[number];

export const SIZE_BUCKETS = ['lt64KiB', 'lt1MiB', 'lt5MiB', 'lt20MiB', 'ge20MiB', 'missingOrInvalid'] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

export const TYPE_CLASSES = ['application', 'image', 'text', 'audio', 'video', 'other', 'missing'] as const;
export type TypeClass = (typeof TYPE_CLASSES)[number];

export const PARAM_KEYS = ['fmttype', 'size', 'filename', 'managedId', 'xAppleFilename', 'otherXParameter'] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

const KIB = 1024;
const MIB = 1024 * KIB;

/** Class of a host name. The only classification that is ever recorded for a URL's host. */
export function classifyHost(hostname: string): HostClass {
    const host = hostname.toLowerCase();
    if (host === '') {
        return 'unparseable';
    }
    if (host === DISCOVERY_HOST) {
        return 'caldav-root';
    }
    if (isPerAccountHost(host)) {
        return 'caldav-partition';
    }
    if (host === 'icloud-content.com' || host.endsWith('.icloud-content.com')) {
        return 'icloud-content';
    }
    if (host === 'icloud.com' || host.endsWith('.icloud.com')) {
        return 'icloud-other';
    }
    if (['apple.com', 'me.com', 'mac.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return 'apple-other';
    }
    return 'other';
}

/** Scheme and host class of a URI value, resolved against `base` when it is relative. */
export function classifyUrl(value: string, base?: string): { scheme: SchemeClass; host: HostClass } {
    let url: URL;
    try {
        url = new URL(value.trim(), base);
    } catch {
        return { scheme: 'other', host: 'unparseable' };
    }
    const scheme: SchemeClass = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : 'other';
    return { scheme, host: classifyHost(url.hostname) };
}

/** Whether the probe's host guard would let this URL be requested. */
export function isFetchable(value: string): boolean {
    return isAllowedProbeUrl(value.trim());
}

export function sizeBucket(bytes: number | null): SizeBucket {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
        return 'missingOrInvalid';
    }
    if (bytes < 64 * KIB) {
        return 'lt64KiB';
    }
    if (bytes < MIB) {
        return 'lt1MiB';
    }
    if (bytes < 5 * MIB) {
        return 'lt5MiB';
    }
    return bytes < 20 * MIB ? 'lt20MiB' : 'ge20MiB';
}

/** A SIZE parameter: digits only. */
export function declaredSize(p: IcalProperty): number | null {
    const raw = p.params.SIZE?.trim();
    return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Decoded size of an inline base64 value, without decoding it; null when it is not base64. */
export function inlineSize(p: IcalProperty): number | null {
    const text = p.value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) {
        return null;
    }
    return Math.floor((text.replace(/=+$/, '').length * 3) / 4);
}

/** The top-level type of a media type (an FMTTYPE or a Content-Type value) as a member of the fixed enum. */
export function typeClass(mediaType: string | null | undefined): TypeClass {
    if (mediaType === null || mediaType === undefined || mediaType.trim() === '') {
        return 'missing';
    }
    const top = mediaType.split(';')[0]?.trim().split('/')[0]?.toLowerCase() ?? '';
    return (['application', 'image', 'text', 'audio', 'video'] as const).find((t) => t === top) ?? 'other';
}

export function attachForm(p: IcalProperty): AttachForm {
    if (isInlineBinary(p)) {
        return 'inline-binary';
    }
    return p.params['MANAGED-ID'] === undefined ? 'uri-unmanaged' : 'uri-managed';
}

type ByScheme = Record<SchemeClass, number>;
type ByHost = Record<HostClass, number>;
type BySize = Record<SizeBucket, number>;

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
    return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/** Every number is a count of ATTACH properties (or of VEVENTs); nothing here holds a value. */
export interface AttachmentTally {
    resources: number;
    vevents: number;
    veventsWithAttach: number;
    attachProperties: number;
    maxAttachPerVevent: number;
    forms: Record<AttachForm, number>;
    schemeManaged: ByScheme;
    schemeUnmanaged: ByScheme;
    hostManaged: ByHost;
    hostUnmanaged: ByHost;
    params: Record<ParamKey, number>;
    /** Declared SIZE of the URI forms. */
    declaredSize: BySize;
    /** Estimated decoded size of inline-binary ATTACHes. */
    inlineSize: BySize;
    fmttype: Record<TypeClass, number>;
    /** Managed attachments whose URL passes the probe's host guard. */
    managedFetchable: number;
}

export function emptyTally(): AttachmentTally {
    return {
        resources: 0, vevents: 0, veventsWithAttach: 0, attachProperties: 0, maxAttachPerVevent: 0,
        forms: zeros(ATTACH_FORMS),
        schemeManaged: zeros(SCHEME_CLASSES), schemeUnmanaged: zeros(SCHEME_CLASSES),
        hostManaged: zeros(HOST_CLASSES), hostUnmanaged: zeros(HOST_CLASSES),
        params: zeros(PARAM_KEYS),
        declaredSize: zeros(SIZE_BUCKETS), inlineSize: zeros(SIZE_BUCKETS),
        fmttype: zeros(TYPE_CLASSES),
        managedFetchable: 0,
    };
}

/** A managed attachment the read-only fetch check may request: guard-allowed URL (in memory only). */
export interface FetchCandidate {
    url: string;
    declaredSize: number | null;
}

/** What the strictness census leaves for the attachment checks (in memory; the URL never leaves the process). */
export interface AttachmentState {
    tally: AttachmentTally;
    calendarsQueried: number;
    calendarsRead: number;
    calendarsOverBodyCap: number;
    coverageComplete: boolean;
    /** The wide query was cut short by throttling or a run-level stop. */
    stoppedEarly: boolean;
    candidate?: FetchCandidate;
}

/**
 * Adds the VEVENTs of one parsed resource to the tally. `onManaged` receives the URL and declared
 * SIZE of each managed attachment (the caller keeps one fetchable candidate in memory).
 */
export function addAttachments(tally: AttachmentTally, root: IcalComponent | undefined, onManaged?: (url: string, size: number | null) => void): void {
    if (root === undefined) {
        return;
    }
    tally.resources++;
    for (const event of comps(root, 'VEVENT')) {
        tally.vevents++;
        const attaches = props(event, 'ATTACH');
        tally.veventsWithAttach += attaches.length > 0 ? 1 : 0;
        tally.attachProperties += attaches.length;
        tally.maxAttachPerVevent = Math.max(tally.maxAttachPerVevent, attaches.length);
        for (const attach of attaches) {
            addOne(tally, attach, onManaged);
        }
    }
}

function addOne(tally: AttachmentTally, attach: IcalProperty, onManaged: ((url: string, size: number | null) => void) | undefined): void {
    const form = attachForm(attach);
    tally.forms[form]++;
    const keys = Object.keys(attach.params);
    const present: Record<ParamKey, boolean> = {
        fmttype: attach.params.FMTTYPE !== undefined,
        size: attach.params.SIZE !== undefined,
        filename: attach.params.FILENAME !== undefined,
        managedId: attach.params['MANAGED-ID'] !== undefined,
        xAppleFilename: attach.params['X-APPLE-FILENAME'] !== undefined,
        otherXParameter: keys.some((k) => k.startsWith('X-') && k !== 'X-APPLE-FILENAME'),
    };
    for (const key of PARAM_KEYS) {
        tally.params[key] += present[key] ? 1 : 0;
    }
    tally.fmttype[typeClass(attach.params.FMTTYPE)]++;
    if (form === 'inline-binary') {
        tally.inlineSize[sizeBucket(inlineSize(attach))]++;
        return;
    }
    const size = declaredSize(attach);
    tally.declaredSize[sizeBucket(size)]++;
    const managed = form === 'uri-managed';
    const { scheme, host } = classifyUrl(attach.value);
    (managed ? tally.schemeManaged : tally.schemeUnmanaged)[scheme]++;
    (managed ? tally.hostManaged : tally.hostUnmanaged)[host]++;
    if (managed && isFetchable(attach.value)) {
        tally.managedFetchable++;
        onManaged?.(attach.value.trim(), size);
    }
}

/** Flat evidence of a tally: counts, and records keyed by the fixed enums above. */
export function tallyEvidence(tally: AttachmentTally): Evidence {
    return {
        resources: tally.resources,
        vevents: tally.vevents,
        veventsWithAttach: tally.veventsWithAttach,
        attachProperties: tally.attachProperties,
        maxAttachPerVevent: tally.maxAttachPerVevent,
        forms: tally.forms,
        uriManagedBySchemeClass: tally.schemeManaged,
        uriUnmanagedBySchemeClass: tally.schemeUnmanaged,
        uriManagedByHostClass: tally.hostManaged,
        uriUnmanagedByHostClass: tally.hostUnmanaged,
        parameterPresence: tally.params,
        declaredSizeBuckets: tally.declaredSize,
        inlineDecodedSizeBuckets: tally.inlineSize,
        fmttypeTopLevel: tally.fmttype,
        managedWithGuardAllowedHost: tally.managedFetchable,
    };
}
