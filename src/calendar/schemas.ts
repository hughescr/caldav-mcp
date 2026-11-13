import { z } from 'zod';
import { readToolErrorCodeSchema } from './event-schemas';
import { writeToolErrorCodeSchema } from './write-schemas';

/** list_calendars returns at most this many collections; more are reported with truncated: true. */
export const MAX_CALENDARS = 200;

/** Every tool error code: the read tools' codes and the codes only the write tools produce. */
export const toolErrorCodeSchema = z.enum([...readToolErrorCodeSchema.options, ...writeToolErrorCodeSchema.options]);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const listCalendarsInputSchema = z.strictObject({});

export const calendarSummarySchema = z.strictObject({
    id: z.string().min(1).max(2048).describe('The calendar_id: opaque path; pass back unchanged. Not a URL.'),
    displayName: z.string().nullable(),
    components: z.array(z.string().regex(/^[A-Z][A-Z0-9-]*$/u)),
    color: z.string().nullable(),
});

export const listCalendarsOutputSchema = z.strictObject({
    calendars: z.array(calendarSummarySchema).max(MAX_CALENDARS),
    truncated: z.boolean(),
});
export type ListCalendarsOutput = z.infer<typeof listCalendarsOutputSchema>;
