/**
 * Literal text matching (design v3 sections 2 and 6): trimmed, NFC-normalized, locale-independent lower-case substring
 * search. No regex, no wildcard and no fuzzy matching; every query character is literal. No network.
 */

export type SearchField = 'title' | 'description' | 'location';

function fold(text: string): string {
    return text.normalize('NFC').toLowerCase();
}

/** Trimmed, NFC-normalized, locale-independent lower-case form of a query. */
export function normalizeQuery(query: string): string {
    return fold(query.trim());
}

/** OR across the selected fields of the full parsed text, before display truncation. `query` is already normalized. */
export function matchesQuery(
    text: { title: string | null; description: string | null; location: string | null },
    normalizedQuery: string,
    fields: readonly SearchField[],
): boolean {
    for (const field of fields) {
        const value = text[field];
        if (value !== null && fold(value).includes(normalizedQuery)) { return true; }
    }
    return false;
}
