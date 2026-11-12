/**
 * Pass-through output fields from parsed components (design v3 section 2). Times are passed through as stored with the
 * fixed warnings from time-core; display prose is sanitized and truncated; nothing is interpreted. No network.
 */
import type { Attendee, FullEvent, SlimEvent } from './event-schemas';
import {
    ATTENDEE_TEXT_MAX, FULL_DESCRIPTION_MAX, FULL_LOCATION_MAX, FULL_TITLE_MAX, MAX_ATTENDEES, SLIM_DESCRIPTION_MAX, SLIM_LOCATION_MAX, SLIM_TITLE_MAX, UID_MAX,
} from './limits';
import { IcalError, type EventComponent, type RawProperty } from './model';
import { toEventTime } from './time-core';

export interface DisplayText {
    text: string;
    /** True when any disallowed character was replaced with U+FFFD. */
    sanitized: boolean;
    /** True when the text was cut to fit. */
    truncated: boolean;
}

const REPLACEMENT = '�';

function isDisallowed(code: number): boolean {
    return (code < 0x20 && code !== 0x09 && code !== 0x0A) // C0 controls except TAB and LF; CR is normalized before this test.
        || code === 0x7F
        || (code >= 0x202A && code <= 0x202E) // bidi embedding and override controls
        || (code >= 0x2066 && code <= 0x2069); // bidi isolate controls
}

/**
 * Display prose only: replaces C0 controls except TAB/LF/CR, DEL, bidi override/isolate controls and lone surrogates with
 * U+FFFD, normalizes CRLF/CR to LF, then truncates to `maxUnits` UTF-16 units without splitting a surrogate pair and
 * without an ellipsis. `sanitized` reports replacements within the returned text.
 */
export function sanitizeDisplayText(text: string, maxUnits: number): DisplayText {
    let out = '';
    let sanitized = false;
    let truncated = false;
    let index = 0;
    while (index < text.length) {
        const code = text.charCodeAt(index);
        let piece: string;
        let advance = 1;
        let replaced = false;
        if (code === 0x0D) {
            piece = '\n';
            if (text.charCodeAt(index + 1) === 0x0A) { advance = 2; }
        } else if (isDisallowed(code)) {
            piece = REPLACEMENT;
            replaced = true;
        } else if (code >= 0xD800 && code <= 0xDBFF) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                piece = text.slice(index, index + 2);
                advance = 2;
            } else {
                piece = REPLACEMENT;
                replaced = true;
            }
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            piece = REPLACEMENT;
            replaced = true;
        } else {
            piece = text.charAt(index);
        }
        if (out.length + piece.length > maxUnits) {
            truncated = true;
            break;
        }
        out += piece;
        if (replaced) { sanitized = true; }
        index += advance;
    }
    return { text: out, sanitized, truncated };
}

export interface NormalizeContext {
    /** Index into the per-call calendar status array. */
    calendar: number;
    resourceHref: string;
    /** The resource ETag from the same report that supplied the component. */
    etag: string;
    recurring: boolean;
}

export interface FullNormalizeContext extends NormalizeContext {
    calendarId: string;
    view: 'single' | 'series_master' | 'occurrence';
}

function firstProperty(component: EventComponent, name: string): RawProperty | undefined {
    return component.properties.get(name)?.[0];
}

/** The first string value of a property, or null. jCal has already unescaped TEXT. */
function propertyText(component: EventComponent, name: string): string | null {
    const value = firstProperty(component, name)?.values[0];
    return typeof value === 'string' ? value : null;
}

function firstParameter(property: RawProperty, name: string): string | null {
    return property.params.get(name)?.[0] ?? null;
}

interface TextFlags { text: string | null; sanitized: boolean; truncated: boolean }

function displayField(value: string | null, max: number): TextFlags {
    if (value === null) { return { text: null, sanitized: false, truncated: false }; }
    return sanitizeDisplayText(value, max);
}

const ROLES = ['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT'] as const;
const PARTICIPATIONS = ['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED'] as const;

function enumValue<const T extends readonly string[]>(allowed: T, raw: string | null): T[number] | null {
    const upper = raw?.toUpperCase();
    return allowed.find(candidate => candidate === upper) ?? null;
}

function toAttendee(property: RawProperty): Attendee {
    const value = property.values[0];
    const address = displayField(typeof value === 'string' ? value : null, ATTENDEE_TEXT_MAX);
    const name = displayField(firstParameter(property, 'cn'), ATTENDEE_TEXT_MAX);
    const sanitized = address.sanitized || name.sanitized;
    const truncated = address.truncated || name.truncated;
    return {
        address: address.text,
        name: name.text,
        role: enumValue(ROLES, firstParameter(property, 'role')),
        participation: enumValue(PARTICIPATIONS, firstParameter(property, 'partstat')),
        ...(sanitized ? { sanitized: true as const } : {}),
        ...(truncated ? { truncated: true as const } : {}),
    };
}

interface Limits { title: number; location: number; description: number }

function baseFields(component: EventComponent, context: NormalizeContext, limits: Limits) {
    const title = displayField(propertyText(component, 'summary'), limits.title);
    const location = displayField(propertyText(component, 'location'), limits.location);
    const description = displayField(propertyText(component, 'description'), limits.description);
    const status = enumValue(['TENTATIVE', 'CANCELLED'] as const, propertyText(component, 'status'));
    const transparent = propertyText(component, 'transp')?.toUpperCase() === 'TRANSPARENT';
    const sanitized = title.sanitized || location.sanitized || description.sanitized;
    return {
        calendar: context.calendar,
        resource_href: context.resourceHref,
        recurrence_id: component.recurrenceId?.token ?? null,
        expected_version: context.etag,
        recurring: context.recurring,
        start: toEventTime(component.start),
        end: component.end === null ? null : toEventTime(component.end),
        duration: component.duration,
        title: title.text,
        location: location.text,
        description: description.text,
        ...(title.truncated ? { title_truncated: true as const } : {}),
        ...(location.truncated ? { location_truncated: true as const } : {}),
        ...(description.truncated ? { description_truncated: true as const } : {}),
        ...(sanitized ? { sanitized: true as const } : {}),
        ...(status === null ? {} : { status }),
        ...(transparent ? { transparency: 'TRANSPARENT' as const } : {}),
        attendees_count: component.properties.get('attendee')?.length ?? 0,
    };
}

export function normalizeSlimEvent(component: EventComponent, context: NormalizeContext): SlimEvent {
    return baseFields(component, context, { title: SLIM_TITLE_MAX, location: SLIM_LOCATION_MAX, description: SLIM_DESCRIPTION_MAX });
}

export function normalizeFullEvent(component: EventComponent, context: FullNormalizeContext): FullEvent {
    // A UID is an identifier, never truncated or altered, so one the output cannot carry makes the component unreadable.
    if (component.uid.length > UID_MAX) { throw new IcalError('malformed'); }
    const attendees = component.properties.get('attendee') ?? [];
    const organizer = firstProperty(component, 'organizer');
    return {
        ...baseFields(component, context, { title: FULL_TITLE_MAX, location: FULL_LOCATION_MAX, description: FULL_DESCRIPTION_MAX }),
        calendar_id: context.calendarId,
        uid: component.uid,
        view: context.view,
        end_exclusive: true,
        organizer: organizer === undefined ? null : toAttendee(organizer),
        attendees: attendees.slice(0, MAX_ATTENDEES).map(toAttendee),
        ...(attendees.length > MAX_ATTENDEES ? { attendees_truncated: true as const } : {}),
        omitted: { alarms: component.alarmCount, extension_properties: component.extensionPropertyCount },
    };
}
