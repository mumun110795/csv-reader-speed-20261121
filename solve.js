// A fast single-pass reader for broken CSV text.
//
// run(input) answers {text, header} with {columns, rows, errors}, reading the
// text once, left to right:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters (once stray
//     CRs are dropped) is no record at all;
//   - outside quotes, a CR not followed by LF is dropped (stray_cr);
//   - a field whose first character is a quote runs to the next quote that is
//     not doubled ("" inside is one quote; CRLF and lone CR inside read as
//     LF); characters after the closing quote, up to the next comma or line
//     break, are appended as they stand (quote_junk, when any were appended;
//     a lone CR among them is dropped as stray_cr instead);
//   - a quote with no closing quote is a literal character and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote anywhere else is a literal character; fields are never trimmed.
// columns is the first record when header is true (else null); every later
// record is padded with empty strings (short_row) or cut (long_row) to the
// first record's width. Errors are {code, line, row} in the order met, line
// the 1-based line the record starts on (counting every LF, CRLF and lone CR
// inside quotes), row the record's index in rows, null for the header.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r

export function run(input) {
  const text = input.text;
  const header = !!input.header;
  const n = text.length;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1;

  const rows = [];
  const errors = [];
  let columns = header ? [] : null;
  let width = -1;
  let headerDone = !header;
  let line = 1;

  // The field most recently read by readUnquoted, and how it ended:
  // 0 = comma, 1 = line break, 2 = end of text.
  let fValue = '';
  let fEnd = 2;

  // Per-record error attribution, set at the top of each record.
  let recLine = 1;
  let recRow = null;

  // Reads one unquoted field starting at i (i is left past its terminator).
  // A quote met here is an ordinary character.
  function readUnquoted() {
    const start = i;
    let parts = null;
    let segStart = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === COMMA) {
        fValue = parts === null ? text.slice(start, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
        i += 1;
        fEnd = 0;
        return;
      }
      if (c === LF) {
        fValue = parts === null ? text.slice(start, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
        i += 1;
        line += 1;
        fEnd = 1;
        return;
      }
      if (c === CR) {
        if (text.charCodeAt(i + 1) === LF) {
          fValue = parts === null ? text.slice(start, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
          i += 2;
          line += 1;
          fEnd = 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i));
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    fValue = parts === null ? text.slice(start, i) : (parts.push(text.slice(segStart, i)), parts.join(''));
    fEnd = 2;
  }

  while (i < n) {
    recLine = line;
    recRow = headerDone ? rows.length : null;
    const fields = [];
    let touched = false;
    let recordDone = false;

    while (!recordDone) {
      let value;
      let end;
      if (text.charCodeAt(i) === QUOTE) {
        touched = true;
        // Find the closing quote: the next quote that is not doubled.
        let j = i + 1;
        let close = -1;
        let escaped = false;
        while (j < n) {
          const q = text.indexOf('"', j);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === QUOTE) {
            escaped = true;
            j = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          readUnquoted();
          value = fValue;
          end = fEnd;
          if (value.length > 0) touched = true;
        } else {
          const cs = i + 1;
          const ce = close;
          const firstCR = text.indexOf('\r', cs);
          if (!escaped && (firstCR === -1 || firstCR >= ce)) {
            value = text.slice(cs, ce);
            let p = cs;
            for (;;) {
              const nl = text.indexOf('\n', p);
              if (nl === -1 || nl >= ce) break;
              line += 1;
              p = nl + 1;
            }
          } else {
            const parts = [];
            let last = cs;
            let k = cs;
            while (k < ce) {
              const c = text.charCodeAt(k);
              if (c === CR) {
                parts.push(text.slice(last, k), '\n');
                line += 1;
                k += text.charCodeAt(k + 1) === LF ? 2 : 1;
                last = k;
              } else if (c === QUOTE) {
                parts.push(text.slice(last, k), '"');
                k += 2;
                last = k;
              } else {
                if (c === LF) line += 1;
                k += 1;
              }
            }
            parts.push(text.slice(last, ce));
            value = parts.join('');
          }
          i = close + 1;
          // What follows the closing quote, up to the next comma or line
          // break, is appended as it stands; a lone CR there is dropped.
          const jStart = i;
          let jParts = null;
          let jSeg = i;
          let junk = '';
          end = 2;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === COMMA) {
              end = 0;
              break;
            }
            if (c === LF) {
              end = 1;
              break;
            }
            if (c === CR) {
              if (text.charCodeAt(i + 1) === LF) {
                end = 1;
                break;
              }
              errors.push({ code: 'stray_cr', line: recLine, row: recRow });
              if (jParts === null) jParts = [];
              jParts.push(text.slice(jSeg, i));
              i += 1;
              jSeg = i;
              continue;
            }
            i += 1;
          }
          junk = jParts === null ? text.slice(jStart, i) : (jParts.push(text.slice(jSeg, i)), jParts.join(''));
          if (junk.length > 0) {
            value += junk;
            errors.push({ code: 'quote_junk', line: recLine, row: recRow });
          }
          if (end === 0) {
            i += 1;
          } else if (end === 1) {
            i += text.charCodeAt(i) === CR ? 2 : 1;
            line += 1;
          }
        }
      } else {
        readUnquoted();
        value = fValue;
        end = fEnd;
        if (value.length > 0) touched = true;
      }
      fields.push(value);
      if (end === 0) {
        touched = true;
      } else {
        recordDone = true;
      }
    }

    if (!touched) continue;
    if (!headerDone) {
      columns = fields;
      width = fields.length;
      headerDone = true;
    } else if (width === -1) {
      width = fields.length;
      rows.push(fields);
    } else if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
      rows.push(fields);
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra });
      fields.length = width;
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  return { columns, rows, errors };
}
