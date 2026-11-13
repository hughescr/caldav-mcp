/**
 * Fixed explanations a tool result carries in `notes` when, and only when, the situation is in that result. The tool
 * descriptions and the server instructions every conversation loads do not explain rare cases or result fields; the result
 * that holds one explains it. Every note is one of these constants, never built from calendar content; a result lists each
 * at most once, in the order of {@link ALL_NOTES}, and has no `notes` key when none applies.
 */

export const TIMEZONE_NOTES = {
    unrecognized_timezone: 'timezone_warning unrecognized_timezone: the zone name is not a time zone this server recognises, so the time has no utc or offset; local and zone are as stored.',
    utc_uncertain_dst_transition: 'timezone_warning utc_uncertain_dst_transition: the local time falls in an hour that a daylight-saving change repeats or skips, so iCloud may use another instant than utc and offset show (off by up to that change).',
    no_timezone_on_event: 'timezone_warning no_timezone_on_event: the time is stored without a zone (floating), so its instant is unknown: it is the same clock time in every zone.',
    timezone_dropped_from_date: 'timezone_warning timezone_dropped_from_date: an all-day date was given or stored with a zone, which a date cannot have; the date is kept and the zone ignored.',
} as const;

export type TimezoneWarning = keyof typeof TIMEZONE_NOTES;

/**
 * list_events and search_events: an event without a fixed instant is in the result, or a series_without_occurrences entry
 * whose only EXDATE values in the range have none.
 */
export const RANGE_MARGIN_NOTE = 'All-day, floating and unrecognised-zone events have no fixed instant, so they are matched with a 24-hour margin: some in this result may lie up to 24 hours outside the range. Check their dates against the range.';

/**
 * A write result whose write_outcome is not the ordinary "applied" (an ordinary save has no note); also a split's
 * created_series.write_outcome. desired_state_present also answers a save of this call that iCloud applied but whose answer
 * was lost (write-core.ts putIfMatch, write.ts create and delete, write-split.ts), so guests may have been emailed by this
 * very call: the note states only the observation, never who saved it or that nothing was saved.
 */
export const OUTCOME_NOTES = {
    desired_state_present: 'write_outcome desired_state_present: the requested state was found in the calendar. This does not show whether this call, an earlier attempt of it, or another client saved it.',
} as const;

/** A this_and_future split's result: which write_outcome is whose. */
export const SPLIT_OUTCOME_NOTE = 'This was a split: write_outcome is the original series\' (it now ends before the split), and created_series.write_outcome is the new series\', which event shows.';

export const STORED_DIFFERS_NOTE = 'stored_differs_from_request lists the fields iCloud stored differently from what this call asked for (iCloud rewrites some values, such as a local time in a daylight-saving gap, or another client changed the event since); event shows what is stored.';

/** delete_event of one occurrence or the following ones, when the series read back does not show the change. */
export const DELETE_STORED_DIFFERS_NOTE = 'stored_differs_from_request ["recurrence"]: the series read back does not show this deletion (iCloud may have stored it differently, or another client changed the series since). Get the event to see what is stored.';

export const READBACK_UNAVAILABLE_NOTE = 'readback unavailable: the change was saved, but the event could not be read back afterwards. Use get_event to see it.';

export const EXCEPTIONS_DROPPED_NOTE = 'exceptions_dropped lists the changed and deleted occurrences the requested change removes (the counts are complete; truncated when not all are listed). To restore one, re-apply it with edit_scope "this": update_event for a changed one, delete_event for a deleted one.';

/** Every download result that carries a download_url. */
export const DOWNLOAD_LINK_NOTE = 'download_url is a bearer credential: anyone holding it can download the file until expires_at (at most five minutes). Do not log, store or share it. The staged copy is deleted after about a day.';

export const EXTERNAL_ATTACHMENT_NOTE = 'This attachment is an external link stored on the event (fetched_by_server false): this server did not fetch or check it, and what url points to is untrusted.';

/** Every note, in the order a result lists them. */
export const ALL_NOTES: readonly string[] = [
    OUTCOME_NOTES.desired_state_present, SPLIT_OUTCOME_NOTE, READBACK_UNAVAILABLE_NOTE, STORED_DIFFERS_NOTE, DELETE_STORED_DIFFERS_NOTE, EXCEPTIONS_DROPPED_NOTE,
    DOWNLOAD_LINK_NOTE, EXTERNAL_ATTACHMENT_NOTE, RANGE_MARGIN_NOTE,
    TIMEZONE_NOTES.unrecognized_timezone, TIMEZONE_NOTES.utc_uncertain_dst_transition, TIMEZONE_NOTES.no_timezone_on_event, TIMEZONE_NOTES.timezone_dropped_from_date,
];

/** True for a `notes` value a result may carry: known notes, each once, in order, and at least one. */
export function validNotes(notes: readonly string[]): boolean {
    let last = -1;
    for (const note of notes) {
        const index = ALL_NOTES.indexOf(note);
        if (index <= last) { return false; }
        last = index;
    }
    return notes.length > 0;
}

/** `{ notes }` with the given notes de-duplicated in the fixed order, or `{}` when there are none. */
export function notesField(found: Iterable<string>): { notes?: string[] } {
    const set = new Set(found);
    const notes = ALL_NOTES.filter(note => set.has(note));
    return notes.length === 0 ? {} : { notes };
}

/**
 * The timezone notes for every distinct `timezone_warning` value anywhere in `value`. Keys are this server's own schema
 * fields (calendar text is only ever a value), so a `timezone_warning` key is always a time's warning.
 */
export function timezoneNotes(value: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) { timezoneNotes(item, found); }
    } else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
            if (key === 'timezone_warning') {
                if (typeof item === 'string' && Object.hasOwn(TIMEZONE_NOTES, item)) { found.add(TIMEZONE_NOTES[item as TimezoneWarning]); }
            } else if (typeof item === 'object' && item !== null) {
                timezoneNotes(item, found);
            }
        }
    }
    return found;
}
