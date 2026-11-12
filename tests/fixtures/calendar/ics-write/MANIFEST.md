# ics-write / ics-edit fixtures

`apple-series.ics` is **synthetic**, shaped after probe evidence (runs 3–7), never a capture. A TZID weekly series with a
VTIMEZONE, two EXDATE lines, two overrides (one moved, with its own VALARM), a VTODO sibling, Apple companions
(`X-APPLE-STRUCTURED-LOCATION`, `X-ALT-DESC`, `X-APPLE-TRAVEL-ADVISORY-BEHAVIOR` after the VALARM), a VALARM with its own
`SUMMARY`/`DESCRIPTION`/`UID`, duplicate `X-CUSTOM-FLAG` and `COMMENT` lines, duplicate parameters and an external ATTACH.
LF line endings. Long lines are folded iCloud-style at 91 octets on code-point boundaries (Run 7: iCloud re-folds stored
text up to 91 octets, never inside UTF-8); `DESCRIPTION` uses a TAB continuation and its first physical line ends with a
space. Names, addresses and coordinates are invented.

Used by `tests/calendar-ics-edit.test.ts`. Expected outputs there are hand-written splices of this file's physical lines
(by 1-based line number) with hand-written new lines. The 100 KB inline ATTACH and the re-folded fuzz inputs are built in
the test from seeded data with the test's own folder.
