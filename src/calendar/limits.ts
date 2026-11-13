/** Phase 2 read-path constants (design v3 sections 2-4). Every cap is enforced against injected backends too. */

const KIB = 1024;
const MIB = 1024 * KIB;

// Public result sizes.
export const DEFAULT_EVENTS = 25;
export const MAX_EVENTS = 100;
export const MAX_SELECTED_CALENDARS = 20;
export const MAX_DISCOVERED_CALENDARS = 300;
/** Whole serialized JSON-RPC wire response, including the structured/text duplication. */
export const MAX_WIRE_BYTES = 96 * KIB;
export const MAX_RAW_BYTES = 16 * KIB;
export const MAX_UNREADABLE = 50;
export const MAX_ATTENDEES = 100;
export const MAX_ATTACHMENTS = 100;

// Display text caps, in UTF-16 code units.
export const SLIM_TITLE_MAX = 256;
export const SLIM_LOCATION_MAX = 256;
export const SLIM_DESCRIPTION_MAX = 280;
export const FULL_TITLE_MAX = 1024;
export const FULL_LOCATION_MAX = 2048;
export const FULL_DESCRIPTION_MAX = 8192;
export const UID_MAX = 1024;
export const ATTENDEE_TEXT_MAX = 512;
export const DISPLAY_NAME_MAX = 256;
export const FILENAME_MAX = 255;
export const MIME_MAX = 255;
export const QUERY_MAX = 256;
export const PATH_MAX = 2048;
export const ETAG_MAX = 1024;
export const ETAG_MIN = 2;

// Range and transport window.
export const MIN_INPUT_YEAR = 1900;
export const MAX_INPUT_YEAR = 2100;
export const MAX_RANGE_DAYS = 366;
/**
 * Pad on each side of the requested range for list/search. iCloud returns a moved occurrence only when the query window
 * covers both its original slot and its new time (probe Run 5), so the window is widened by this much.
 */
export const MOVED_PAD_DAYS = 31;
/** Pad for single-occurrence (get_event) windows, and the widening applied to DATE/floating values when filtering by the requested range. */
export const TRANSPORT_PAD_HOURS = 24;
/** 366 days + two 24 h axis offsets + two 31-day pads, rounded up: the largest transport span a valid range can produce. */
export const MAX_TRANSPORT_DAYS = 430;

// Occurrence tokens.
/** Longest TZID text, in UTF-8 bytes, that an `occ2_` token carries. A longer one leaves its expanded resource unreadable. */
export const MAX_TOKEN_TZID_BYTES = 128;
/** `occ2_` (5) + `YYYYMMDDTHHMMSS` (15) + `_` (1) + unpadded base64url of MAX_TOKEN_TZID_BYTES bytes (171). */
export const OCCURRENCE_ID_MAX = 192;

// Concurrency and deadlines (milliseconds).
export const CALENDAR_CONCURRENCY = 3;
export const READ_CALL_MS = 45_000;
export const READ_LAMBDA_RESERVE_MS = 3000;
export const DAV_REQUEST_MS = 10_000;
export const DAV_LAMBDA_RESERVE_MS = 2000;
export const MIN_CALENDAR_START_MS = 12_000;
export const DOWNLOAD_CALL_MS = 30_000;
/** Whole-call budget of a write tool (design 5.6): listing, multiget, the write and one re-read, 10 s each at most. */
export const WRITE_CALL_MS = 40_000;
export const CLEANUP_ABORT_MS = 1000;
/** Yield to the event loop after this many normalized components. */
export const YIELD_EVERY_COMPONENTS = 32;

// Protective limits.
export const MAX_MEMBERSHIP_BYTES = 1 * MIB;
export const MAX_REPORT_BYTES = 8 * MIB;
export const MAX_AGGREGATE_BYTES = 16 * MIB;
export const MAX_RESOURCE_BYTES = 2 * MIB;
/** Conservative lower bound on the bytes one successful response element occupies in a REPORT. */
export const RESOURCE_ENVELOPE_LOWER_BOUND = 64;
export const MAX_RESOURCES_PER_REPORT = Math.floor(MAX_REPORT_BYTES / RESOURCE_ENVELOPE_LOWER_BOUND);
export const MAX_EXPANDED_VEVENTS_PER_CALENDAR = 5000;
export const MAX_EXPANDED_VEVENTS_PER_TOOL = 10_000;
export const MAX_ORIGINAL_VEVENTS = 2000;
export const MAX_LINES_PER_RESOURCE = 50_000;
export const MAX_LINES_PER_TOOL = 200_000;
export const MAX_PROPERTIES_PER_RESOURCE = 50_000;
export const MAX_PROPERTIES_PER_TOOL = 200_000;
export const MAX_UNFOLDED_LINE_BYTES = 2 * MIB;
export const MAX_ICS_NESTING = 8;
export const MAX_PARAMETERS_PER_PROPERTY = 32;
export const MAX_XML_DEPTH = 64;
export const MAX_XML_BINDINGS = 64;
export const MAX_REPORT_XML_ELEMENTS = 400_000;
export const MAX_REPORT_XML_NAMESPACE_DECLARATIONS = 160_000;
export const MAX_PROPFIND_XML_ELEMENTS = 50_000;
export const MAX_PROPFIND_XML_NAMESPACE_DECLARATIONS = 20_000;
export const MAX_MULTIGET_HREFS = 50;
export const MAX_MULTIGET_XML_BYTES = 256 * KIB;

// Download (R2).
export const MAX_DOWNLOAD_BYTES = 20 * MIB;
export const MAX_MULTIPART_PART_BYTES = 5 * MIB;
export const MAX_REDIRECTS = 3;
export const MAX_EMPTY_STREAM_CHUNKS = 1024;

/**
 * The element markup every successful REPORT response must contain, as it appears with default
 * namespaces and no text content. The sum is the proof that RESOURCE_ENVELOPE_LOWER_BOUND is a
 * lower bound on resource size, so MAX_RESOURCES_PER_REPORT is redundant with the byte cap.
 */
export const RESOURCE_ENVELOPE_MARKUP: readonly string[] = [
    '<response></response>',
    '<href></href>',
    '<propstat></propstat>',
    '<prop></prop>',
    '<getetag></getetag>',
    '<calendar-data></calendar-data>',
    '<status></status>',
];
export const MIN_RESOURCE_ENVELOPE_BYTES = RESOURCE_ENVELOPE_MARKUP.reduce((sum, markup) => sum + markup.length, 0);

/** Fixed resume hint texts. A hint, never a cursor. */
export const RESUME_INSTRUCTION = 'Re-query from this civil start with an explicit offset or Z, de-duplicate by calendar_id/resource_href/recurrence_id, and narrow the range or select fewer calendars if the same prefix repeats. This is a hint, not a cursor or completeness guarantee.';
export const RESUME_INSTRUCTION_NO_ROW = 'No event fit in the result. Narrow the range or select fewer calendars. This is a hint, not a cursor or completeness guarantee.';

/** Fixed trusted notice rendered whenever any calendar status is result_too_large. Never built from upstream text. */
export const RESULT_TOO_LARGE_NOTICE = `A calendar exceeded a safety limit: ${MAX_REPORT_BYTES / MIB} MiB/report, ${MAX_AGGREGATE_BYTES / MIB} MiB/tool, ${MAX_RESOURCE_BYTES / MIB} MiB/resource, ${MAX_EXPANDED_VEVENTS_PER_CALENDAR.toLocaleString('en-US')} expanded events/calendar, ${MAX_EXPANDED_VEVENTS_PER_TOOL.toLocaleString('en-US')}/tool, ${MAX_RESOURCES_PER_REPORT.toLocaleString('en-US')} resources/report, ${MAX_LINES_PER_RESOURCE.toLocaleString('en-US')} lines and ${MAX_PROPERTIES_PER_RESOURCE.toLocaleString('en-US')} properties/resource. Narrow the range or select fewer calendars.`;
