/** Time-zone name validity, from the runtime's built-in Temporal (nothing is bundled or polyfilled). */
interface TemporalLike {
    ZonedDateTime: new (epochNanoseconds: bigint, timeZone: string) => unknown;
}

const OFFSET_FORM = /^[+-]\d{2}(:?\d{2}(:?\d{2})?)?$/;

/**
 * A validator that asks Temporal once per distinct name. The memory lives only as long as the
 * returned function, so no TZID outlives the check that read it. The answer is true when
 * Temporal accepts the name as an IANA zone, and undefined when this runtime has no Temporal.
 */
export function zoneValidator(): (tzid: string) => boolean | undefined {
    const temporal = (globalThis as { Temporal?: TemporalLike }).Temporal;
    const known = new Map<string, boolean>();
    return (tzid) => {
        if (temporal === undefined) {
            return undefined;
        }
        let valid = known.get(tzid);
        if (valid === undefined) {
            valid = false;
            if (tzid !== '' && !OFFSET_FORM.test(tzid)) {
                try {
                    new temporal.ZonedDateTime(0n, tzid);
                    valid = true;
                } catch {
                    valid = false;
                }
            }
            known.set(tzid, valid);
        }
        return valid;
    };
}
